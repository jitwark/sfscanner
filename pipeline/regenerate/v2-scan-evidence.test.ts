import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ScanWorkflowV2Result } from '@hub/scanner-core/v2';
import type { CorpusV2InputInventory, CorpusV2InputReceipt, CorpusV2InputReceiptStatus } from '../../scripts/lib/corpus-v2-input-inventory.js';
import { ADMITTED_V2_SCAN_IDENTITY } from '../scan/v2-corpus-adapter.js';
import {
  buildV2ScanEvidence,
  classifyV2ScanFreshness,
  V2_SCAN_EVIDENCE_OPTION_KEYS,
  type V2RetainedVerdict,
  type V2ScanEvidenceRecord,
} from './v2-scan-evidence.js';

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const body = (extra = '') => new TextEncoder().encode(`{"nodes":[],"connections":{${extra}}}`);
const INVENTORY_SHA = 'a'.repeat(64);

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
  const counts: Record<CorpusV2InputReceiptStatus, number> = { AVAILABLE: 0, MISSING: 0, SOURCE_UNAVAILABLE: 0, UNPARSEABLE: 0, REJECTED: 0 };
  for (const item of rows) counts[item.status] += 1;
  return { schemaVersion: 'corpus-v2-input-inventory-v1', counts, rows, inventorySha256 };
}

const recordFor = (records: readonly V2ScanEvidenceRecord[], entryId: string) => records.find((record) => record.entryId === entryId);

/** The five-diagnostic shape a required-capability failure produces on the live engine (see report D-1 note). */
const indeterminateScan = (): ScanWorkflowV2Result => ({
  ok: true,
  result: {
    engine: { id: 'secureflow-scanner', version: ADMITTED_V2_SCAN_IDENTITY.scannerVersion, buildDigest: ADMITTED_V2_SCAN_IDENTITY.engineBuildDigest },
    profile: { id: ADMITTED_V2_SCAN_IDENTITY.profileId, version: ADMITTED_V2_SCAN_IDENTITY.profileVersion },
    ruleset: { id: 'scanner-core-builtins', version: '2.0.0', digest: ADMITTED_V2_SCAN_IDENTITY.rulesetDigest, signatureStatus: 'VERIFIED' },
    semantics: { id: 'builtin-semantics', version: '2.0.0', digest: ADMITTED_V2_SCAN_IDENTITY.semanticsDigest },
    limits: { schemaVersion: 'scanner-limits-v2', digest: ADMITTED_V2_SCAN_IDENTITY.limitsDigest, usage: [] },
    analysis: {
      status: 'INDETERMINATE',
      capabilities: [{ id: 'source-normalization', status: 'FAILED', omitted: 1 }],
      diagnostics: [
        { code: 'REQUIRED_CAPABILITY_FAILED', category: 'POLICY', capabilityId: 'source-normalization', aggregateEffect: 'INDETERMINATE', assessmentEligible: false },
        { code: 'DEPENDENCY_UNAVAILABLE', category: 'POLICY', capabilityId: 'assessment', aggregateEffect: 'INDETERMINATE', assessmentEligible: false },
      ],
    },
    findings: [],
    assessment: null,
  },
} as unknown as ScanWorkflowV2Result);

const currentBody = body();
const threeRows: readonly CorpusV2InputReceipt[] = [
  row('entry-current', { status: 'AVAILABLE', identityKind: 'OFFICIAL_TEMPLATE', bodySha256: sha256(currentBody), byteLength: currentBody.byteLength }),
  row('entry-missing', { status: 'MISSING', reasonCode: 'NO_SOURCE_BINDING' }),
  row('entry-ruled', { status: 'SOURCE_UNAVAILABLE', identityKind: 'GITHUB', reasonCode: 'RULING-1', sourceCommit: 'dcb67e5b' }),
];
const options = { rightsClassOf: () => 'link_only' as const, readBytes: (entryId: string) => (entryId === 'entry-current' ? currentBody : undefined) };
const threeRecords = () => buildV2ScanEvidence(inventory(threeRows), options);

