import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CorpusV2InputInventory, CorpusV2InputReceipt } from '../../scripts/lib/corpus-v2-input-inventory.js';
import { ADMITTED_V2_SCAN_IDENTITY } from '../scan/v2-corpus-adapter.js';
import { V2_ARTIFACT_GROUPS, type V2RegenerationSubject } from './v2-regenerate-entry.js';
import { buildV2ScanEvidence } from './v2-scan-evidence.js';
import {
  runV2Regeneration,
  V2_REGENERATION_RUN_OPTION_KEYS,
  type V2RegenerationRun,
  type V2RegenerationRunOptions,
} from './run-v2-regeneration.js';

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const INVENTORY_SHA = 'a'.repeat(64);
const currentBody = new TextEncoder().encode('{"nodes":[],"connections":{}}');

const row = (entryId: string, overrides: Partial<CorpusV2InputReceipt> = {}): CorpusV2InputReceipt => ({
  entryId,
  identityKind: null,
  status: 'MISSING',
  bodySha256: null,
  byteLength: null,
  sourceCommit: null,
  sourcePath: null,
  reasonCode: null,
  ...overrides,
});

function inventory(rows: readonly CorpusV2InputReceipt[], inventorySha256 = INVENTORY_SHA): CorpusV2InputInventory {
  const counts = { AVAILABLE: 0, MISSING: 0, SOURCE_UNAVAILABLE: 0, UNPARSEABLE: 0, REJECTED: 0 };
  for (const item of rows) counts[item.status] += 1;
  return { schemaVersion: 'corpus-v2-input-inventory-v1', counts, rows, inventorySha256 };
}

/** One authentic body, one retained stamp, one retired identity, one never-scanned row, one ruling. */
const ROWS: readonly CorpusV2InputReceipt[] = [
  row('entry-current', { status: 'AVAILABLE', identityKind: 'OFFICIAL_TEMPLATE', bodySha256: sha256(currentBody), byteLength: currentBody.byteLength }),
  row('entry-stamped', { reasonCode: 'NO_SOURCE_BINDING' }),
  row('entry-legacy', { reasonCode: 'NO_SOURCE_BINDING' }),
  row('entry-unscanned', { reasonCode: 'NO_SOURCE_BINDING' }),
  row('entry-ruled', { status: 'SOURCE_UNAVAILABLE', identityKind: 'GITHUB', reasonCode: 'RULING-1', sourceCommit: 'dcb67e5b' }),
];

const VERDICTS = {
  'entry-stamped': { scannerVersion: 'scanner-beta-1', grade: 'MEDIUM' as const, analysisStatus: 'COMPLETE' as const },
  'entry-legacy': { scannerVersion: 'c998701', grade: 'HIGH' as const, analysisStatus: 'COMPLETE' as const },
};
const readIds: string[] = [];
const OPTIONS = {
  rightsClassOf: () => 'link_only' as const,
  readBytes: (entryId: string) => {
    readIds.push(entryId);
    return entryId === 'entry-current' ? currentBody : undefined;
  },
  retainedVerdictOf: (entryId: string) => VERDICTS[entryId as keyof typeof VERDICTS],
};

const SUBJECTS: readonly V2RegenerationSubject[] = [
  { id: 'entry-current', readiness: { analysis: 'derived' } },
  { id: 'entry-stamped' },
  { id: 'entry-legacy' },
  { id: 'entry-unscanned' },
  { id: 'entry-ruled' },
];

const records = (inventorySha256?: string) => buildV2ScanEvidence(inventory(ROWS, inventorySha256), OPTIONS);

const run = (overrides: Partial<V2RegenerationRunOptions> = {}): V2RegenerationRun => runV2Regeneration({
  inventory: inventory(ROWS),
  subjects: SUBJECTS,
  records: records(),
  ...overrides,
});

const planFor = (result: V2RegenerationRun, entryId: string) => result.plans.find((plan) => plan.entryId === entryId);

