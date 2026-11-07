import crypto from 'node:crypto';
import { formalMeasurementContext } from './formal-coverage-binding.js';
import { describe, expect, it } from 'vitest';
import { buildFormalNodeCoverage, coverageRate, projectFormalNodeSample, sourceBindingsDigest, type FormalCoverageBinding } from './formal-node-coverage.js';
import { BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2, ENGINE_BUILD_DIGEST_V2, SEMANTIC_CATALOGUE_DIGEST_V2 } from '../../packages/scanner-core/src/v2/admitted-registry.js';
import type { CorpusV2InputInventory, CorpusV2InputReceipt } from '../../scripts/lib/corpus-v2-input-inventory.js';

const hash = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const encode = (text: string) => new TextEncoder().encode(text);
const gmail = (parameters: unknown = { operation: 'send' }, extra: Record<string, unknown> = {}) => ({
  type: 'n8n-nodes-base.gmail', typeVersion: 2.2, parameters, ...extra,
});
const body = (nodes: readonly unknown[]) => encode(JSON.stringify({ nodes, connections: {} }));
function fixture(documents: readonly (readonly [string, Uint8Array | null, CorpusV2InputReceipt['status']?])[]) {
  const rows: CorpusV2InputReceipt[] = documents.map(([entryId, bytes, status]) => ({ entryId, identityKind: 'OFFICIAL_TEMPLATE',
    status: status ?? (bytes ? 'AVAILABLE' : 'MISSING'), bodySha256: bytes ? hash(bytes) : null,
    byteLength: bytes?.length ?? null, sourceCommit: null, sourcePath: null, reasonCode: null }));
  const counts = { AVAILABLE: 0, MISSING: 0, SOURCE_UNAVAILABLE: 0, UNPARSEABLE: 0, REJECTED: 0 };
  for (const row of rows) counts[row.status] += 1;
  const inventory: CorpusV2InputInventory = { schemaVersion: 'corpus-v2-input-inventory-v1', inventorySha256: 'a'.repeat(64), rows, counts };
  const executionContext = formalMeasurementContext();
  const binding: FormalCoverageBinding = {
    executionContext, measurementContextSha256: crypto.createHash('sha256').update(JSON.stringify(executionContext)).digest('hex'),
    inventorySha256: inventory.inventorySha256, inventoryFileSha256: 'b'.repeat(64), bodyMapSha256: 'c'.repeat(64),
    scopedSemanticsDigest: BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2.digest, legacySemanticsDigest: SEMANTIC_CATALOGUE_DIGEST_V2,
    engineBuildDigest: ENGINE_BUILD_DIGEST_V2, sourceReceiptSha256: BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2.sourceReceiptSha256,
    producerSourceSha256: 'd'.repeat(64), sourceBindingsSha256: sourceBindingsDigest(inventory),
  };
  const samples = documents.flatMap(([entryId, bytes]) => bytes ? [projectFormalNodeSample(entryId, bytes)] : []);
  return { inventory, binding, samples, result: () => buildFormalNodeCoverage(inventory, samples, binding) };
}

