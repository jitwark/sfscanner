import { canonicalTargetFixture } from './canonical-target.test-helper';
import { notRequestedAdvisoryFixture } from '../../../../contracts/scanner-v2-advisory-fixture.test-helper';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FindingV2, TraceV2 } from '@hub/contracts/scanner-v2-evidence';
import { validateScannerResultV2, type ScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import type { SourceMemberRefV2, SourceSpanV2, SubjectV2 } from '@hub/contracts/scanner-v2-source';
import { V1_RULE_TEMPLATES } from '@hub/scanner-core/compat/v1-registry';
import { buildBatchSarifV2, buildSarifV2, coverageOmissionsV2, serializeSarifV2, type BatchSarifInputV2 } from '@hub/scanner-core/report/sarif-v2/output';
import type { BatchResultV2 } from './batch-runner';
import { projectBatchV2 } from './json-output';
import { serializeNdjsonV2 } from './ndjson-output';
import { renderTableV2 } from './table-output';

type TestLocation = { physicalLocation: { artifactLocation: { uri: string }; region?: Record<string, unknown> } };
type TestResult = { ruleId: string; level: string; message: { text: string }; locations?: TestLocation[]; taxa?: Array<{ id: string; toolComponent: { name: string } }>; partialFingerprints?: Record<string, string> };
type TestNotification = { descriptor: { id: string }; level?: string; locations?: TestLocation[] };
type TestCounts = { findings: number; capabilityOmitted: number; limitOmitted: number; findingOmitted: number; omittedTotal: number; coverageAnalyzed: number; coverageSeen: number };
type TestSecureflow = {
  analysisStatus: string;
  engine: { id: string; version: string; buildDigest: string };
  profile: { id: string; version: string };
  ruleset: { id: string; version: string; digest: string; signatureStatus: string };
  semantics: { id: string; version: string; digest: string };
  targetContextDigest: string;
  limits: { schemaVersion: string; digest: string };
  counts: TestCounts;
  omissions: Array<Record<string, unknown>>;
};
type TestRun = { tool: { driver: { name: string; version: string; rules: Array<{ id: string; helpUri?: string }> } }; results: TestResult[]; invocations: Array<{ executionSuccessful: boolean; toolExecutionNotifications: TestNotification[] }>; taxonomies?: Array<{ name: string; taxa?: Array<{ id: string }> }>; properties?: { secureflow?: TestSecureflow } };

let fid = 1;
const digest = (v = '0') => {
  const hex = '0123456789abcdef';
  const c = hex.includes(v.toLowerCase()) ? v.toLowerCase() : '0';
  return c.repeat(64);
};
const span = (start = 0, end = start + 3, line = 1, col = 1): SourceSpanV2 => ({
  start: { line, column: col, utf16Offset: start, utf8ByteOffset: start },
  end: { line, column: col + (end - start), utf16Offset: end, utf8ByteOffset: end },
});
const member = (v: SourceSpanV2 | null = span()): SourceMemberRefV2 => ({ pointer: '/nodes/0', occurrencePath: [0], astNodeId: digest('a'), span: v });
const subject = (v: SourceSpanV2 | null = span()): SubjectV2 => ({ kind: 'NODE', node: { ordinal: 0, source: member(v), identityDigest: digest('b'), name: 'safe' } });
const templates = new Map(V1_RULE_TEMPLATES.map((t) => [t.ruleId, t]));

const finding = (ruleId: string, v: SourceSpanV2 | null = span()): FindingV2 => {
  const tmpl = templates.get(ruleId)!;
  const evClass = (ruleId.startsWith('TAINTED_') ? 'POTENTIAL_DATAFLOW' : ruleId === 'JAVASCRIPT_DYNAMIC_EXECUTION' || ruleId === 'PYTHON_DYNAMIC_EXECUTION' ? 'SUSPICIOUS_SYNTAX' : (ruleId === 'RAW_AUTH_HEADER' || ruleId === 'RAW_SECRET_INDICATOR' || ruleId === 'UNAPPROVED_DOMAIN' || ruleId === 'UNKNOWN_NODE_PACKAGE' || ruleId === 'WEBHOOK_EXPOSURE') ? 'CONFIGURATION' : 'CAPABILITY') as FindingV2['evidenceClass'];
  return {
    findingId: (fid++).toString(16).padStart(64, '0'), ruleId, ruleRevision: tmpl.revision, effect: tmpl.effect,
    severity: tmpl.severity, confidence: tmpl.confidence, evidenceClass: evClass, conclusion: 'OBSERVED', applicability: 'APPLICABLE',
    subject: subject(v), factRefs: [], traceRefs: [], remediationId: tmpl.remediationId,
  };
};

const CAP_ORDER = ['source-normalization', 'workflow-insights', 'structural-policies', 'assessment', 'presentation-facts'];
const baseResult = (findings: readonly FindingV2[] = [], traces: readonly TraceV2[] = [], diagnostics: ScannerResultV2['analysis']['diagnostics'] = [], status: ScannerResultV2['analysis']['status'] = 'COMPLETE', usage: ScannerResultV2['limits']['usage'] = []): ScannerResultV2 => {
  const capIds = [...new Set(diagnostics.map((d) => d.capabilityId))];
  const capabilities = CAP_ORDER.filter((id) => capIds.includes(id) || id === 'source-normalization').map((id) => ({
    id, version: '2.0.0', required: true, status: status === 'INDETERMINATE' ? ('SKIPPED' as const) : ('COMPLETED' as const),
    seen: 0, analyzed: 0, skipped: 0, omitted: 0,
    diagnosticIds: diagnostics.filter((d) => d.capabilityId === id).map((d) => d.id),
  }));
  return {
    schemaVersion: 'scanner-result-v2', engine: { id: 'secureflow-scanner', version: '2.0.0', buildDigest: digest('a') },
    input: { rawSha256: digest('b'), semanticSha256: digest('c'), ambiguitySha256: digest('d'), ambiguityCount: 0, utf8Bytes: 1 },
    profile: { id: 'beta-default', version: '2.0.0' }, ruleset: { id: 'rules', version: '2.0.0', digest: digest('e'), signatureStatus: 'VERIFIED' },
    semantics: { id: 'semantics', version: '2.0.0', digest: digest('f') },
    target: canonicalTargetFixture(),
    limits: { schemaVersion: 'scanner-limits-v2', digest: digest('1'), usage },
    analysis: { status, capabilities, diagnostics },
    workflow: { name: null, nodeCount: 0, rawNodeCount: 0, annotationNodeCount: 0, triggerCount: 0, actionCount: 0, integrationCount: 0, edgeCount: 0, resolvedEdgeCount: 0, payloadBytes: 0, complexity: 'LOW', isSubWorkflow: false },
    facts: [notRequestedAdvisoryFixture(canonicalTargetFixture().contextDigest)], traces: [...traces], findings: [...findings],
    assessment: status === 'INDETERMINATE' ? null : { score: 0, grade: 'LOW', scoringPolicyVersion: 'secureflow-risk-v2@2.0.0', basisFindingIds: findings.filter((f) => f.effect === 'SCORING').map((f) => f.findingId), excludedReportOnlyFindingIds: findings.filter((f) => f.effect === 'REPORT_ONLY').map((f) => f.findingId), excludedUncertainFindingIds: [], excludedNotApplicableFindingIds: [], unknownEvidenceCount: 0 },
    stats: { rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings: 0, serializedBytes: 0 },
  };
};

describe('sarif-output core and schema', () => {
  it('conforms to official SARIF 2.1.0 JSON schema fixture', () => {
    const schema = JSON.parse(readFileSync(new URL('../../../scanner-core/src/report/__fixtures__/sarif-2.1.0.schema.json', import.meta.url), 'utf8')) as {
      required: string[]; definitions: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
    };
    const log = buildBatchSarifV2([{ label: 'flow.json', status: 'COMPLETED', result: baseResult([finding('N8N_EXECUTE_COMMAND')]) }]);
    expect(schema.required).toContain('version');
    expect(log.version).toBe('2.1.0');
    expect(log.$schema).toContain('sarif-2.1.0');
    const run = log.runs[0] as unknown as TestRun;
    expect(run.tool.driver.name).toBe('secureflow-scanner');
    expect(run.results[0].message.text).toBe('This workflow can execute shell commands.');
    expect(run.results[0].locations![0].physicalLocation.artifactLocation.uri).toBe('flow.json');
    expect(run.invocations[0].executionSuccessful).toBe(true);
    expect(Object.isFrozen(log) && Object.isFrozen(log.runs[0])).toBe(true);
  });

  it('enforces custom limits and maxRules truncation with OPTIONAL_LIMIT_EXCEEDED warning', () => {
    const res = baseResult([finding('RAW_AUTH_HEADER'), finding('RAW_SECRET_INDICATOR')]);
    const log = buildBatchSarifV2({
      items: [{ label: 'flow.json', status: 'COMPLETED', result: res }],
      limits: { maxRules: 1 },
    });
    const run = log.runs[0] as unknown as TestRun;
    expect(run.tool.driver.rules).toHaveLength(1);
    expect(run.results).toHaveLength(1);
    expect(run.invocations[0].executionSuccessful).toBe(true);
    expect(run.invocations[0].toolExecutionNotifications.some((n) => n.descriptor.id === 'OPTIONAL_LIMIT_EXCEEDED')).toBe(true);
  });

  it('validates span coordinates, omits null spans, and rejects malformed spans', () => {
    const resWithNullSpan = baseResult([finding('N8N_CODE_NODE', null)]);
    const log = buildBatchSarifV2([{ label: 'null-span.json', status: 'COMPLETED', result: resWithNullSpan }]);
    expect((log.runs[0] as unknown as TestRun).results[0].locations).toBeUndefined();

    const badSpanResult = { ...baseResult(), findings: [{ ...finding('N8N_EXECUTE_COMMAND'), subject: { kind: 'NODE', node: { ordinal: 0, source: { pointer: '', occurrencePath: [0], astNodeId: digest('a'), span: { start: { line: 0, column: 1, utf16Offset: 0, utf8ByteOffset: 0 }, end: { line: 1, column: 2, utf16Offset: 1, utf8ByteOffset: 1 } } }, identityDigest: digest('b') } } }] };
    expect(() => buildBatchSarifV2([{ label: 'bad.json', status: 'COMPLETED', result: badSpanResult as unknown as ScannerResultV2 }])).toThrow(TypeError);
  });

  it('preserves duplicate diagnostics and locations deterministically without code collapse', () => {
    const d1 = { id: digest('1'), code: 'DUPLICATE_FINDING_COLLAPSED' as const, category: 'POLICY' as const, capabilityId: 'structural-policies', aggregateEffect: 'DEGRADED' as const, assessmentEligible: true, location: member(span(0, 5, 1, 1)) };
    const d2 = { id: digest('2'), code: 'DUPLICATE_FINDING_COLLAPSED' as const, category: 'POLICY' as const, capabilityId: 'structural-policies', aggregateEffect: 'DEGRADED' as const, assessmentEligible: true, location: member(span(10, 15, 2, 1)) };
    const res = baseResult([], [], [d1, d2], 'DEGRADED');
    const log = buildBatchSarifV2([{ label: 'diag.json', status: 'COMPLETED', result: res }]);
    const notifs = (log.runs[0] as unknown as TestRun).invocations[0].toolExecutionNotifications;
    const duplicates = notifs.filter((n) => n.descriptor.id === 'DUPLICATE_FINDING_COLLAPSED');
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0].locations![0].physicalLocation.region!.startLine).toBe(1);
    expect(duplicates[1].locations![0].physicalLocation.region!.startLine).toBe(2);
  });

  it('rejects mixed engine, profile, ruleset, semantics, target, or limits identities', () => {
    const resA = baseResult();
    const resDiffEngine = { ...baseResult(), engine: { id: 'secureflow-scanner', version: '3.0.0', buildDigest: digest('2') } };
    expect(() => buildBatchSarifV2([
      { label: 'a.json', status: 'COMPLETED', result: resA },
      { label: 'b.json', status: 'COMPLETED', result: resDiffEngine },
    ])).toThrow(TypeError);

    const target = canonicalTargetFixture({ edition: 'ENTERPRISE' });
    const resDiffTarget = { ...baseResult(), target, facts: [notRequestedAdvisoryFixture(target.contextDigest)] };
    expect(validateScannerResultV2(resDiffTarget).ok).toBe(true);
    expect(() => buildBatchSarifV2([
      { label: 'a.json', status: 'COMPLETED', result: resA },
      { label: 'c.json', status: 'COMPLETED', result: resDiffTarget },
    ])).toThrow(TypeError);
  });

  it('enforces URI root containment and rejects exact root match and outside paths', () => {
    const f = finding('N8N_EXECUTE_COMMAND');
    const inside = buildBatchSarifV2({
      items: [{ label: 'src/sub/workflow.json', status: 'COMPLETED', result: baseResult([f]) }],
      selectionRoot: 'src',
    });
    expect((inside.runs[0] as unknown as TestRun).results[0].locations![0].physicalLocation.artifactLocation.uri).toBe('sub/workflow.json');

    const exactRoot = buildBatchSarifV2({
      items: [{ label: 'src', status: 'COMPLETED', result: baseResult([f]) }],
      selectionRoot: 'src',
    });
    expect((exactRoot.runs[0] as unknown as TestRun).results[0].locations).toBeUndefined();

    const outside = buildBatchSarifV2({
      items: [{ label: 'other/workflow.json', status: 'COMPLETED', result: baseResult([f]) }],
      selectionRoot: 'src',
    });
    expect((outside.runs[0] as unknown as TestRun).results[0].locations).toBeUndefined();
  });

  it('reconciles finding metadata and rejects forged rule metadata', () => {
    const forgedFinding = { ...finding('N8N_EXECUTE_COMMAND'), severity: 'LOW' as const };
    const forgedResult = baseResult([forgedFinding]);
    expect(() => buildBatchSarifV2([{ label: 'forged.json', status: 'COMPLETED', result: forgedResult }])).toThrow(TypeError);
  });
  it('extracts nested input URI and label without accepting forged evidence class', () => {
    const nested = buildBatchSarifV2([{ input: { label: 'nested-label.json', uri: 'nested/workflow.json' }, status: 'COMPLETED', result: baseResult([finding('N8N_EXECUTE_COMMAND')]) }]);
    const nestedRun = nested.runs[0] as unknown as TestRun;
    expect(nestedRun.results[0].locations![0].physicalLocation.artifactLocation.uri).toBe('nested/workflow.json');
    const forged = { ...finding('RAW_AUTH_HEADER'), evidenceClass: 'CAPABILITY' as const };
    expect(() => buildBatchSarifV2([{ label: 'forged.json', status: 'COMPLETED', result: baseResult([forged]) }])).toThrow(TypeError);
  });

  it('reports bounded taxa, notifications, flows, and trace-step truncation', () => {
    const taxaLog = buildBatchSarifV2({ items: [{ label: 'taxa.json', status: 'COMPLETED', result: baseResult([finding('RAW_AUTH_HEADER')]) }], limits: { maxTaxa: 0 } });
    expect((taxaLog.runs[0] as unknown as TestRun).invocations[0].toolExecutionNotifications.some((n) => n.descriptor.id === 'OPTIONAL_LIMIT_EXCEEDED')).toBe(true);
    const diagnostics = [
      { id: digest('1'), code: 'DUPLICATE_FINDING_COLLAPSED' as const, category: 'POLICY' as const, capabilityId: 'structural-policies', aggregateEffect: 'DEGRADED' as const, assessmentEligible: true },
      { id: digest('2'), code: 'DUPLICATE_FINDING_COLLAPSED' as const, category: 'POLICY' as const, capabilityId: 'structural-policies', aggregateEffect: 'DEGRADED' as const, assessmentEligible: true },
    ];
    const notificationLog = buildBatchSarifV2({ items: [{ label: 'diagnostics.json', status: 'COMPLETED', result: baseResult([], [], diagnostics, 'DEGRADED') }], limits: { maxNotifications: 1 } });
    expect((notificationLog.runs[0] as unknown as TestRun).invocations[0].toolExecutionNotifications[0]?.descriptor.id).toBe('OPTIONAL_LIMIT_EXCEEDED');
    const trace: TraceV2 = { traceId: digest('c'), kind: 'INTEGRITY', steps: [{ ordinal: 0, kind: 'SOURCE', subject: subject(), factRefs: [] }, { ordinal: 1, kind: 'SINK', subject: subject(span(4, 7)), factRefs: [] }] };
    const traced = { ...finding('N8N_EXECUTE_COMMAND'), traceRefs: [trace.traceId] };
    const flowLog = buildBatchSarifV2({ items: [{ label: 'flow.json', status: 'COMPLETED', result: baseResult([traced], [trace]) }], limits: { maxFlows: 0 } });
    expect((flowLog.runs[0] as unknown as TestRun).invocations[0].toolExecutionNotifications.some((n) => n.descriptor.id === 'OPTIONAL_LIMIT_EXCEEDED')).toBe(true);
    const stepLog = buildBatchSarifV2([{ label: 'steps.json', status: 'COMPLETED', result: baseResult([traced], [trace], [], 'COMPLETE', [{ id: 'maxTraceStepsPerFinding', maximum: 1, examined: 1, omitted: 0, exhausted: true }]) }]);
    expect((stepLog.runs[0] as unknown as TestRun).invocations[0].toolExecutionNotifications.some((n) => n.descriptor.id === 'OPTIONAL_LIMIT_EXCEEDED')).toBe(true);
  });

  it('publishes canonical identity, status, counts, and omission properties on the single run', () => {
    const completeRun = buildBatchSarifV2([{ label: 'props.json', status: 'COMPLETED', result: baseResult([finding('N8N_EXECUTE_COMMAND')]) }]).runs[0] as unknown as TestRun;
    expect(completeRun.properties!.secureflow).toEqual({
      analysisStatus: 'COMPLETE',
      engine: { id: 'secureflow-scanner', version: '2.0.0', buildDigest: digest('a') },
      profile: { id: 'beta-default', version: '2.0.0' },
      ruleset: { id: 'rules', version: '2.0.0', digest: digest('e'), signatureStatus: 'VERIFIED' },
      semantics: { id: 'semantics', version: '2.0.0', digest: digest('f') },
      targetContextDigest: canonicalTargetFixture().contextDigest,
      limits: { schemaVersion: 'scanner-limits-v2', digest: digest('1') },
      counts: { findings: 1, capabilityOmitted: 0, limitOmitted: 0, findingOmitted: 0, omittedTotal: 0, coverageAnalyzed: 0, coverageSeen: 0 },
      omissions: [],
    });

    const degraded: ScannerResultV2 = {
      ...baseResult([finding('N8N_EXECUTE_COMMAND')]),
      limits: { schemaVersion: 'scanner-limits-v2', digest: digest('1'), usage: [{ id: 'maxFindings', maximum: 10, examined: 8, omitted: 2, exhausted: false }] },
      analysis: { status: 'DEGRADED', capabilities: [{ id: 'source-normalization', version: '2.0.0', required: false, status: 'DEGRADED', seen: 5, analyzed: 4, skipped: 0, omitted: 1, diagnosticIds: [] }], diagnostics: [] },
      stats: { rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings: 3, serializedBytes: 0 },
    };
    const degradedRun = buildBatchSarifV2([{ label: 'degraded.json', status: 'COMPLETED', result: degraded }]).runs[0] as unknown as TestRun;
    expect(degradedRun.properties!.secureflow).toMatchObject({
      analysisStatus: 'DEGRADED',
      counts: { findings: 1, capabilityOmitted: 1, limitOmitted: 2, findingOmitted: 3, omittedTotal: 5, coverageAnalyzed: 4, coverageSeen: 5 },
      omissions: [
        { source: 'CAPABILITY', capabilityId: 'source-normalization', status: 'DEGRADED', omitted: 1 },
        { source: 'LIMIT', id: 'maxFindings', examined: 8, maximum: 10, omitted: 2, exhausted: false },
        { source: 'FINDINGS', omitted: 3 },
      ],
    });
  });

  it('derives the total from limit and finding omissions without double counting capability rows', () => {
    const overlap = (usage: ScannerResultV2['limits']['usage'], omittedFindings: number): ScannerResultV2 => ({
      ...baseResult([finding('N8N_EXECUTE_COMMAND')], [], [], 'DEGRADED', usage),
      analysis: { status: 'DEGRADED', capabilities: [{ id: 'source-normalization', version: '2.0.0', required: false, status: 'DEGRADED', seen: 5, analyzed: 4, skipped: 0, omitted: 2, diagnosticIds: [] }], diagnostics: [] },
      stats: { rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings, serializedBytes: 0 },
    });
    const overlapRun = buildBatchSarifV2([{ label: 'overlap.json', status: 'COMPLETED', result: overlap([{ id: 'maxFindings', maximum: 10, examined: 8, omitted: 1, exhausted: false }], 2) }]).runs[0] as unknown as TestRun;
    expect(overlapRun.properties!.secureflow).toMatchObject({
      counts: { findings: 1, capabilityOmitted: 2, limitOmitted: 1, findingOmitted: 2, omittedTotal: 3, coverageAnalyzed: 4, coverageSeen: 5 },
      omissions: [
        { source: 'CAPABILITY', capabilityId: 'source-normalization', status: 'DEGRADED', omitted: 2 },
        { source: 'LIMIT', id: 'maxFindings', examined: 8, maximum: 10, omitted: 1, exhausted: false },
        { source: 'FINDINGS', omitted: 2 },
      ],
    });

    const batched = buildBatchSarifV2([
      { label: 'a.json', status: 'COMPLETED', result: overlap([{ id: 'maxFindings', maximum: 10, examined: 8, omitted: 1, exhausted: false }], 2) },
      { label: 'b.json', status: 'COMPLETED', result: overlap([{ id: 'maxFindings', maximum: 3, examined: 1, omitted: 2, exhausted: false }], 4) },
    ]).runs[0] as unknown as TestRun;
    expect(batched.properties!.secureflow!.counts).toMatchObject({ findings: 2, capabilityOmitted: 4, limitOmitted: 3, findingOmitted: 6, omittedTotal: 9, coverageAnalyzed: 8, coverageSeen: 10 });
  });

  it('reports omitted findings without inventing a limit row and aggregates counts across a batch', () => {
    const findingsOnly: ScannerResultV2 = {
      ...baseResult([finding('N8N_EXECUTE_COMMAND')], [], [], 'DEGRADED'),
      stats: { rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings: 3, serializedBytes: 0 },
    };
    const findingsRun = buildBatchSarifV2([{ label: 'findings.json', status: 'COMPLETED', result: findingsOnly }]).runs[0] as unknown as TestRun;
    expect(findingsRun.properties!.secureflow).toMatchObject({
      analysisStatus: 'DEGRADED',
      counts: { findings: 1, capabilityOmitted: 0, limitOmitted: 0, findingOmitted: 3, omittedTotal: 3, coverageAnalyzed: 0, coverageSeen: 0 },
      omissions: [{ source: 'FINDINGS', omitted: 3 }],
    });

    const batched = buildBatchSarifV2([
      { label: 'a.json', status: 'COMPLETED', result: baseResult([finding('N8N_EXECUTE_COMMAND')]) },
      { label: 'b.json', status: 'COMPLETED', result: findingsOnly },
    ]).runs[0] as unknown as TestRun;
    expect(batched.properties!.secureflow).toMatchObject({
      analysisStatus: 'DEGRADED',
      engine: { buildDigest: digest('a') },
      counts: { findings: 2, findingOmitted: 3, omittedTotal: 3 },
      omissions: [{ source: 'FINDINGS', omitted: 3 }],
    });
  });

  it('keeps identity, status, counts, and omissions aligned across JSON, NDJSON, table, and SARIF', () => {
    const parity: ScannerResultV2 = {
      ...baseResult([finding('N8N_EXECUTE_COMMAND')]),
      limits: { schemaVersion: 'scanner-limits-v2', digest: digest('1'), usage: [{ id: 'maxFindings', maximum: 10, examined: 8, omitted: 2, exhausted: false }] },
      analysis: { status: 'DEGRADED', capabilities: [{ id: 'source-normalization', version: '2.0.0', required: false, status: 'DEGRADED', seen: 5, analyzed: 4, skipped: 0, omitted: 1, diagnosticIds: [] }], diagnostics: [] },
      stats: { rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings: 3, serializedBytes: 0 },
    };
    const items = [
      { label: 'parity.json', status: 'COMPLETED' as const, result: { ok: true as const, result: parity } },
      { label: 'broken.json', status: 'FAILED' as const, error: { code: 'INVALID_JSON' as const } },
    ];
    const batchResult: BatchResultV2 = { ok: true, items, cancelled: false, completed: 1, failed: 1, concurrency: 1 };
    const expected = coverageOmissionsV2(parity);
    const projected = projectBatchV2(batchResult).items;
    const [jsonItem, jsonError] = projected;
    if (!jsonItem?.ok || jsonError?.ok !== false) throw new Error('expected one success and one input error');
    expect({ input: jsonItem.input, status: jsonItem.result.analysis.status, findings: jsonItem.result.findings.length, ...coverageOmissionsV2(jsonItem.result) })
      .toEqual({ input: 'parity.json', status: 'DEGRADED', findings: 1, ...expected });
    expect({ input: jsonError.input, code: jsonError.error.code }).toEqual({ input: 'broken.json', code: 'INVALID_JSON' });

    const ndjsonLines = serializeNdjsonV2(batchResult).trimEnd().split('\n').map((line) => JSON.parse(line) as { type: string; item?: (typeof projected)[number] });
    expect(ndjsonLines.filter(({ type }) => type === 'result').map(({ item }) => item)).toEqual(projected);

    const table = renderTableV2(batchResult);
    expect(table).toMatch(/parity\.json\s+DEGRADED\s+1\s+4\/5\s+5/);
    expect(table).toMatch(/broken\.json\s+ERROR\s+-\s+-\s+-\s+INVALID_JSON/);

    const sarif = buildBatchSarifV2(items).runs[0] as unknown as TestRun;
    const secureflow = sarif.properties!.secureflow!;
    expect(secureflow.engine).toEqual(jsonItem.result.engine);
    expect(secureflow.profile).toEqual(jsonItem.result.profile);
    expect(secureflow.ruleset).toEqual(jsonItem.result.ruleset);
    expect(secureflow.semantics).toEqual(jsonItem.result.semantics);
    expect(secureflow.targetContextDigest).toBe(jsonItem.result.target.contextDigest);
    expect(secureflow.limits).toEqual({ schemaVersion: parity.limits.schemaVersion, digest: parity.limits.digest });
    expect(secureflow.counts).toEqual({ findings: 1, ...expected });
    expect(secureflow.omissions).toEqual([
      { source: 'CAPABILITY', capabilityId: 'source-normalization', status: 'DEGRADED', omitted: 1 },
      { source: 'LIMIT', id: 'maxFindings', examined: 8, maximum: 10, omitted: 2, exhausted: false },
      { source: 'FINDINGS', omitted: 3 },
    ]);
    expect(sarif.invocations[0]!.executionSuccessful).toBe(false);
    expect(sarif.invocations[0]!.toolExecutionNotifications.some(({ descriptor }) => descriptor.id === 'INVALID_JSON')).toBe(true);
  });

  it('omits run properties when no result completed', () => {
    const run = buildBatchSarifV2([
      { label: 'bad.json', status: 'FAILED', error: { code: 'INVALID_JSON' } },
      { label: 'cancelled.json', status: 'CANCELLED', error: { code: 'SCAN_CANCELLED' } },
    ]).runs[0] as unknown as TestRun;
    expect(run.properties).toBeUndefined();
  });

  it('provides drop-in compatibility via serializeSarifV2 and fails closed on arbitrary runs input', () => {
    const res = baseResult([finding('N8N_EXECUTE_COMMAND')]);
    const singleEnvelope = { result: res, input: { label: 'single.json' } };
    const log = buildSarifV2(singleEnvelope);
    expect(log.version).toBe('2.1.0');
    expect(serializeSarifV2(singleEnvelope).endsWith('\n')).toBe(true);

    expect(() => serializeSarifV2({ runs: [] } as unknown as BatchSarifInputV2)).toThrow(TypeError);
    expect(() => serializeSarifV2({ runs: [{ dangerous: true }] } as unknown as BatchSarifInputV2)).toThrow(TypeError);
  });
});