describe('v2 regeneration run', () => {
  it('plans an authentic current body as CURRENT with its digests and regenerated artifacts', () => {
    const plan = planFor(run(), 'entry-current');

    expect(plan).toMatchObject({
      schemaVersion: 'v2-entry-regeneration-plan-v1',
      state: 'CURRENT',
      stateReason: 'admitted-receipt',
      rightsClass: 'link_only',
      inventorySha256: INVENTORY_SHA,
      bodySha256: sha256(currentBody),
    });
    expect(plan?.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan?.artifacts.map((artifact) => artifact.group)).toEqual([...V2_ARTIFACT_GROUPS]);
    expect(plan?.artifacts.every((artifact) => artifact.disposition === 'regenerated')).toBe(true);
    expect(plan?.assessment).toMatchObject({
      label: 'CURRENT',
      producingIdentity: ADMITTED_V2_SCAN_IDENTITY.scannerVersion,
    });
  });

  it('never promotes a retained stamp: a row with no body stays UNSCANNED or HISTORICAL', () => {
    const stamped = planFor(run(), 'entry-stamped');
    const unscanned = planFor(run(), 'entry-unscanned');

    expect(stamped).toMatchObject({
      state: 'HISTORICAL',
      stateReason: 'retained-verdict',
      bodySha256: null,
      resultDigest: null,
      assessment: { label: 'HISTORICAL', grade: 'MEDIUM', producingIdentity: 'scanner-beta-1' },
    });
    expect(unscanned).toMatchObject({ state: 'UNSCANNED', stateReason: 'no-receipt', assessment: null, bodySha256: null });
    expect(JSON.stringify(unscanned)).not.toContain('"grade"');
  });

  it('keeps a ruled row unavailable with its recorded reason and reads no bytes for it', () => {
    const ruled = planFor(run(), 'entry-ruled');

    expect(ruled).toMatchObject({
      state: 'SOURCE_UNAVAILABLE',
      stateReason: 'owner-ruling',
      receiptReasonCode: 'RULING-1',
      assessment: null,
    });
    expect(ruled?.artifacts.every((artifact) => artifact.disposition === 'unavailable')).toBe(true);
    expect(readIds).not.toContain('entry-ruled');
  });

  it('never counts a retired identity as a current verdict', () => {
    const result = run();
    const legacy = planFor(result, 'entry-legacy');

    expect(legacy).toMatchObject({
      state: 'HISTORICAL',
      stateReason: 'retained-verdict',
      assessment: { label: 'HISTORICAL', producingIdentity: 'c998701' },
    });
    expect(result.currentVerdicts).toEqual({
      count: 1,
      producingIdentities: [ADMITTED_V2_SCAN_IDENTITY.scannerVersion],
    });
  });

  it('does not plan CURRENT while the committed readiness still says no body was read', () => {
    const subjects = SUBJECTS.map((subject) => (subject.id === 'entry-current' ? { id: subject.id } : subject));
    const plan = planFor(run({ subjects }), 'entry-current');

    expect(plan).toMatchObject({ state: 'HISTORICAL', stateReason: 'readiness-contradiction', bodySha256: null, resultDigest: null });
  });

  it('counts the census from the plans: five rows, four states, six reasons, six artifact groups', () => {
    const result = run();

    expect(result).toMatchObject({ schemaVersion: 'v2-regeneration-run-v1', inventorySha256: INVENTORY_SHA, entryCount: 5 });
    expect(result.states).toEqual({ CURRENT: 1, NO_RESULT: 0, HISTORICAL: 2, UNSCANNED: 1, SOURCE_UNAVAILABLE: 1 });
    expect(Object.keys(result.reasons)).toEqual([
      'admitted-receipt', 'readiness-contradiction', 'unadmitted-receipt', 'no-result', 'retained-verdict', 'no-receipt', 'owner-ruling',
    ]);
    expect(Object.values(result.reasons).reduce((total, value) => total + value, 0)).toBe(5);
    expect(result.artifactGroups.map((group) => group.group)).toEqual([...V2_ARTIFACT_GROUPS]);
    for (const group of result.artifactGroups) {
      expect(group.regenerated + group.historical + group.unavailable).toBe(5);
    }
    expect(result.plans.map((plan) => plan.entryId)).toEqual([...ROWS.map((item) => item.entryId)].sort());
  });

  it('refuses records derived from another inventory binding', () => {
    expect(() => run({ records: records('b'.repeat(64)) })).toThrow(/another inventory/);
  });

  it('refuses a retained record that matches no inventory row', () => {
    expect(() => run({ records: records().slice(1) })).toThrow(/4 retained record\(s\) for 5 inventory row\(s\)/);
  });

  it('refuses an inventory row that has no retained record', () => {
    const renamed = records().map((record) => (
      record.entryId === 'entry-unscanned' ? { ...record, entryId: 'entry-typo' } : record
    ));

    expect(() => run({ records: renamed })).toThrow(/no retained record for inventory row entry-unscanned/);
  });

  it('refuses a duplicated retained record and an inventory row with no committed subject', () => {
    expect(() => run({ records: [...records(), ...records().slice(0, 1)] })).toThrow(/duplicate retained record for entry entry-current/);
    expect(() => run({ subjects: [] })).toThrow(/no committed subject for inventory row entry-current/);
  });

  it('refuses an unknown option and a non-inventory input', () => {
    const unknown = { ...{ inventory: inventory(ROWS), subjects: SUBJECTS, records: records() }, limits: {} };
    const otherVersion = { inventory: { schemaVersion: 'corpus-v2-input-inventory-v2' }, subjects: SUBJECTS, records: records() };

    expect([...V2_REGENERATION_RUN_OPTION_KEYS]).toEqual(['inventory', 'records', 'subjects']);
    expect(() => runV2Regeneration(unknown as unknown as V2RegenerationRunOptions)).toThrow(/unknown option\(s\): limits/);
    expect(() => runV2Regeneration(otherVersion as unknown as V2RegenerationRunOptions))
      .toThrow(/unsupported inventory schema version/);
  });

  it('is order-independent and byte-identical for the same inputs', () => {
    const forward = run();
    const shuffled = run({ subjects: [...SUBJECTS].reverse(), records: [...records()].reverse() });

    expect(shuffled).toEqual(forward);
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(forward));
  });

  it('freezes the run, its counts and its plans', () => {
    const result = run();

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.states)).toBe(true);
    expect(Object.isFrozen(result.artifactGroups)).toBe(true);
    expect(Object.isFrozen(result.artifactGroups[0])).toBe(true);
    expect(Object.isFrozen(result.plans)).toBe(true);
    expect(result.plans.every((plan) => Object.isFrozen(plan))).toBe(true);
  });
});
