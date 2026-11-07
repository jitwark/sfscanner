import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import { ADMITTED_CONFIGURATION_KEYS_V2, scanWorkflowV2, validateTargetContextV3 } from '@hub/scanner-core/v2';
import { describe, expect, it } from 'vitest';
import { validateScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import type { BatchItemV2, BatchResultV2 } from './batch-runner';
import { DEFAULT_PROJECTION_OPTIONS, projectBatchV2, serializeEnvelopeV2, type ProjectionOptionsV2 } from './json-output';
import { buildSupplyChainRequest, type SupplyChainRequestV2 } from './supply-chain-request';

const READY_TARGET = validateTargetContextV3(
  { schemaVersion: 'scanner-target-v3', edition: 'COMMUNITY', communityPackages: [{ name: 'pkg', version: '1.2.3' }] },
  { allowedConfigurationKeys: ADMITTED_CONFIGURATION_KEYS_V2 },
);

type ParsedEnvelope = {
  schemaVersion: string;
  artifacts: { profile: unknown };
  results: Array<{ input: string; result?: { profile: unknown; analysis: { status: string }; assessment: unknown } }>;
  summary: { total: number };
  exitReason: string;
};

function result(source = '{"nodes":[],"connections":{}}') {
  const value = scanWorkflowV2({
    bytes: new TextEncoder().encode(source),
    profile: { id: 'beta-default', version: '2.0.0' },
    limits: DEFAULT_SCANNER_LIMITS_V2,
  });
  if (!value.ok) throw new Error(value.code);
  return value.result;
}
function batch(items: readonly BatchItemV2[]): BatchResultV2 {
  return { ok: true, items, cancelled: false, completed: items.length, failed: 0, concurrency: 1 };
}

describe('serializeEnvelopeV2', () => {
  it('emits canonical UTF-8-safe JSON with stable identity and item order', () => {
    const input = batch([
      { label: '日本語 café.json', status: 'COMPLETED', result: { ok: true, result: result() } },
      { label: 'z.json', status: 'FAILED', error: { code: 'INVALID_JSON' } },
    ]);
    const first = serializeEnvelopeV2(input);
    const second = serializeEnvelopeV2(input);
    const parsed = JSON.parse(first) as ParsedEnvelope;
    expect(first).toBe(second);
    expect(first).toBe(canonicalizeJson(parsed));
    expect(parsed.schemaVersion).toBe('n8n-scan-v2');
    expect(parsed.results.map((item) => item.input)).toEqual(['日本語 café.json', 'z.json']);
    expect(parsed.results[0]!.result!.profile).toEqual(parsed.artifacts.profile);
    const projection = projectBatchV2(input);
    expect(Object.isFrozen(projection.envelope)).toBe(true);
    expect(Object.isFrozen(projection.items)).toBe(true);
  });

  it('preserves the finding threshold for an indeterminate result with findings', () => {
    const value = result('{"nodes":[{"id":"x","name":"Custom","type":"@example/custom-node.unknown","parameters":"not-an-object"}],"connections":{}}');
    expect(value.analysis.status).toBe('INDETERMINATE');
    expect(value.findings.length).toBeGreaterThan(0);
    const output = JSON.parse(serializeEnvelopeV2(batch([{ label: 'custom.json', status: 'COMPLETED', result: { ok: true, result: value } }]))) as ParsedEnvelope & { exitReason: string };
    expect(output.results[0]!.result!.analysis.status).toBe('INDETERMINATE');
    expect(output.results[0]!.result!.assessment).toBeNull();
    expect(output.exitReason).toBe('FINDING_THRESHOLD');
  });

  it('returns item failure for an indeterminate result without findings', () => {
    const value = result('{"nodes":[{"id":"x","name":"Custom","type":"@example/custom-node.unknown","parameters":"not-an-object"}],"connections":{}}');
    const withoutFindings = { ...value, findings: [] };
    expect(withoutFindings.analysis.status).toBe('INDETERMINATE');
    expect(withoutFindings.findings).toHaveLength(0);
    const output = JSON.parse(serializeEnvelopeV2(batch([{ label: 'custom.json', status: 'COMPLETED', result: { ok: true, result: withoutFindings } }]))) as ParsedEnvelope & { exitReason: string };
    expect(output.results[0]!.result!.analysis.status).toBe('INDETERMINATE');
    expect(output.results[0]!.result!.assessment).toBeNull();
    expect(output.exitReason).toBe('ITEM_FAILURE');
  });

  it('omits readiness when the export carries no own node array', () => {
    const workflow = { nodes: [{ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }], connections: {} };
    const value = result(JSON.stringify(workflow));
    const item = { status: 'COMPLETED' as const, result: { ok: true as const, result: value } };
    const projected = projectBatchV2(batch([
      { ...item, label: 'nodes.json', rawWorkflow: workflow },
      { ...item, label: 'absent.json' },
      { ...item, label: 'inherited.json', rawWorkflow: Object.create(workflow) },
      { ...item, label: 'without-nodes.json', rawWorkflow: { name: 'No nodes' } },
    ]), { ...DEFAULT_PROJECTION_OPTIONS, includeReadiness: true });

    const [present, ...withoutExport] = projected.envelope.results;
    expect(present?.ok && present.readiness?.completeness.status).toBe('COMPLETE');
    for (const entry of withoutExport) expect(entry.ok && 'readiness' in entry).toBe(false);
  });

  it('projects readiness only when the projection opts in', () => {
    const workflow = { nodes: [{ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }], connections: {} };
    const item = { status: 'COMPLETED' as const, result: { ok: true as const, result: result(JSON.stringify(workflow)) }, rawWorkflow: workflow };
    const input = batch([
      { ...item, label: 'nodes.json' },
      { label: 'bad.json', status: 'FAILED', error: { code: 'INVALID_JSON' } },
    ]);

    const [ready, failed] = projectBatchV2(input).envelope.results;
    expect(ready?.ok).toBe(true);
    expect(Object.keys(ready!).sort()).toEqual(['input', 'ok', 'result']);
    expect(failed?.ok).toBe(false);
    expect(Object.keys(failed!).sort()).toEqual(['error', 'input', 'ok']);

    const admitted = projectBatchV2(input, { ...DEFAULT_PROJECTION_OPTIONS, includeReadiness: true }).envelope.results;
    expect(admitted[0]?.ok && admitted[0].readiness?.completeness.status).toBe('COMPLETE');
    expect(Object.keys(admitted[0]!).sort()).toEqual(['input', 'ok', 'readiness', 'result']);
    expect(admitted[1]?.ok).toBe(false);
    expect(Object.keys(admitted[1]!).sort()).toEqual(['error', 'input', 'ok']);
  });

  it('reports no unsupported nodes for a degraded capability that names no node', () => {
    const workflow = { nodes: [{ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }], connections: {} };
    const clean = result(JSON.stringify(workflow));
    const [first, ...rest] = clean.analysis.capabilities;
    const degraded = { ...clean, analysis: { ...clean.analysis, status: 'DEGRADED' as const, capabilities: [{ ...first!, status: 'DEGRADED' as const }, ...rest] } };
    expect(degraded.analysis.diagnostics).toHaveLength(0);

    const [item] = projectBatchV2(batch([{ label: 'degraded.json', status: 'COMPLETED', result: { ok: true, result: degraded }, rawWorkflow: workflow }]), { ...DEFAULT_PROJECTION_OPTIONS, includeReadiness: true }).envelope.results;
    expect(item?.ok).toBe(true);
    const completeness = item?.ok ? item.readiness?.completeness : undefined;
    expect(completeness?.status).toBe('COMPLETE');
    expect(completeness?.reasons.some(({ code }) => code === 'UNSUPPORTED_NODE')).toBe(false);
    expect(completeness?.reasons).toEqual([]);
  });

  it('serializes cancellations, empty batches, and malformed batches fail-closed', () => {
    const cancelled = serializeEnvelopeV2({ ok: true, items: [{ label: 'x.json', status: 'CANCELLED', error: { code: 'SCAN_CANCELLED' } }], cancelled: true, completed: 0, failed: 0, concurrency: 1 });
    expect((JSON.parse(cancelled) as ParsedEnvelope).exitReason).toBe('CANCELLED');
    const empty = JSON.parse(serializeEnvelopeV2({ ok: true, items: [], cancelled: false, completed: 0, failed: 0, concurrency: 1 })) as ParsedEnvelope;
    expect(empty.results).toEqual([]);
    expect(empty.summary.total).toBe(0);
    const malformed = JSON.parse(serializeEnvelopeV2({} as BatchResultV2)) as ParsedEnvelope;
    expect(malformed.schemaVersion).toBe('n8n-scan-v2');
    expect(malformed.exitReason).toBe('USAGE');
  });
  it('projects invocation options and applies fail-on to the envelope exit reason', () => {
    const scanned = result('{"nodes":[{"id":"x","name":"Custom","type":"@example/custom-node.unknown","parameters":{}}],"connections":{}}');
    const findings = scanned.findings.map((finding) => ({ ...finding, severity: 'LOW' as const }));
    const lowResult = {
      ...scanned,
      findings,
      analysis: {
        ...scanned.analysis,
        status: 'COMPLETE' as const,
        capabilities: scanned.analysis.capabilities.map((capability) => ({ ...capability, required: false, status: 'COMPLETED' as const, skipped: 0, omitted: 0, diagnosticIds: [] })),
        diagnostics: [],
      },
      assessment: {
        score: 0,
        grade: 'LOW' as const,
        scoringPolicyVersion: '2.0.0',
        basisFindingIds: findings.map((finding) => finding.findingId),
        excludedReportOnlyFindingIds: [],
        excludedUncertainFindingIds: [],
        excludedNotApplicableFindingIds: [],
        unknownEvidenceCount: 0,
      },
    };
    const checked = validateScannerResultV2(lowResult);
    if (!checked.ok) throw new Error(checked.errors.join('; '));
    const projected = projectBatchV2(
      batch([{ label: 'low.json', status: 'COMPLETED', result: { ok: true, result: lowResult } }]),
      {
        format: 'json',
        profile: 'beta-default',
        failOn: 'CRITICAL',
        requireComplete: false,
        concurrency: 4,
        allowUnsignedDevelopmentRules: false,
        sources: {
          profile: 'BUILT_IN',
          rules: 'BUILT_IN',
          semantics: 'BUILT_IN',
          limits: 'BUILT_IN',
          target: 'DEFAULT',
          unsignedDevelopment: 'DEFAULT',
        },
      },
    );
    expect(projected.envelope.invocation).toMatchObject({ format: 'json', profile: 'beta-default', failOn: 'CRITICAL', requireComplete: false, concurrency: 4 });
    expect(projected.envelope.exitReason).toBe('UNDER_THRESHOLD');
  });
  it.each([
    ['a short inventory digest', { schemaVersion: 'supply-chain-request-v2', status: 'EMPTY', inventoryDigest: 'a'.repeat(63), inventoryState: 'DECLARED', evaluation: { status: 'NO_DECLARED_PACKAGES', reason: 'NONE' }, packages: [] }],
    ['a READY request without packages', { schemaVersion: 'supply-chain-request-v2', status: 'READY', inventoryDigest: 'a'.repeat(64), inventoryState: 'DECLARED', evaluation: { status: 'UNAVAILABLE', reason: 'NO_ADMITTED_SNAPSHOT' }, packages: [] }],
  ] as Array<[string, Record<string, unknown>]>)('rejects %s at both projection seams', (_label, request) => {
    const options: ProjectionOptionsV2 = { ...DEFAULT_PROJECTION_OPTIONS, supplyChain: request as unknown as ProjectionOptionsV2['supplyChain'] };
    const input = batch([{ label: 'x.json', status: 'COMPLETED', result: { ok: true, result: result() } }]);
    expect.soft(() => projectBatchV2(input, options)).toThrow();
    expect.soft(() => serializeEnvelopeV2(input, options)).toThrow();
  });

  it('projects the first supply-chain read for a zero-valid-result batch', () => {
    const request = buildSupplyChainRequest({ enabled: true, target: READY_TARGET, inventoryState: 'DECLARED' });
    let reads = 0;
    const options: ProjectionOptionsV2 = {
      ...DEFAULT_PROJECTION_OPTIONS,
      target: READY_TARGET,
      get supplyChain() { reads += 1; return reads === 1 ? request : undefined; },
    };
    const input = batch([{ label: 'x.json', status: 'FAILED', error: { code: 'INVALID_JSON' } }]);
    const projected = projectBatchV2(input, options);
    expect(projected.envelope.supplyChain).toEqual(request);
    expect(projected.envelope.artifacts.target).toEqual(READY_TARGET);
  });

  it('rejects a supply-chain request that only the serialization retry could accept', () => {
    const request = buildSupplyChainRequest({ enabled: true, target: READY_TARGET, inventoryState: 'DECLARED' });
    const malformed = { ...request, inventoryDigest: 'a'.repeat(63) } as unknown as SupplyChainRequestV2;
    let reads = 0;
    const options: ProjectionOptionsV2 = {
      ...DEFAULT_PROJECTION_OPTIONS,
      get supplyChain() { reads += 1; return reads === 1 ? malformed : request; },
    };
    const input = batch([{ label: 'x.json', status: 'COMPLETED', result: { ok: true, result: result() } }]);
    expect(() => serializeEnvelopeV2(input, options)).toThrow();
  });
});