describe('three real inventory entries', () => {
  it('an authentic current body yields the v2 identity plus body and result digests', () => {
    const record = recordFor(threeRecords(), 'entry-current');

    expect(record?.scanFreshness).toBe('CURRENT');
    expect(record?.inventorySha256).toBe(INVENTORY_SHA);
    expect(record?.rightsClass).toBe('link_only');
    expect(record?.scan?.identity).toEqual(ADMITTED_V2_SCAN_IDENTITY);
    expect(record?.scan?.bodySha256).toBe(sha256(currentBody));
    expect(record?.scan?.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.scan?.analysisStatus).toBe('COMPLETE');
    expect(record?.scan?.assessment).toEqual({ grade: 'LOW', score: expect.any(Number) });
  });

  it('a missing body is UNSCANNED with a null assessment', () => {
    const record = recordFor(threeRecords(), 'entry-missing');

    expect(record?.scanFreshness).toBe('UNSCANNED');
    expect(record?.scan).toBeNull();
    expect(record?.retainedVerdict).toBeNull();
    expect(record?.receiptReasonCode).toBe('NO_SOURCE_BINDING');
  });

  it('a deleted source is SOURCE_UNAVAILABLE with no verdict', () => {
    const record = recordFor(threeRecords(), 'entry-ruled');

    expect(record?.scanFreshness).toBe('SOURCE_UNAVAILABLE');
    expect(record?.scan).toBeNull();
    expect(record?.retainedVerdict).toBeNull();
    expect(record?.receiptReasonCode).toBe('RULING-1');
  });

  it('keeps a ruled row SOURCE_UNAVAILABLE when a later cache offers bytes and a grade', () => {
    const cached = body();
    const readBytes = vi.fn(() => cached);
    const [record] = buildV2ScanEvidence(
      inventory([row('entry-ruled', { status: 'SOURCE_UNAVAILABLE', reasonCode: 'RULING-1', bodySha256: sha256(cached) })]),
      { ...options, readBytes, retainedVerdictOf: () => ({ scannerVersion: 'scanner-beta-1', grade: 'MEDIUM', analysisStatus: 'COMPLETE' }) },
    );

    expect(readBytes).not.toHaveBeenCalled();
    expect(record?.scanFreshness).toBe('SOURCE_UNAVAILABLE');
    expect(record?.scan).toBeNull();
    expect(record?.retainedVerdict).toBeNull();
  });
});

describe('inventory shapes', () => {
  it('classifies a 3-row inventory and a differently shaped 5-row inventory without fixed totals', () => {
    const fiveRows: readonly CorpusV2InputReceipt[] = [
      row('entry-b-unparseable', { status: 'UNPARSEABLE', reasonCode: 'UNPARSEABLE_BODY' }),
      row('entry-c-rejected', { status: 'REJECTED', reasonCode: 'SOURCE_IDENTITY_MISMATCH' }),
      row('entry-a-current', { status: 'AVAILABLE', bodySha256: sha256(currentBody), byteLength: currentBody.byteLength }),
      row('entry-d-ruled', { status: 'SOURCE_UNAVAILABLE', reasonCode: 'RULING-1' }),
      row('entry-e-missing', { status: 'MISSING', reasonCode: 'NO_SOURCE_BINDING' }),
    ];
    const five = buildV2ScanEvidence(inventory(fiveRows, 'b'.repeat(64)), {
      rightsClassOf: () => 'redistributable' as const,
      readBytes: (entryId: string) => (entryId === 'entry-a-current' ? currentBody : undefined),
    });

    expect(five).toHaveLength(5);
    expect(five.map((record) => record.entryId)).toEqual([
      'entry-a-current', 'entry-b-unparseable', 'entry-c-rejected', 'entry-d-ruled', 'entry-e-missing',
    ]);
    expect(five.map((record) => record.scanFreshness)).toEqual([
      'CURRENT', 'UNSCANNED', 'UNSCANNED', 'SOURCE_UNAVAILABLE', 'UNSCANNED',
    ]);
    expect(threeRecords()).toHaveLength(3);
    expect(recordFor(threeRecords(), 'entry-missing')).toEqual(recordFor(buildV2ScanEvidence(inventory([threeRows[1]!]), options), 'entry-missing'));
  });
});

describe('freshness invalidation', () => {
  it('invalidates CURRENT when the body or the catalogue inventory digest changes', () => {
    const record = recordFor(threeRecords(), 'entry-current')!;
    const changedBody = row('entry-current', { status: 'AVAILABLE', bodySha256: sha256(body('"x":1')), byteLength: 20 });

    expect(classifyV2ScanFreshness(record, threeRows[0]!, INVENTORY_SHA)).toBe('CURRENT');
    // A changed body, another inventory or a missing input is an impostor binding, refused outright.
    expect(() => classifyV2ScanFreshness(record, changedBody, INVENTORY_SHA)).toThrow(/not the inventory/);
    expect(() => classifyV2ScanFreshness(record, threeRows[0]!, 'f'.repeat(64))).toThrow(/another entry or inventory/);
    expect(() => classifyV2ScanFreshness(record, row('entry-current', { status: 'MISSING' }), INVENTORY_SHA)).toThrow(/not the inventory/);
  });

  it('cannot be relabelled CURRENT by any option the caller can pass', () => {
    expect([...V2_SCAN_EVIDENCE_OPTION_KEYS]).toEqual(['limits', 'readBytes', 'retainedVerdictOf', 'rightsClassOf', 'scan']);
    expect(() => buildV2ScanEvidence(inventory(threeRows), { ...options, assumeCurrent: true, trusted: true } as never)).toThrow(/option/i);

    const stale = recordFor(threeRecords(), 'entry-current')!;
    const relabelled = { ...stale, scanFreshness: 'CURRENT' } as V2ScanEvidenceRecord;
    const changedBody = row('entry-current', { status: 'AVAILABLE', bodySha256: sha256(body('"x":1')) });
    expect(() => classifyV2ScanFreshness(relabelled, changedBody, INVENTORY_SHA)).toThrow(/not the inventory/);
  });
});

