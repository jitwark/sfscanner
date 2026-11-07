import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import {
  MAX_TAINT_FINDINGS,
  analyzeWorkflowTaint,
} from '@hub/scanner-core/analyzers/taint/taint-analysis';

const webhook = { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} };
const main = (to: string) => ({ main: [[{ node: to, type: 'main', index: 0 }]] });

function analyze(nodes: unknown[], connections: Record<string, unknown>) {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return analyzeWorkflowTaint(parsed.workflow);
}

/** Webhook → one sink node, wired on main. */
function analyzeSink(type: string, parameters: Record<string, unknown>) {
  return analyze([webhook, { id: 's', name: 'Sink', type, parameters }], { Webhook: main('Sink') });
}

const command = (value: string) => analyzeSink('n8n-nodes-base.executeCommand', { command: value });

describe('analyzeWorkflowTaint', () => {
  it('reports untrusted data reaching a shell command', () => {
    const result = command('={{ $json.cmd }}');

    expect(result.findings).toEqual([expect.objectContaining({
      policyId: 'TAINTED_COMMAND',
      severity: 'CRITICAL',
      location: expect.objectContaining({ nodeName: 'Sink' }),
      evidence: expect.objectContaining({
        sink: 'COMMAND',
        parameterPath: 'command',
        referenceRoot: 'CURRENT_ITEM',
        sourceNodeName: 'Webhook',
        taintLabels: ['WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER'],
      }),
    })]);
  });

  it('reports nothing when the sink parameter holds a literal', () => {
    expect(command('ls -la').findings).toEqual([]);
  });

  it('reports nothing when no node introduces untrusted data', () => {
    const result = analyze(
      [{ id: 'm', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        { id: 's', name: 'Sink', type: 'n8n-nodes-base.executeCommand', parameters: { command: '={{ $json.cmd }}' } }],
      { Manual: main('Sink') },
    );

    expect(result.findings).toEqual([]);
  });

  it('records the node ids along the trace, ending at the sink', () => {
    const evidence = command('={{ $json.cmd }}').findings[0].evidence as {
      tracePath?: string[];
      traceLength?: number;
    };

    expect(evidence.tracePath).toEqual(['w', 's']);
    expect(evidence.tracePath?.length).toBe(evidence.traceLength);
  });

  it('is not evaded by a constant-folded property name', () => {
    const result = command('={{ $json["cm" + "d"] }}');

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence).toMatchObject({ propertyPath: 'cmd' });
  });

  it('is not suppressed by a sanitizer wrapped in a decoder', () => {
    expect(command('={{ decodeURIComponent(encodeURIComponent($json.cmd)) }}').findings).toHaveLength(1);
  });

  it('is suppressed when the outermost wrapper sanitizes that sink', () => {
    const headers = (value: string) => analyzeSink('n8n-nodes-base.httpRequest', {
      headerParameters: { parameters: [{ name: 'X-Trace', value }] },
    });

    expect(headers('={{ $json.trace }}').findings).toHaveLength(1);
    expect(headers('={{ encodeURIComponent($json.trace) }}').findings).toEqual([]);
  });

  it('is suppressed by numeric coercion at every sink', () => {
    expect(command('={{ Number($json.id) }}').findings).toEqual([]);
  });

  it('does not treat percent-encoding as making a URL safe', () => {
    const result = analyzeSink('n8n-nodes-base.httpRequest', { url: '={{ encodeURIComponent($json.host) }}' });

    expect(result.findings.map((finding) => finding.policyId)).toEqual(['TAINTED_REQUEST_URL']);
  });

  it('does not carry taint over a capability edge', () => {
    const result = analyze(
      [webhook, { id: 's', name: 'Sink', type: 'n8n-nodes-base.executeCommand', parameters: { command: '={{ $json.cmd }}' } }],
      { Webhook: { ai_tool: [[{ node: 'Sink', type: 'ai_tool', index: 0 }]] } },
    );

    expect(result.findings).toEqual([]);
  });

  it('resolves a named node reference that is not an immediate predecessor', () => {
    const result = analyze(
      [webhook,
        { id: 'a', name: 'Middle', type: 'n8n-nodes-base.set', parameters: {} },
        { id: 's', name: 'Sink', type: 'n8n-nodes-base.executeCommand', parameters: { command: "={{ $('Webhook').item.json.cmd }}" } }],
      { Webhook: main('Middle'), Middle: main('Sink') },
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence).toMatchObject({ referenceRoot: 'NAMED_NODE' });
  });

  it('reports a dynamic node reference at low confidence', () => {
    const result = analyze(
      [webhook,
        { id: 's', name: 'Sink', type: 'n8n-nodes-base.executeCommand', parameters: { command: '={{ $($json.which).item.json.cmd }}' } }],
      { Webhook: main('Sink') },
    );

    expect(result.findings[0]).toMatchObject({ confidence: 'LOW', evidence: expect.objectContaining({ referenceRoot: 'DYNAMIC_NODE' }) });
  });

  it('names the source on the input index the reference actually reads', () => {
    // 'First' is the higher node index, so a traversal that asks which source
    // reaches the sink would answer 'Second' - the branch $json does not read.
    const result = analyze(
      [{ id: 's2', name: 'Second', type: 'n8n-nodes-base.webhook', parameters: {} },
        { id: 's', name: 'Sink', type: 'n8n-nodes-base.executeCommand', parameters: { command: '={{ $json.cmd }}' } },
        { id: 's1', name: 'First', type: 'n8n-nodes-base.webhook', parameters: {} }],
      {
        Second: { main: [[{ node: 'Sink', type: 'main', index: 1 }]] },
        First: { main: [[{ node: 'Sink', type: 'main', index: 0 }]] },
      },
    );

    expect(result.findings[0].evidence).toMatchObject({ sourceNodeName: 'First' });
  });

  it('never echoes the expression or the parameter value', () => {
    const secret = '$json.veryDistinctivePropertyName';
    const result = command(`={{ ${secret} }}`);

    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('analyzeWorkflowTaint diagnostics', () => {
  it('diagnoses an unreadable expression without dropping the scan', () => {
    const result = command('={{ $json.( }}');

    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'EXPRESSION_PARSE_FAILED', category: 'PARSER' })]);
  });

  it('reports the finding cap exactly once, not once per remaining node', () => {
    const sinks = Array.from({ length: MAX_TAINT_FINDINGS + 10 }, (_value, index) => ({
      id: `s${index}`, name: `Sink${index}`, type: 'n8n-nodes-base.executeCommand',
      parameters: { command: '={{ $json.cmd }}' },
    }));
    const connections = { Webhook: { main: [sinks.map((sink) => ({ node: sink.name, type: 'main', index: 0 }))] } };
    const result = analyze([webhook, ...sinks], connections);

    expect(result.findings).toHaveLength(MAX_TAINT_FINDINGS);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === 'ANALYSIS_LIMIT_EXCEEDED')).toHaveLength(1);
  });

  it('is clean when nothing degraded', () => {
    expect(command('={{ $json.cmd }}').diagnostics).toEqual([]);
  });
});