describe('private formal reviewed coverage', () => {
  it('retains maxNodes+1 as typed incomplete measurement without a false reduced-cohort target', () => {
    const overLimit = body(Array.from({ length: 5001 }, () => ({ type: 'n8n-nodes-base.future', typeVersion: 1 })));
    const f = fixture([['known', body([gmail()])], ['limited', overLimit]]);
    expect(f.samples[1]).toMatchObject({ exclusion: null, executableInstances: null,
      reviewedExecutableInstances: null, resourceRefusal: { stage: 'NORMALIZATION', code: 'WORKFLOW_TOO_COMPLEX', cause: 'NODE_LIMIT' } });
    const report = f.result();
    expect(report).toMatchObject({ status: 'INCOMPLETE', countsScope: 'EXAMINED_COHORT_ONLY',
      counts: { cohortWorkflows: 1, reviewedExecutableInstances: 1 },
      wholeCorpus: { inventoryRows: 2, formalCohort: 1, measurementUnknown: 1, malformed: 0 } });
    expect(report.rates.reviewedExecutableInstances).toEqual({ numerator: null, denominator: null, ratio: null, meets95Percent: false });
    expect(report.rates.fullyModelledWorkflows.meets90Percent).toBe(false);
    expect(report.unknownMeasurements).toEqual([{ entryId: 'limited', stage: 'NORMALIZATION', code: 'WORKFLOW_TOO_COMPLEX', cause: 'NODE_LIMIT' }]);
    expect(report.exclusions).toEqual([]);
  });

  it.each(['SOURCE_IDENTITY_MISMATCH', 'PATH_OUTSIDE_APPROVED_ROOT', 'DIGEST_MISMATCH'])
  ('preserves rejected input reason %s without calling it malformed', (reasonCode) => {
    const f = fixture([['rejected', null, 'REJECTED']]);
    const inventory = { ...f.inventory, rows: f.inventory.rows.map((row) => ({ ...row, reasonCode })) };
    const binding = { ...f.binding, sourceBindingsSha256: sourceBindingsDigest(inventory) };
    const report = buildFormalNodeCoverage(inventory, [], binding);
    expect(report.wholeCorpus).toMatchObject({ rejected: 1, malformed: 0, formalCohort: 0 });
    expect(report.exclusions).toEqual([{ entryId: 'rejected', reason: 'REJECTED_INPUT', reasonCode }]);
  });

  it.each([
    ['exact', gmail({ resource: 'message', operation: 'send' }), 1], ['default', gmail(), 1],
    ['sendAndWait', gmail({ operation: 'sendAndWait' }), 0], ['unknown operation', gmail({ operation: 'future' }), 0],
    ['other resource', gmail({ resource: 'label', operation: 'send' }), 0], ['dynamic', gmail({ operation: '={{$json.op}}' }), 0],
    ['unsupported version', gmail({ operation: 'send' }, { typeVersion: 2.1 }), 0],
    ['nested selector', gmail({ nested: { operation: 'send' } }), 0], ['legacy action', gmail({ action: 'send' }), 0],
    ['malformed parameters', gmail(null), 0], ['missing version', gmail({}, { typeVersion: undefined }), 0],
    ['unknown official', { type: 'n8n-nodes-base.future', typeVersion: 1 }, 0],
  ])('%s uses actual scoped resolution, never legacy CATALOGUE origin', (_label, node, reviewed) => {
    const result = fixture([['a', body([node])]]).result();
    expect(result.counts.executableInstances).toBe(1);
    expect(result.counts.reviewedExecutableInstances).toBe(reviewed);
    expect(result.counts.fullyModelledWorkflows).toBe(reviewed);
  });

  it('retains duplicate/unreadable selectors and invalid versions as uncovered executable instances', () => {
    const duplicate = encode('{"nodes":[{"type":"n8n-nodes-base.gmail","typeVersion":2.2,"parameters":{"operation":"send","operation":"get"}}],"connections":{}}');
    const result = fixture([['duplicate', duplicate], ['invalid-version', body([gmail(undefined, { typeVersion: 'unknown' })])]]).result();
    expect(result.counts).toMatchObject({ executableInstances: 2, reviewedExecutableInstances: 0, fullyModelledWorkflows: 0 });
  });

  it('requires all executable instances for workflow completion and counts independent whole-corpus states', () => {
    const f = fixture([
      ['known', body([gmail()])], ['mixed-official', body([gmail(), { type: 'n8n-nodes-base.future', typeVersion: 1 }])],
      ['community', body([gmail(), { type: 'custom.package', typeVersion: 1 }])],
      ['missing', null], ['unavailable', null, 'SOURCE_UNAVAILABLE'], ['malformed', encode('bad'), 'UNPARSEABLE'],
      ['empty', body([])], ['bad-identity', body([{ type: 'invalid type', typeVersion: 1 }])],
    ]);
    const result = f.result();
    expect(result.counts).toMatchObject({ cohortWorkflows: 2, executableInstances: 3, reviewedExecutableInstances: 2, fullyModelledWorkflows: 1 });
    expect(result.wholeCorpus).toMatchObject({ inventoryRows: 8, availableBodies: 5, missing: 1, sourceUnavailable: 1, malformed: 1, communityPackage: 1, invalidNodeIdentity: 1, noExecutableNode: 1, formalCohort: 2 });
    expect(result.exclusions.map((row) => row.reason).sort()).toEqual(['COMMUNITY_PACKAGE', 'INVALID_NODE_IDENTITY', 'MALFORMED', 'MISSING', 'NO_EXECUTABLE_NODE', 'SOURCE_UNAVAILABLE'].sort());
    expect(JSON.stringify(f.result())).toBe(JSON.stringify(result));
    expect(buildFormalNodeCoverage({ ...f.inventory, rows: [...f.inventory.rows].reverse() }, [...f.samples].reverse(), f.binding)).toEqual(result);
  });

  it('does not exclude a workflow for an observed disabled community node; ambiguous disabled state stays executable', () => {
    const good = body([gmail(), { type: 'custom.package', typeVersion: 1, disabled: true, parameters: null }]);
    const uncertain = encode('{"nodes":[{"type":"n8n-nodes-base.gmail","typeVersion":2.2,"parameters":{"operation":"send"}},{"type":"custom.package","disabled":false,"disabled":true}],"connections":{}}');
    const result = fixture([['good', good], ['uncertain', uncertain]]).result();
    expect(result.counts).toMatchObject({ cohortWorkflows: 1, executableInstances: 1, reviewedExecutableInstances: 1, fullyModelledWorkflows: 1 });
    expect(result.exclusions).toEqual([{ entryId: 'uncertain', reason: 'COMMUNITY_PACKAGE' }]);
    expect(result.wholeCorpus.disabledNodes).toBe(1);
  });

  it('excludes only the exact source-backed inert version; unsupported notes and NoOp stay executable/uncovered', () => {
    const result = fixture([['inert', body([gmail(), { type: 'n8n-nodes-base.stickyNote', typeVersion: 1 }])],
      ['unsupported', body([{ type: 'n8n-nodes-base.stickyNote', typeVersion: 2 }, { type: 'n8n-nodes-base.noOp', typeVersion: 1 }])]]).result();
    expect(result.counts).toMatchObject({ reviewedInertNodes: 1, executableInstances: 3, reviewedExecutableInstances: 1, fullyModelledWorkflows: 1 });
    const empty = fixture([['empty', body([])], ['note-only', body([{ type: 'n8n-nodes-base.stickyNote', typeVersion: 1 }])]]).result();
    expect(empty.rates.reviewedExecutableInstances.ratio).toBeNull();
    expect(empty.rates.fullyModelledWorkflows.ratio).toBeNull();
    expect(empty.rates.fullyModelledWorkflows.meets90Percent).toBe(false);
    expect(empty.exclusions.every((row) => row.reason === 'NO_EXECUTABLE_NODE')).toBe(true);
  });

  it('does not count duplicate node identities or malformed source as a clean workflow', () => {
    const result = fixture([['duplicate', body([gmail({}, { id: 'same' }), gmail({}, { id: 'same' })])],
      ['invalid-source', encode('{"nodes":[]}')]]).result();
    expect(result.exclusions).toEqual([{ entryId: 'duplicate', reason: 'INVALID_NODE_IDENTITY' }, { entryId: 'invalid-source', reason: 'MALFORMED' }]);
  });

  it('fails measurement on input/source/authority drift, duplicate receipts and hash/length mismatch', () => {
    const f = fixture([['a', body([gmail()])]]);
    expect(() => buildFormalNodeCoverage(f.inventory, f.samples, { ...f.binding, bodyMapSha256: 'e'.repeat(64) }, f.binding)).toThrow(/binding mismatch/);
    expect(() => buildFormalNodeCoverage(f.inventory, f.samples, { ...f.binding, producerSourceSha256: 'e'.repeat(64) }, f.binding)).toThrow(/binding mismatch/);
    expect(() => buildFormalNodeCoverage(f.inventory, f.samples, { ...f.binding, engineBuildDigest: 'e'.repeat(64) })).toThrow(/binding mismatch/);
    expect(() => buildFormalNodeCoverage(f.inventory, [{ ...f.samples[0]!, byteLength: 0 }], f.binding)).toThrow(/hash\/length/);
    expect(() => buildFormalNodeCoverage(f.inventory, [], f.binding)).toThrow(/missing examined/);
    const duplicate = { ...f.inventory, rows: [...f.inventory.rows, f.inventory.rows[0]!] };
    expect(() => buildFormalNodeCoverage(duplicate, f.samples, { ...f.binding, sourceBindingsSha256: sourceBindingsDigest(duplicate) })).toThrow(/duplicate/);
  });

  it('compares targets with exact integer arithmetic and never rounds a near miss up', () => {
    expect(coverageRate(19, 20, 95).meetsTarget).toBe(true);
    expect(coverageRate(9499, 10000, 95).meetsTarget).toBe(false);
    expect(coverageRate(9, 10, 90).meetsTarget).toBe(true);
    expect(coverageRate(0, 0, 90)).toMatchObject({ ratio: null, meetsTarget: false });
    expect(() => coverageRate(2, 1, 95)).toThrow();
  });
});
