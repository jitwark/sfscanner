import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '@hub/contracts';
import type { CorpusV2InputInventory, CorpusV2InputReceipt, CorpusV2InputReceiptStatus } from '../../scripts/lib/corpus-v2-input-inventory.js';
import { ADMITTED_V2_SCAN_IDENTITY, type V2RetainedScanEvidence } from '../scan/v2-corpus-adapter.js';
import { buildV2ScanEvidence, type V2RetainedVerdict, type V2ScanEvidenceRecord } from './v2-scan-evidence.js';
import {
  planV2EntryRegeneration,
  V2_ARTIFACT_GROUPS,
  type V2EntryRegenerationPlan,
  type V2RegenerationSubject,
} from './v2-regenerate-entry.js';

const BODY = new TextEncoder().encode('{"nodes":[],"connections":{}}');
const BODY_SHA = createHash('sha256').update(BODY).digest('hex');
const INVENTORY_SHA = 'b'.repeat(64);
const RESULT_DIGEST = 'd'.repeat(64);

const subject = (overrides: Partial<V2RegenerationSubject> = {}): V2RegenerationSubject =>
  ({ id: 'entry-1', readiness: { analysis: 'derived' }, ...overrides });

const retainedVerdict = (overrides: Partial<V2RetainedVerdict> = {}): V2RetainedVerdict =>
  ({ scannerVersion: 'scanner-beta-1', grade: 'MEDIUM', analysisStatus: 'COMPLETE', ...overrides });

const scan = (overrides: Partial<V2RetainedScanEvidence> = {}): V2RetainedScanEvidence => ({
  entryId: 'entry-1',
  rightsClass: 'link_only',
  ok: true,
  identity: ADMITTED_V2_SCAN_IDENTITY,
  bodySha256: BODY_SHA,
  resultDigest: RESULT_DIGEST,
  analysisStatus: 'COMPLETE',
  assessment: { grade: 'LOW', score: 75 },
  diagnosticCodes: [],
  findingIds: [],
  refusalCode: null,
  security: {
    grade: 'LOW',
    score: 75,
    counts: { critical: 0, high: 0, medium: 0, low: 1, info: 0 },
    findings: [],
    hardenedExtra: 0,
    scannerVersion: '2.0.0',
    profile: 'beta-default',
    analysisStatus: 'COMPLETE',
  },
  ...overrides,
});

const record = (overrides: Partial<V2ScanEvidenceRecord> = {}): V2ScanEvidenceRecord => ({
  schemaVersion: 'v2-scan-evidence-v1',
  entryId: 'entry-1',
  scanFreshness: 'CURRENT',
  rightsClass: 'link_only',
  inventorySha256: INVENTORY_SHA,
  scan: scan(),
  retainedVerdict: null,
  receiptReasonCode: null,
  ...overrides,
});

describe('state derivation from the retained record', () => {
  it('plans an admitted receipt on a derived-readiness row as CURRENT and regenerates every group', () => {
    const plan = planV2EntryRegeneration(subject(), record());

    expect(plan.state).toBe('CURRENT');
    expect(plan.stateReason).toBe('admitted-receipt');
    expect(plan.assessment).toEqual({
      label: 'CURRENT',
      grade: 'LOW',
      analysisStatus: 'COMPLETE',
      diagnosticCodes: [],
      producingIdentity: ADMITTED_V2_SCAN_IDENTITY.scannerVersion,
    });
    expect(plan.bodySha256).toBe(BODY_SHA);
    expect(plan.resultDigest).toBe(RESULT_DIGEST);
    expect(plan.rightsClass).toBe('link_only');
    expect(plan.inventorySha256).toBe(INVENTORY_SHA);
    expect(plan.artifacts.map((artifact) => artifact.group)).toEqual([...V2_ARTIFACT_GROUPS]);
    expect(plan.artifacts.every((artifact) => artifact.disposition === 'regenerated')).toBe(true);
  });

  it('plans the 221-shaped row historical: retained COMPLETE verdict, unscanned readiness, no receipt', () => {
    // The entry's own stamp is a claim, not evidence; the record's retained verdict is what the plan renders.
    const entry = {
      id: 'entry-1',
      readiness: { analysis: 'unscanned' as const },
      security: { grade: 'MEDIUM', score: 12, scannerVersion: 'scanner-beta-1', analysisStatus: 'COMPLETE', findings: [] },
    };
    const plan = planV2EntryRegeneration(entry, record({
      scanFreshness: 'HISTORICAL', scan: null, retainedVerdict: retainedVerdict(), receiptReasonCode: 'NO_SOURCE_BINDING',
    }));

    expect(plan.state).not.toBe('CURRENT');
    expect(plan.state).toBe('HISTORICAL');
    expect(plan.stateReason).toBe('retained-verdict');
    expect(plan.assessment?.label).not.toBe('CURRENT');
    expect(plan.assessment).toEqual({
      label: 'HISTORICAL',
      grade: 'MEDIUM',
      analysisStatus: 'COMPLETE',
      diagnosticCodes: [],
      producingIdentity: 'scanner-beta-1',
    });
    expect(plan.bodySha256).toBeNull();
    expect(plan.resultDigest).toBeNull();
    expect(plan.artifacts.every((artifact) => artifact.disposition === 'historical')).toBe(true);
  });

  it('refuses CURRENT while the committed readiness says nothing was read, and converges once it is derived', () => {
    const unscanned = planV2EntryRegeneration({ id: 'entry-1', readiness: { analysis: 'unscanned' } }, record());
    const absentReadiness = planV2EntryRegeneration({ id: 'entry-1' }, record());

    expect(unscanned.state).toBe('HISTORICAL');
    expect(unscanned.stateReason).toBe('readiness-contradiction');
    expect(unscanned.assessment?.label).toBe('HISTORICAL');
    expect(unscanned.bodySha256).toBeNull();
    expect(absentReadiness.state).toBe('HISTORICAL');
    expect(planV2EntryRegeneration(subject(), record()).state).toBe('CURRENT');
  });
});

