import { DEFAULT_SCANNER_LIMITS, toWorkflowParseOptions } from '@hub/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkflowJson, type NormalizedWorkflow } from '@hub/scanner-core/workflow';
import {
  MAX_JAVASCRIPT_SOURCE_BYTES,
  analyzeWorkflowJavaScript,
} from '@hub/scanner-core/analyzers/code/javascript-analysis';
import {
  MAX_PYTHON_SOURCE_BYTES,
  analyzeWorkflowPython,
} from '@hub/scanner-core/analyzers/code/python-analysis';
import { analyzeWorkflowTaint } from '@hub/scanner-core/analyzers/taint/taint-analysis';
import { MAX_HARDENED_FINDINGS_PER_SCAN, scanWorkflow } from './engine';
import {
  MAX_EXPRESSION_SEGMENT_BYTES,
  MAX_EXPRESSION_SEGMENTS,
  MAX_EXPRESSION_REFERENCES,
  readParameterExpressions,
} from '@hub/scanner-core/analyzers/taint/taint-expressions';
import { buildTaintTraces, MAX_TRACE_DEPTH } from '@hub/scanner-core/analyzers/taint/taint-traces';
import { propagateTaint } from '@hub/scanner-core/analyzers/taint/taint-propagation';
import { seedTaintStates } from '@hub/scanner-core/analyzers/taint/taint-sources';
import { cancelScan, runScan } from './run-scan';
import { MockWorker } from './run-scan.test-support';

const parseOptions = toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS);

function node(
  name: string,
  type = 'n8n-nodes-base.noOp',
  parameters: Record<string, unknown> = {},
) {
  return { id: name, name, type, parameters };
}

function main(...targets: string[]) {
  return { main: [targets.map((target) => ({ node: target, type: 'main', index: 0 }))] };
}

function workflowOf(
  nodes: unknown[],
  connections: Record<string, unknown> = {},
): NormalizedWorkflow {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections }), parseOptions);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
}

function nestedValue(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let index = 0; index <= depth; index += 1) value = { next: value };
  return value;
}

