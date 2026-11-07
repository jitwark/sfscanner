import { canonicalTargetFixture } from './canonical-target.test-helper';
import { notRequestedAdvisoryFixture } from '../../../../contracts/scanner-v2-advisory-fixture.test-helper';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FindingV2, TraceV2 } from '@hub/contracts/scanner-v2-evidence';
import type { ScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import type { SourceMemberRefV2, SourceSpanV2, SubjectV2 } from '@hub/contracts/scanner-v2-source';
import { V1_RULE_TEMPLATES } from '@hub/scanner-core/compat/v1-registry';
import { buildBatchSarifV2, serializeSarifV2 } from '@hub/scanner-core/report/sarif-v2/output';

type TestLocation = { physicalLocation: { artifactLocation: { uri: string }; region?: Record<string, unknown> } };
type TestResult = { ruleId: string; level: string; message: { text: string }; locations?: TestLocation[]; taxa?: Array<{ id: string; toolComponent: { name: string } }>; partialFingerprints?: Record<string, string> };
type TestNotification = { descriptor: { id: string }; level?: string; locations?: TestLocation[] };
type TestRun = { tool: { driver: { name: string; version: string; rules: Array<{ id: string; helpUri?: string }> } }; results: TestResult[]; invocations: Array<{ executionSuccessful: boolean; toolExecutionNotifications: TestNotification[] }>; taxonomies?: Array<{ name: string; taxa?: Array<{ id: string }> }> };

let fid = 100;
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
const subject = (v: SourceSpanV2 | null = span(), digestLetter = 'b'): SubjectV2 => ({ kind: 'NODE', node: { ordinal: 0, source: member(v), identityDigest: digest(digestLetter), name: 'safe' } });
const templates = new Map(V1_RULE_TEMPLATES.map((t) => [t.ruleId, t]));

const finding = (ruleId: string, v: SourceSpanV2 | null = span(), nodeDigest = 'b'): FindingV2 => {
  const tmpl = templates.get(ruleId)!;
  const evClass = (ruleId.startsWith('TAINTED_') ? 'POTENTIAL_DATAFLOW' : ruleId === 'JAVASCRIPT_DYNAMIC_EXECUTION' || ruleId === 'PYTHON_DYNAMIC_EXECUTION' ? 'SUSPICIOUS_SYNTAX' : (ruleId === 'RAW_AUTH_HEADER' || ruleId === 'RAW_SECRET_INDICATOR' || ruleId === 'UNAPPROVED_DOMAIN' || ruleId === 'UNKNOWN_NODE_PACKAGE' || ruleId === 'WEBHOOK_EXPOSURE') ? 'CONFIGURATION' : 'CAPABILITY') as FindingV2['evidenceClass'];
  return {
    findingId: (fid++).toString(16).padStart(64, '0'), ruleId, ruleRevision: tmpl.revision, effect: tmpl.effect,
    severity: tmpl.severity, confidence: tmpl.confidence, evidenceClass: evClass, conclusion: 'OBSERVED', applicability: 'APPLICABLE',
    subject: subject(v, nodeDigest), factRefs: [], traceRefs: [], remediationId: tmpl.remediationId,
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

describe('sarif-output batch and partial outcomes', () => {
  it('merges multi-file batch findings into one run with canonical ordering and URI tie-break', () => {
    // Both items have same rule and subject; URI tie-break orders flow-1 before flow-2
    const f1 = finding('N8N_EXECUTE_COMMAND', span(), 'b');
    const f2 = finding('N8N_EXECUTE_COMMAND', span(), 'b');
    const log = buildBatchSarifV2([
      { label: 'dir/flow-2.json', status: 'COMPLETED', result: baseResult([f2]) },
      { label: 'dir/flow-1.json', status: 'COMPLETED', result: baseResult([f1]) },
    ]);
    expect(log.runs).toHaveLength(1);
    const run = log.runs[0] as unknown as TestRun;
    expect(run.results).toHaveLength(2);
    expect(run.results[0].locations![0].physicalLocation.artifactLocation.uri).toBe('dir/flow-1.json');
    expect(run.results[1].locations![0].physicalLocation.artifactLocation.uri).toBe('dir/flow-2.json');
    expect(run.invocations[0].executionSuccessful).toBe(true);
  });

  it('aggregates multi-item findings under envelope budget without Math.min distortion', () => {
    // Two items each with 1 finding; budget maxResults: 2 allows both
    const f1 = finding('N8N_EXECUTE_COMMAND');
    const f2 = finding('N8N_CODE_NODE');
    const log = buildBatchSarifV2({
      items: [
        { label: 'item1.json', status: 'COMPLETED', result: baseResult([f1]) },
        { label: 'item2.json', status: 'COMPLETED', result: baseResult([f2]) },
      ],
      limits: { maxResults: 2 },
    });
    const run = log.runs[0] as unknown as TestRun;
    expect(run.results).toHaveLength(2);
    expect(run.invocations[0].executionSuccessful).toBe(true);
  });

  it('preserves partial batch outcomes with errors and no false findings', () => {
    const f = finding('N8N_EXECUTE_COMMAND');
    const log = buildBatchSarifV2({
      items: [
        { label: 'ok.json', status: 'COMPLETED', result: baseResult([f]) },
        { label: 'bad.json', status: 'FAILED', error: { code: 'INVALID_JSON' } },
        { label: 'timed.json', status: 'TIMEOUT', error: { code: 'SCAN_TIMEOUT' } },
        { label: 'abort.json', status: 'CANCELLED', error: { code: 'SCAN_CANCELLED' } },
        { label: 'unsafe.json', status: 'FAILED', error: { code: 'FORGED_UNKNOWN_CODE' as unknown as 'TOOL_INVARIANT_FAILED' } },
      ],
    });
    const run = log.runs[0] as unknown as TestRun;
    expect(run.results).toHaveLength(1);
    expect(run.results[0].locations![0].physicalLocation.artifactLocation.uri).toBe('ok.json');
    expect(run.invocations[0].executionSuccessful).toBe(false);
    const notifs = run.invocations[0].toolExecutionNotifications;
    const codes = notifs.map((n) => n.descriptor.id);
    expect(codes).toContain('INVALID_JSON');
    expect(codes).toContain('SCAN_TIMEOUT');
    expect(codes).toContain('SCAN_CANCELLED');
    expect(codes).toContain('TOOL_INVARIANT_FAILED'); // unknown code sanitized
  });

  it('handles all-failed batches and no-assessment runs', () => {
    const failedLog = buildBatchSarifV2([
      { label: 'f1.json', status: 'FAILED', error: { code: 'INPUT_READ_FAILED' } },
      { label: 'f2.json', status: 'FAILED', error: { code: 'WORKFLOW_TOO_LARGE' } },
    ]);
    const fRun = failedLog.runs[0] as unknown as TestRun;
    expect(fRun.results).toHaveLength(0);
    expect(fRun.invocations[0].executionSuccessful).toBe(false);
    expect(fRun.invocations[0].toolExecutionNotifications).toHaveLength(2);

    const emptyLog = buildBatchSarifV2({ items: [] });
    expect(emptyLog.runs[0].results).toHaveLength(0);
    expect((emptyLog.runs[0] as unknown as TestRun).invocations[0].executionSuccessful).toBe(true);
  });

  it('handles degraded and indeterminate analysis diagnostics', () => {
    const degradedD = { id: digest('1'), code: 'DUPLICATE_FINDING_COLLAPSED' as const, category: 'POLICY' as const, capabilityId: 'structural-policies', aggregateEffect: 'DEGRADED' as const, assessmentEligible: true };
    const indetD = { id: digest('2'), code: 'REQUIRED_LIMIT_EXCEEDED' as const, category: 'LIMIT' as const, capabilityId: 'source-normalization', aggregateEffect: 'INDETERMINATE' as const, assessmentEligible: false };

    const degradedLog = buildBatchSarifV2([{ label: 'deg.json', status: 'COMPLETED', result: baseResult([], [], [degradedD], 'DEGRADED') }]);
    expect((degradedLog.runs[0] as unknown as TestRun).invocations[0].executionSuccessful).toBe(true);

    const indetLog = buildBatchSarifV2([{ label: 'ind.json', status: 'COMPLETED', result: baseResult([], [], [indetD], 'INDETERMINATE') }]);
    expect((indetLog.runs[0] as unknown as TestRun).invocations[0].executionSuccessful).toBe(true);
  });

  it('points every rule at the existing policy-inventory anchor', () => {
    const inventory = readFileSync(new URL('../../../../docs/scanner/policy-inventory.md', import.meta.url), 'utf8');
    const log = buildBatchSarifV2([{ label: 'uri.json', status: 'COMPLETED', result: baseResult([finding('N8N_EXECUTE_COMMAND')]) }]);
    const rules = (log.runs[0] as unknown as TestRun).tool.driver.rules;
    const rule = rules.find((item) => item.id === 'N8N_EXECUTE_COMMAND');
    expect(rule).toMatchObject({ helpUri: 'https://github.com/jitwark/n8n-Secureflow/blob/main/docs/scanner/policy-inventory.md#n8n_execute_command' });
    expect(inventory).toContain('### `N8N_EXECUTE_COMMAND`');
  });

  it('preserves permutation-invariant notification sorting even with duplicate same-code/no-URI errors', () => {
    // Both items fail with INPUT_READ_FAILED outside root (no URI emitted)
    const it1 = { label: 'outside-b', status: 'FAILED' as const, error: { code: 'INPUT_READ_FAILED' as const } };
    const it2 = { label: 'outside-a', status: 'FAILED' as const, error: { code: 'INPUT_READ_FAILED' as const } };

    const forward = serializeSarifV2({ items: [it1, it2], selectionRoot: 'src' });
    const reverse = serializeSarifV2({ items: [it2, it1], selectionRoot: 'src' });
    expect(forward).toBe(reverse);
  });

  it('is strictly deterministic across permutation of items and findings', () => {
    const f1 = finding('N8N_EXECUTE_COMMAND');
    const f2 = finding('N8N_CODE_NODE');
    const item1 = { label: 'a.json', status: 'COMPLETED' as const, result: baseResult([f1, f2]) };
    const item2 = { label: 'b.json', status: 'COMPLETED' as const, result: baseResult([f2, f1]) };

    const forward = serializeSarifV2([item1, item2]);
    const reverse = serializeSarifV2([item2, item1]);
    expect(forward).toBe(reverse);
  });
});