describe('retired identities', () => {
  it('keeps c998701 as a historical producing identity and never as a current verdict', () => {
    const entry = { id: 'entry-1', readiness: { analysis: 'unscanned' as const }, security: { grade: 'HIGH', scannerVersion: 'c998701' } };
    const plan = planV2EntryRegeneration(entry, record({
      scanFreshness: 'HISTORICAL', scan: null, retainedVerdict: retainedVerdict({ scannerVersion: 'c998701', grade: 'HIGH' }),
    }));

    expect(plan.state).not.toBe('CURRENT');
    expect(plan.assessment?.label).toBe('HISTORICAL');
    expect(plan.assessment?.producingIdentity).toBe('c998701');
    expect(plan.assessment?.grade).toBe('HIGH');
  });

  it('refuses a stored CURRENT label whose receipt identity or row binding is not admitted', () => {
    const impostor = record({ scan: scan({ identity: { ...ADMITTED_V2_SCAN_IDENTITY, scannerVersion: 'c998701' } }) });
    const foreign = record({ scan: scan({ entryId: 'other-row' }) });
    const plans = [planV2EntryRegeneration(subject(), impostor), planV2EntryRegeneration(subject(), foreign)];

    expect(impostor.scanFreshness).toBe('CURRENT');
    expect(foreign.scanFreshness).toBe('CURRENT');
    expect(plans.map((plan) => plan.state)).toEqual(['HISTORICAL', 'HISTORICAL']);
    expect(plans.map((plan) => plan.stateReason)).toEqual(['unadmitted-receipt', 'unadmitted-receipt']);
    expect(plans[0].assessment?.label).toBe('HISTORICAL');
    expect(plans[0].assessment?.producingIdentity).toBe('c998701');
  });
});

describe('absent input stays absent', () => {
  it('plans a missing body UNSCANNED with no grade and no digest', () => {
    const plan = planV2EntryRegeneration({ id: 'entry-1', readiness: { analysis: 'unscanned' } },
      record({ scanFreshness: 'UNSCANNED', scan: null, receiptReasonCode: 'NO_SOURCE_BINDING' }));

    expect(plan.state).toBe('UNSCANNED');
    expect(plan.stateReason).toBe('no-receipt');
    expect(plan.receiptReasonCode).toBe('NO_SOURCE_BINDING');
    expect(plan.assessment).toBeNull();
    expect(plan.bodySha256).toBeNull();
    expect(plan.resultDigest).toBeNull();
    expect(JSON.stringify(plan)).not.toContain('"grade"');
    expect(plan.artifacts.every((artifact) => artifact.disposition === 'unavailable')).toBe(true);
  });

  it('plans an owner-ruled row SOURCE_UNAVAILABLE with its recorded reason and no verdict', () => {
    const plan = planV2EntryRegeneration({ id: 'entry-1' },
      record({ scanFreshness: 'SOURCE_UNAVAILABLE', scan: null, receiptReasonCode: 'RULING-1' }));

    expect(plan.state).toBe('SOURCE_UNAVAILABLE');
    expect(plan.stateReason).toBe('owner-ruling');
    expect(plan.receiptReasonCode).toBe('RULING-1');
    expect(plan.assessment).toBeNull();
    expect(plan.bodySha256).toBeNull();
    expect(JSON.stringify(plan)).not.toContain('"grade"');
  });

  it('keeps an INDETERMINATE analysis indeterminate, carrying its codes and a null grade', () => {
    const plan = planV2EntryRegeneration(subject(), record({
      scan: scan({ analysisStatus: 'INDETERMINATE', assessment: null, diagnosticCodes: ['DEPENDENCY_UNAVAILABLE', 'REQUIRED_CAPABILITY_FAILED'] }),
    }));

    expect(plan.state).toBe('CURRENT');
    expect(plan.assessment?.label).toBe('CURRENT');
    expect(plan.assessment?.grade).toBeNull();
    expect(plan.assessment?.analysisStatus).toBe('INDETERMINATE');
    expect(plan.assessment?.diagnosticCodes).toEqual(['DEPENDENCY_UNAVAILABLE', 'REQUIRED_CAPABILITY_FAILED']);
    expect(plan.resultDigest).toBe(RESULT_DIGEST);
  });
});