describe('scanner adversarial resource validation', () => {
  it('fails closed for invalid JSON and malformed workflow shapes', () => {
    const cases: Array<[string, string, string]> = [
      ['invalid JSON', '{not-json', 'INVALID_JSON'],
      ['primitive JSON', 'null', 'MALFORMED_WORKFLOW'],
      ['missing collections', JSON.stringify({}), 'MALFORMED_WORKFLOW'],
      ['wrong connections shape', JSON.stringify({ nodes: [], connections: [] }), 'MALFORMED_WORKFLOW'],
      ['node missing its type', JSON.stringify({ nodes: [{ name: 'Node' }], connections: {} }), 'MALFORMED_WORKFLOW'],
    ];

    for (const [_label, json, code] of cases) {
      expect(parseWorkflowJson(json, parseOptions)).toMatchObject({ ok: false, code });
    }
  });

  it('rejects a deeply nested parameter tree at the shared parser limit', () => {
    const json = JSON.stringify({
      nodes: [node('Deep', 'n8n-nodes-base.noOp', { value: nestedValue(DEFAULT_SCANNER_LIMITS.maxParameterDepth) })],
      connections: {},
    });

    expect(parseWorkflowJson(json, parseOptions)).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX' });
  });

  it('rejects a wide workflow before normalizing more than the node budget', () => {
    const nodes = Array.from({ length: DEFAULT_SCANNER_LIMITS.maxNodes + 1 }, (_, index) => node(`N${index}`));

    expect(parseWorkflowJson(JSON.stringify({ nodes, connections: {} }), parseOptions)).toMatchObject({
      ok: false,
      code: 'WORKFLOW_TOO_COMPLEX',
    });
  });

  it('rejects a wide connection fan-out at the shared edge budget', () => {
    const targets = Array.from({ length: DEFAULT_SCANNER_LIMITS.maxEdges + 1 }, () => 'Leaf');
    const result = parseWorkflowJson(JSON.stringify({
      nodes: [node('Root'), node('Leaf')],
      connections: { Root: main(...targets) },
    }), parseOptions);

    expect(result).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX' });
  });

  it('rejects a payload larger than the shared byte budget and counts UTF-8 bytes', () => {
    const large = JSON.stringify({ name: 'x'.repeat(DEFAULT_SCANNER_LIMITS.maxBytes), nodes: [], connections: {} });
    expect(parseWorkflowJson(large, parseOptions)).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_LARGE' });

    const unicode = JSON.stringify({ name: '🚀'.repeat(32), nodes: [], connections: {} });
    const byteLength = new TextEncoder().encode(unicode).length;
    expect(byteLength).toBeGreaterThan(unicode.length);
    expect(parseWorkflowJson(unicode, { maxBytes: byteLength - 1 })).toMatchObject({
      ok: false,
      code: 'WORKFLOW_TOO_LARGE',
    });
  });

  it('keeps control characters and supplementary Unicode inside the exact byte budget', () => {
    const json = JSON.stringify({ name: 'line\nnull\u0000tab\t🚀', nodes: [], connections: {} });
    const byteLength = new TextEncoder().encode(json).byteLength;

    expect(parseWorkflowJson(json, { maxBytes: byteLength }).ok).toBe(true);
    expect(parseWorkflowJson(json, { maxBytes: byteLength - 1 })).toMatchObject({
      ok: false,
      code: 'WORKFLOW_TOO_LARGE',
    });
  });

  it('does not execute catastrophic-pattern-shaped JavaScript while inspecting it', () => {
    const source = `const pattern = /^(a+)+$/; pattern.test('${'a'.repeat(1_000)}!');`;
    const result = analyzeWorkflowJavaScript(workflowOf([
      node('Code', 'n8n-nodes-base.code', { jsCode: source }),
    ]));

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('does not evaluate embedded source with executable side effects', () => {
    const result = analyzeWorkflowJavaScript(workflowOf([
      node('Code', 'n8n-nodes-base.code', {
        jsCode: "throw new Error('embedded source must not execute');",
      }),
    ]));

    expect(result).toMatchObject({ findings: [], diagnostics: [] });
  });

  it('stops before parsing oversized JavaScript and Python sources', () => {
    const javascript = analyzeWorkflowJavaScript(workflowOf([
      node('JavaScript', 'n8n-nodes-base.code', { jsCode: 'x'.repeat(MAX_JAVASCRIPT_SOURCE_BYTES + 1) }),
    ]));
    const python = analyzeWorkflowPython(workflowOf([{
      ...node('Python', 'n8n-nodes-base.code', {
        language: 'pythonNative',
        pythonCode: 'x'.repeat(MAX_PYTHON_SOURCE_BYTES + 1),
      }),
      typeVersion: 2,
    }]));

    expect(javascript).toMatchObject({
      findings: [],
      diagnostics: [{ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' } }],
    });
    expect(python).toMatchObject({
      findings: [],
      diagnostics: [{ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' } }],
    });
  });

  it('caps expression segments and references without returning all hostile input', () => {
    const manySegments = readParameterExpressions('{{ $json.value }}'.repeat(MAX_EXPRESSION_SEGMENTS + 1));
    const oversizedSegment = readParameterExpressions(`={{ $json.value + "${'x'.repeat(MAX_EXPRESSION_SEGMENT_BYTES)}" }}`);

    expect(manySegments.references).toHaveLength(MAX_EXPRESSION_SEGMENTS);
    expect(manySegments.diagnostics).toEqual(['ANALYSIS_LIMIT_EXCEEDED']);
    expect(manySegments.references.length).toBeLessThanOrEqual(MAX_EXPRESSION_REFERENCES);
    expect(oversizedSegment).toEqual({ references: [], diagnostics: ['ANALYSIS_LIMIT_EXCEEDED'] });
  });

  it('converges on a cyclic taint graph instead of treating a cycle as unbounded work', () => {
    const workflow = workflowOf(
      [
        node('Webhook', 'n8n-nodes-base.webhook'),
        node('Middle'),
        node('Sink', 'n8n-nodes-base.executeCommand', { command: '={{ $json.command }}' }),
      ],
      { Webhook: main('Middle'), Middle: main('Sink'), Sink: main('Middle') },
    );
    const result = analyzeWorkflowTaint(workflow);

    expect(result.findings).toHaveLength(1);
    expect(result.propagation).toMatchObject({ reachedFixedPoint: true, limitExceeded: false });
  });

  it('bounds reported taint traces by the public trace-depth cap', () => {
    const names = ['Webhook', ...Array.from({ length: MAX_TRACE_DEPTH + 20 }, (_, index) => `N${index}`)];
    const workflow = workflowOf(
      names.map((name, index) => node(name, index === 0 ? 'n8n-nodes-base.webhook' : undefined)),
      Object.fromEntries(names.slice(0, -1).map((name, index) => [name, main(names[index + 1])])),
    );
    const traces = buildTaintTraces(workflow, seedTaintStates(workflow));
    const lengths = [...traces.values()].map((trace) => trace.path.length);

    expect(Math.max(...lengths)).toBe(MAX_TRACE_DEPTH);
    expect(lengths.every((length) => length <= MAX_TRACE_DEPTH)).toBe(true);
    expect(traces.has(names.length - 1)).toBe(false);
  });

  it('reports an explicit taint state-update budget as incomplete', () => {
    const workflow = workflowOf([node('Webhook', 'n8n-nodes-base.webhook'), node('Next')], {
      Webhook: main('Next'),
    });
    const result = propagateTaint(workflow, seedTaintStates(workflow), { maxUpdates: 1 });

    expect(result).toMatchObject({ updates: 1, maxUpdates: 1, reachedFixedPoint: false, limitExceeded: true });
  });

  it('marks the scan degraded when many analyzer findings exceed the per-scan cap', () => {
    const source = 'eval(input);\n'.repeat(10);
    const count = Math.ceil((MAX_HARDENED_FINDINGS_PER_SCAN + 1) / 10);
    const workflow = workflowOf(Array.from({ length: count }, (_, index) => node(
      `Code ${index}`,
      'n8n-nodes-base.code',
      { language: 'javaScript', jsCode: source },
    )));
    const result = scanWorkflow(workflow, { policyProfile: 'beta-hardened' });
    const dynamicFindings = result.findings.filter((finding) => finding.policyId === 'JAVASCRIPT_DYNAMIC_EXECUTION');

    expect(dynamicFindings).toHaveLength(MAX_HARDENED_FINDINGS_PER_SCAN);
    expect(result.analysisStatus).toBe('DEGRADED');
    expect(result.analysisDiagnostics).toContainEqual({ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' });
  });

  it('produces byte-identical results for repeated hardened scans of the same input', () => {
    const json = JSON.stringify({
      name: 'Determinism fixture',
      nodes: [
        node('Webhook', 'n8n-nodes-base.webhook'),
        node('Transform', 'n8n-nodes-base.code', { jsCode: 'eval(input);' }),
        node('Run command', 'n8n-nodes-base.executeCommand', { command: '={{ $json.command }}' }),
      ],
      connections: {
        Webhook: main('Transform'),
        Transform: main('Run command'),
      },
    });
    const firstParsed = parseWorkflowJson(json, parseOptions);
    const secondParsed = parseWorkflowJson(json, parseOptions);
    expect(firstParsed.ok).toBe(true);
    expect(secondParsed.ok).toBe(true);
    if (!firstParsed.ok || !secondParsed.ok) return;

    const first = scanWorkflow(firstParsed.workflow, { policyProfile: 'beta-hardened' });
    const second = scanWorkflow(secondParsed.workflow, { policyProfile: 'beta-hardened' });

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('scanner worker deadline resource guard', () => {
  beforeEach(() => {
    cancelScan();
    MockWorker.instances = [];
    (globalThis as Record<string, unknown>).Worker = MockWorker;
    vi.useFakeTimers();
  });

  afterEach(() => {
    cancelScan();
    vi.useRealTimers();
  });

  it('terminates a held worker and rejects with a typed timeout', async () => {
    const scan = runScan({ json: 'HOLD_TRIGGER', deadlineMs: 25 });
    const assertion = expect(scan).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'Scan exceeded the 25ms worker deadline.',
    });

    await vi.advanceTimersByTimeAsync(25);

    await assertion;
    expect(MockWorker.instances).toHaveLength(1);
    expect(MockWorker.instances[0].terminated).toBe(true);
  });
});
