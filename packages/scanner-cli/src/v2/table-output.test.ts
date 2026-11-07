import { canonicalTargetFixture } from './canonical-target.test-helper';
import { notRequestedAdvisoryFixture } from '../../../../contracts/scanner-v2-advisory-fixture.test-helper';
import { describe, expect, it } from 'vitest';
import { validateScannerResultV2, type ScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import type { BatchItemV2, BatchResultV2 } from './batch-runner';
import { DEFAULT_PROJECTION_OPTIONS } from './json-output';
import { renderTableV2 } from './table-output';

const digest = (character: string): string => character.repeat(64);
const capability = (overrides: Partial<ScannerResultV2['analysis']['capabilities'][number]> = {}): ScannerResultV2['analysis']['capabilities'][number] => ({
  id: 'source-normalization', version: '2.0.0', required: true, status: 'COMPLETED',
  seen: 0, analyzed: 0, skipped: 0, omitted: 0, diagnosticIds: [], ...overrides,
});
const result = (overrides: Partial<ScannerResultV2> = {}): ScannerResultV2 => ({
  schemaVersion: 'scanner-result-v2', engine: { id: 'secureflow-scanner', version: '2.0.0', buildDigest: digest('a') },
  input: { rawSha256: digest('b'), semanticSha256: digest('c'), ambiguitySha256: digest('d'), ambiguityCount: 0, utf8Bytes: 1 },
  profile: { id: 'beta-default', version: '2.0.0' }, ruleset: { id: 'rules', version: '2.0.0', digest: digest('e'), signatureStatus: 'VERIFIED' },
  semantics: { id: 'semantics', version: '2.0.0', digest: digest('f') },
  target: canonicalTargetFixture(),
  limits: { schemaVersion: 'scanner-limits-v2', digest: digest('1'), usage: [] },
  analysis: { status: 'COMPLETE', capabilities: [capability()], diagnostics: [] },
  workflow: { name: null, nodeCount: 0, rawNodeCount: 0, annotationNodeCount: 0, triggerCount: 0, actionCount: 0, integrationCount: 0, edgeCount: 0, resolvedEdgeCount: 0, payloadBytes: 0, complexity: 'LOW', isSubWorkflow: false },
  facts: [notRequestedAdvisoryFixture(canonicalTargetFixture().contextDigest)], traces: [], findings: [],
  assessment: { score: 0, grade: 'LOW', scoringPolicyVersion: 'secureflow-risk-v2@2.0.0', basisFindingIds: [], excludedReportOnlyFindingIds: [], excludedUncertainFindingIds: [], excludedNotApplicableFindingIds: [], unknownEvidenceCount: 0 },
  stats: { rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings: 0, serializedBytes: 0 },
  ...overrides,
});
const checked = (value: ScannerResultV2): ScannerResultV2 => {
  const validation = validateScannerResultV2(value);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return validation.result;
};
const completed = (label: string, value: ScannerResultV2): BatchItemV2 => ({ label, status: 'COMPLETED', result: { ok: true, result: value } });
const batch = (items: readonly BatchItemV2[]): BatchResultV2 => ({
  ok: true, items, cancelled: items.some(({ status }) => status === 'CANCELLED'),
  completed: items.filter(({ status }) => status === 'COMPLETED').length,
  failed: items.filter(({ status }) => status !== 'COMPLETED' && status !== 'CANCELLED').length, concurrency: 1,
});

describe('renderTableV2', () => {
  it('renders fixed columns, stable widths, and privacy-safe escaped labels', () => {
    const output = renderTableV2(batch([
      { label: '日本語 café.json', status: 'COMPLETED', result: undefined },
      { label: 'C:\\Users\\secret.json', status: 'FAILED', error: { code: 'INPUT_READ_FAILED' } },
      { label: 'bad\nlabel', status: 'CANCELLED', error: { code: 'SCAN_CANCELLED' } },
    ]));
    const lines = output.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^Input +Status +Findings +Coverage +Omitted +Error$/);
    expect(lines[1]).toMatch(/^-+ {2}-+ {2}-+ {2}-+ {2}-+ {2}-+$/);
    expect(output).toContain('INPUT_READ_FAILED');
    expect(output).toContain('CANCELLED');
    expect(output).toMatch(/^input +ERROR +- +- +- +INPUT_READ_FAILED$/m);
    expect(output).toMatch(/^bad\\u000alabel +CANCELLED +- +- +- +SCAN_CANCELLED$/m);
    expect(output).not.toContain('C:\\Users');
    expect(output).not.toContain('\u001b[');
    expect(output).not.toContain('\nlabel');
    expect(output).toBe(renderTableV2(batch([
      { label: '日本語 café.json', status: 'COMPLETED', result: undefined },
      { label: 'C:\\Users\\secret.json', status: 'FAILED', error: { code: 'INPUT_READ_FAILED' } },
      { label: 'bad\nlabel', status: 'CANCELLED', error: { code: 'SCAN_CANCELLED' } },
    ])));
  });

  it('renders analyzed/seen coverage and the summed omission total for successful rows', () => {
    const complete = checked(result({ analysis: { status: 'COMPLETE', capabilities: [capability()], diagnostics: [] } }));
    expect(renderTableV2(batch([completed('clean.json', complete)])))
      .toMatch(/^clean\.json +COMPLETE +0 +0\/0 +0\s*$/m);

    const withoutCapabilities = checked(result({ analysis: { status: 'COMPLETE', capabilities: [], diagnostics: [] } }));
    expect(renderTableV2(batch([completed('bare.json', withoutCapabilities)])))
      .toMatch(/^bare\.json +COMPLETE +0 +- +0\s*$/m);

    const degraded = checked(result({
      limits: { schemaVersion: 'scanner-limits-v2', digest: digest('1'), usage: [{ id: 'maxFindings', maximum: 10, examined: 8, omitted: 2, exhausted: false }] },
      analysis: { status: 'DEGRADED', capabilities: [capability({ required: false, status: 'DEGRADED', seen: 5, analyzed: 4, omitted: 1 })], diagnostics: [] },
      stats: { rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings: 3, serializedBytes: 0 },
    }));
    expect(renderTableV2(batch([completed('degraded.json', degraded)])))
      .toMatch(/^degraded\.json +DEGRADED +0 +4\/5 +5\s*$/m);
  });

  it('counts limit and finding omissions once, excluding duplicated capability rows from the total', () => {
    const overlap = checked(result({
      limits: { schemaVersion: 'scanner-limits-v2', digest: digest('1'), usage: [{ id: 'maxFindings', maximum: 4, examined: 0, omitted: 1, exhausted: false }] },
      analysis: { status: 'DEGRADED', capabilities: [capability({ required: false, status: 'DEGRADED', seen: 4, analyzed: 2, omitted: 2 })], diagnostics: [] },
      stats: { rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings: 2, serializedBytes: 0 },
    }));
    expect(renderTableV2(batch([completed('overlap.json', overlap)])))
      .toMatch(/^overlap\.json +DEGRADED +0 +2\/4 +3\s*$/m);

    const clean = checked(result({
      limits: { schemaVersion: 'scanner-limits-v2', digest: digest('1'), usage: [{ id: 'maxFindings', maximum: 4, examined: 4, omitted: 0, exhausted: false }] },
      analysis: { status: 'COMPLETE', capabilities: [capability({ seen: 4, analyzed: 4 })], diagnostics: [] },
    }));
    expect(renderTableV2(batch([completed('zero.json', clean)])))
      .toMatch(/^zero\.json +COMPLETE +0 +4\/4 +0\s*$/m);
  });

  it('renders the readiness block only when the projection opts in', () => {
    const workflow = { nodes: [{ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }], connections: {} };
    const items = [{ ...completed('ready.json', checked(result())), rawWorkflow: workflow }];

    expect(renderTableV2(batch(items))).not.toContain('Readiness (declared workflow prerequisites');
    expect(renderTableV2(batch(items), { ...DEFAULT_PROJECTION_OPTIONS, includeReadiness: true }))
      .toContain('Readiness (declared workflow prerequisites');
  });

  it('shows bounded evidence pointers and unknown states for each contributing prerequisite', () => {
    const secret = 'sk-live-raw-token-value-0123456789';
    const workflow = { nodes: [
      { name: 'same', type: 'n8n-nodes-base.httpRequest', parameters: { url: '{{ $env.HOST }}', [secret]: '{{ $env.SECRET }}' } },
      { name: 'same', type: 'n8n-nodes-base.httpRequest', parameters: {} },
      { name: 'community', type: 'example-nodes.action', parameters: {}, credentials: { sample: { id: 'id' } } },
    ], connections: {} };
    const output = renderTableV2(batch([{ ...completed('ready.json', checked(result())), rawWorkflow: workflow }]), { ...DEFAULT_PROJECTION_OPTIONS, includeReadiness: true });
    expect(output).toContain('/nodes/0');
    expect(output).toContain('/nodes/1');
    expect(output).toContain('/nodes/2/credentials/sample');
    expect(output).toContain('/nodes/0/parameters/url');
    expect(output).toMatch(/install(?:ed|ation).*UNKNOWN/i);
    expect(output).toMatch(/value.*UNKNOWN.*availability.*UNKNOWN/i);
    expect(output).toContain('environment evidence omitted');
    expect(output).not.toContain(secret);
  });

  it('marks omitted prerequisite evidence when the table list is capped', () => {
    const workflow = { nodes: Array.from({ length: 7 }, (_, index) => ({ name: 'same', type: 'n8n-nodes-base.httpRequest', parameters: {}, id: String(index) })), connections: {} };
    const output = renderTableV2(batch([{ ...completed('many.json', checked(result())), rawWorkflow: workflow }]), { ...DEFAULT_PROJECTION_OPTIONS, includeReadiness: true });
    expect(output).toContain('/nodes/0');
    expect(output).toContain('/nodes/3');
    expect(output).toMatch(/\+3 more/);
  });

  it('keeps each environment and integration name adjacent to its contributing path', () => {
    const workflow = { nodes: [
      { name: 'same', type: 'n8n-nodes-base.slack', parameters: { url: '{{ $env.ZED }}' }, credentials: { slackApi: { id: 'id' } } },
      { name: 'same', type: 'n8n-nodes-base.httpRequest', parameters: { url: '{{ $env.ALPHA }}' } },
    ], connections: {} };
    const output = renderTableV2(batch([{ ...completed('mixed.json', checked(result())), rawWorkflow: workflow }]), { ...DEFAULT_PROJECTION_OPTIONS, includeReadiness: true });
    expect(output).toMatch(/\$env\.ZED[^\n]*\/nodes\/0\/parameters\/url/);
    expect(output).toMatch(/\$env\.ALPHA[^\n]*\/nodes\/1\/parameters\/url/);
    expect(output).toMatch(/slack[^\n]*\/nodes\/0/);
    expect(output).toMatch(/httpRequest[^\n]*\/nodes\/1/);
  });

  it('counts each withheld path before the display cap and escapes names', () => {
    const credentials: Record<string, { id: string }> = {};
    for (let index = 0; index < 5; index += 1) credentials[`credential${index}${'x'.repeat(180)}`] = { id: 'id' };
    const workflow = { nodes: [{ name: 'n', type: 'n8n-nodes-base.set', parameters: {}, credentials }], connections: {} };
    const output = renderTableV2(batch([{ ...completed('withheld.json', checked(result())), rawWorkflow: workflow }]), { ...DEFAULT_PROJECTION_OPTIONS, includeReadiness: true });
    expect(output.match(/\[path omitted\]/g)).toHaveLength(4);
    expect(output).toContain('+1 more');
    expect(output).not.toContain('x'.repeat(180));
    const escaped = { nodes: [{ name: 'n', type: 'n8n-nodes-base.set', parameters: {}, credentials: { 'sample\nname': { id: 'id' } } }], connections: {} };
    const safe = renderTableV2(batch([{ ...completed('escaped.json', checked(result())), rawWorkflow: escaped }]), { ...DEFAULT_PROJECTION_OPTIONS, includeReadiness: true });
    expect(safe).toContain('sample\\nname');
    expect(safe).not.toContain('sample\nname');
  });

  it('renders an empty table without a phantom row', () => {
    const output = renderTableV2({ ok: true, items: [], cancelled: false, completed: 0, failed: 0, concurrency: 1 });
    expect(output.split('\n')).toEqual(['Input  Status  Findings  Coverage  Omitted  Error', '-----  ------  --------  --------  -------  -----', '']);
  });
});