describe('purity and hygiene', () => {
  it('is frozen, clock-free and byte-identical across calls', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const first = planV2EntryRegeneration(subject(), record());
    vi.setSystemTime(1_700_000_000_000);
    const second = planV2EntryRegeneration(subject(), record());
    vi.useRealTimers();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.assessment)).toBe(true);
    expect(Object.isFrozen(first.artifacts)).toBe(true);
    expect(first.artifacts.every((artifact) => Object.isFrozen(artifact))).toBe(true);
  });

  it('carries no private path, body text or credential value', () => {
    const privatePath = 'D:\\projects\\private\\bodies\\secret-body.json';
    const credential = 'sk-live-abcdef123456';
    const entry = {
      id: 'leak-row',
      readiness: { analysis: 'derived' as const },
      source: { path: privatePath, permalink: 'https://github.com/acme/repo/blob/deadbeef/leak.json' },
      security: { grade: 'LOW', scannerVersion: 'c998701', findings: [{ id: 'f1', fix: `set password: ${credential}` }] },
    };
    const serialized = JSON.stringify(planV2EntryRegeneration(entry, record({ entryId: 'leak-row', scan: scan({ entryId: 'leak-row' }) })));

    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('secret-body');
    expect(serialized).not.toContain('deadbeef');
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain('nodes');
    expect(serialized).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(serialized).not.toMatch(/https?:\/\//);
  });

  it('refuses a mismatched binding and an unknown freshness value', () => {
    expect(() => planV2EntryRegeneration({ id: 'other-row' }, record())).toThrow(/entry/i);
    expect(() => planV2EntryRegeneration(subject(), { ...record(), scanFreshness: 'STALE' } as never)).toThrow(/freshness/i);
  });
});

describe("consumes the producer's record unchanged", () => {
  it('plans a CURRENT record built by buildV2ScanEvidence with the record digests', () => {
    const rows: readonly CorpusV2InputReceipt[] = [
      { entryId: 'entry-1', identityKind: 'OFFICIAL_TEMPLATE', status: 'AVAILABLE', bodySha256: BODY_SHA, byteLength: BODY.byteLength, sourceCommit: null, sourcePath: null, reasonCode: null },
      { entryId: 'entry-2', identityKind: null, status: 'SOURCE_UNAVAILABLE', bodySha256: null, byteLength: null, sourceCommit: null, sourcePath: null, reasonCode: 'RULING-1' },
    ];
    const counts: Record<CorpusV2InputReceiptStatus, number> = { AVAILABLE: 1, MISSING: 0, SOURCE_UNAVAILABLE: 1, UNPARSEABLE: 0, REJECTED: 0 };
    const inventory: CorpusV2InputInventory = { schemaVersion: 'corpus-v2-input-inventory-v1', counts, rows, inventorySha256: INVENTORY_SHA };
    const produced = buildV2ScanEvidence(inventory, { rightsClassOf: () => 'link_only' as const, readBytes: () => BODY });
    const plan = planV2EntryRegeneration(subject(), produced[0]!);

    expect(produced[0]!.scanFreshness).toBe('CURRENT');
    expect(plan.state).toBe('CURRENT');
    expect(plan.bodySha256).toBe(produced[0]!.scan?.bodySha256);
    expect(plan.resultDigest).toBe(produced[0]!.scan?.resultDigest);
    expect(produced[0]!.scan?.identity).toEqual(ADMITTED_V2_SCAN_IDENTITY);
  });

  it('accepts a committed Entry as its subject', () => {
    // The proof is the signature, not this line: the repo's own `tsc` typecheck accepts an `Entry`
    // here, so C2b-3 can pass real entries without a cast.
    const asEntry = (entry: Entry): V2EntryRegenerationPlan => planV2EntryRegeneration(entry, record({ entryId: entry.id }));

    expect(typeof asEntry).toBe('function');
  });
});