describe('retained verdicts that are not current', () => {
  it('never carries c998701 as a current engine identity', () => {
    const retained: V2RetainedVerdict = { scannerVersion: 'c998701', grade: 'MEDIUM', analysisStatus: null };
    const legacy = inventory([row('legacy-row', { status: 'MISSING', reasonCode: 'NO_SOURCE_BINDING' })]);
    const [record] = buildV2ScanEvidence(legacy, { ...options, retainedVerdictOf: () => retained });

    expect(record?.scanFreshness).toBe('HISTORICAL');
    expect(record?.scan).toBeNull();
    expect(record?.retainedVerdict).toEqual(retained);

    const impostor = {
      ...recordFor(threeRecords(), 'entry-current')!,
      scanFreshness: 'CURRENT',
      scan: { ...recordFor(threeRecords(), 'entry-current')!.scan!, identity: { ...ADMITTED_V2_SCAN_IDENTITY, scannerVersion: 'c998701' } },
    } as V2ScanEvidenceRecord;

    expect(impostor.scanFreshness).toBe('CURRENT');
    expect(() => classifyV2ScanFreshness(impostor, threeRows[0]!, INVENTORY_SHA)).toThrow(/unadmitted identity/);
  });

  it('classifies a current-identity refusal as NO_RESULT, never CURRENT or HISTORICAL', () => {
    const current = recordFor(threeRecords(), 'entry-current')!;
    const refused = {
      ...current,
      scanFreshness: 'CURRENT' as const,
      scan: { ...current.scan!, ok: false as const, resultDigest: null, analysisStatus: 'INDETERMINATE' as const, assessment: null, diagnosticCodes: [] },
    };
    expect(classifyV2ScanFreshness(refused, threeRows[0]!, INVENTORY_SHA)).toBe('NO_RESULT');
  });

  it('drops a retained verdict once the row is CURRENT', () => {
    const [record] = buildV2ScanEvidence(inventory([threeRows[0]!]), {
      ...options,
      retainedVerdictOf: () => ({ scannerVersion: 'scanner-beta-1', grade: 'MEDIUM', analysisStatus: 'COMPLETE' }),
    });

    expect(record?.scanFreshness).toBe('CURRENT');
    expect(record?.retainedVerdict).toBeNull();
  });
});

describe('indeterminate results', () => {
  it('records an INDETERMINATE result as its status with diagnostic codes and a null assessment', () => {
    const [record] = buildV2ScanEvidence(inventory([threeRows[0]!]), { ...options, scan: indeterminateScan });

    expect(record?.scanFreshness).toBe('CURRENT');
    expect(record?.scan?.analysisStatus).toBe('INDETERMINATE');
    expect(record?.scan?.assessment).toBeNull();
    expect(record?.scan?.diagnosticCodes).toEqual(['DEPENDENCY_UNAVAILABLE', 'REQUIRED_CAPABILITY_FAILED']);
    expect(record?.scan?.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.scan?.security.grade).toBe('UNKNOWN');
    expect(record?.scan?.security.analysisStatus).toBe('INDETERMINATE');
  });
});

describe('output hygiene', () => {
  it('carries no private path, credential value, body pointer or borrowed provenance', () => {
    const privatePath = 'D:\\projects\\private\\bodies\\secret-body.json';
    const credentialBody = body('"password":"hunter2","apiKey":"sk-live-abcdef123456"');
    const serialized = JSON.stringify(buildV2ScanEvidence(
      inventory([
        row('leak-available', { status: 'AVAILABLE', bodySha256: sha256(credentialBody), byteLength: credentialBody.byteLength, sourcePath: privatePath, sourceCommit: 'deadbeefcafe' }),
        row('leak-ruled', { status: 'SOURCE_UNAVAILABLE', reasonCode: 'RULING-1', sourcePath: privatePath, sourceCommit: 'deadbeefcafe' }),
        row('leak-missing', { status: 'MISSING', reasonCode: 'NO_SOURCE_BINDING', sourcePath: privatePath }),
      ]),
      { ...options, readBytes: (entryId: string) => (entryId === 'leak-available' ? credentialBody : undefined) },
    ));

    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('secret-body');
    expect(serialized).not.toContain('deadbeefcafe');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('sk-live');
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(serialized).not.toContain('localPath');
  });

  it('is deterministic, canonically sorted and duplicate-free', () => {
    const reversed = buildV2ScanEvidence(inventory([...threeRows].reverse()), options);

    expect(reversed).toEqual(threeRecords());
    expect(threeRecords().map((record) => record.entryId)).toEqual(['entry-current', 'entry-missing', 'entry-ruled']);
    expect(Object.isFrozen(threeRecords())).toBe(true);
    expect(Object.isFrozen(threeRecords()[0])).toBe(true);
    expect(() => buildV2ScanEvidence(inventory([...threeRows, threeRows[0]!]), options)).toThrow(/duplicate/i);
    expect(() => buildV2ScanEvidence(inventory(threeRows, 'not-a-digest'), options)).toThrow(/inventory/i);
  });
});
