import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '../../workflow';
import { analyzeWorkflowTaint } from './taint-analysis';
import { isTaintSourceType, seedTaintStates } from './taint-sources';

const webhook = { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} };
const main = (to: string) => ({ main: [[{ node: to, type: 'main', index: 0 }]] });

function analyze(nodes: unknown[], connections: Record<string, unknown>) {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return analyzeWorkflowTaint(parsed.workflow);
}

describe('scanner-core taint analysis', () => {
  it('seeds only the reviewed Telegram trigger as inbound message data', () => {
    const telegram = { id: 'tg', name: 'Telegram', type: 'n8n-nodes-base.telegramTrigger', parameters: {} };
    const manual = { id: 'm', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', parameters: {} };
    const parsed = parseWorkflowJson(JSON.stringify({ nodes: [telegram, manual], connections: {} }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    expect(isTaintSourceType(telegram.type)).toBe(true);
    expect(isTaintSourceType('n8n-nodes-base.unreviewedTrigger')).toBe(false);
    expect(seedTaintStates(parsed.workflow).map((state) => [...state.labels])).toEqual([
      ['INBOUND_MESSAGE'],
      [],
    ]);
  });

  it('traces Telegram update data into a command sink', () => {
    const source = { id: 'tg', name: 'Telegram', type: 'n8n-nodes-base.telegramTrigger', parameters: {} };
    const sink = {
      id: 's', name: 'Command', type: 'n8n-nodes-base.executeCommand',
      parameters: { command: '={{ $json.cmd }}' },
    };
    const result = analyze([source, sink], { Telegram: main('Command') });

    expect(result.findings).toEqual([expect.objectContaining({
      policyId: 'TAINTED_COMMAND',
      evidence: expect.objectContaining({
        taintLabels: ['INBOUND_MESSAGE'],
        sourceNodeId: 'tg',
        tracePath: ['tg', 's'],
        traceLength: 2,
      }),
    })]);
  });

  it('marks an unreviewed trigger-shaped node as unsupported without seeding it as a source', () => {
    const source = { id: 'u', name: 'Unreviewed', type: 'n8n-nodes-base.unreviewedTrigger', parameters: {} };
    const sink = {
      id: 's', name: 'Command', type: 'n8n-nodes-base.executeCommand',
      parameters: { command: '={{ $json.cmd }}' },
    };
    const result = analyze([source, sink], { Unreviewed: main('Command') });

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([{
      code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY', location: { path: '/nodes/0' },
    }]);
    expect(result.propagation).toBeUndefined();
  });

  it('keeps documented non-data triggers outside taint seeding and unsupported diagnostics', () => {
    const triggers = [
      'n8n-nodes-base.manualTrigger',
      'n8n-nodes-base.scheduleTrigger',
      'n8n-nodes-base.n8nTrigger',
    ].map((type, index) => ({ id: `t${index}`, name: `Trigger ${index}`, type, parameters: {} }));
    const parsed = parseWorkflowJson(JSON.stringify({ nodes: triggers, connections: {} }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    expect(seedTaintStates(parsed.workflow).map((state) => [...state.labels])).toEqual([[], [], []]);
    expect(analyzeWorkflowTaint(parsed.workflow)).toEqual({ findings: [], diagnostics: [] });
  });

  it('reports a deterministic source-to-sink trace with labels and node location', () => {
    const result = analyze([
      webhook,
      { id: 'm', name: 'Middle', type: 'n8n-nodes-base.set', parameters: {} },
      {
        id: 's', name: 'Sink', type: 'n8n-nodes-base.executeCommand',
        parameters: { command: '={{ $json.cmd }}' },
      },
    ], { Webhook: main('Middle'), Middle: main('Sink') });

    expect(result.findings).toEqual([expect.objectContaining({
      policyId: 'TAINTED_COMMAND', severity: 'CRITICAL',
      location: expect.objectContaining({ nodeId: 's', nodeName: 'Sink' }),
      evidence: expect.objectContaining({
        sink: 'COMMAND',
        taintLabels: ['WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER'],
        sourceNodeId: 'w', sourceNodeName: 'Webhook',
        tracePath: ['w', 'm', 's'], traceLength: 3,
      }),
    })]);
  });

  it('applies only the outermost sanitizer and keeps URL encoding unsafe for SSRF', () => {
    const headers = analyze([
      webhook,
      {
        id: 's', name: 'Headers', type: 'n8n-nodes-base.httpRequest',
        parameters: { headerParameters: { parameters: [{ name: 'X-Trace', value: '={{ encodeURIComponent($json.trace) }}' }] } },
      },
    ], { Webhook: main('Headers') });
    expect(headers.findings).toEqual([]);

    const url = analyze([
      webhook,
      {
        id: 's', name: 'Request', type: 'n8n-nodes-base.httpRequest',
        parameters: { url: '={{ encodeURIComponent($json.host) }}' },
      },
    ], { Webhook: main('Request') });
    expect(url.findings.map((finding) => finding.policyId)).toEqual(['TAINTED_REQUEST_URL']);

    const wrapped = analyze([
      webhook,
      {
        id: 's', name: 'Command', type: 'n8n-nodes-base.executeCommand',
        parameters: { command: '={{ decodeURIComponent(encodeURIComponent($json.cmd)) }}' },
      },
    ], { Webhook: main('Command') });
    expect(wrapped.findings).toHaveLength(1);
  });

  it('short-circuits without propagation when no node seeds taint', () => {
    const result = analyze([
      { id: 'm', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
      {
        id: 's', name: 'Sink', type: 'n8n-nodes-base.executeCommand',
        parameters: { command: '={{ $json.cmd }}' },
      },
    ], { Manual: main('Sink') });

    expect(result).toEqual({ findings: [], diagnostics: [] });
    expect(result.propagation).toBeUndefined();
  });

  it('applies unique/missing/ambiguous label controls through the production caller', () => {
    const sink = (command: string) => ({
      id: 's', name: 'Sink', type: 'n8n-nodes-base.executeCommand', parameters: { command },
    });

    expect(analyze([webhook, sink("={{ $('Ghost').json.cmd }}")], { Webhook: main('Sink') }).findings)
      .toEqual([expect.objectContaining({ evidence: expect.objectContaining({ referenceRoot: 'DYNAMIC_NODE' }) })]);

    expect(analyze([
      webhook,
      { id: 'x1', name: 'Dup', type: 'n8n-nodes-base.set', parameters: {} },
      { id: 'x2', name: 'Dup', type: 'n8n-nodes-base.set', parameters: {} },
      sink("={{ $('Dup').json.cmd }}"),
    ], { Webhook: main('Sink') }).findings).toEqual([
      expect.objectContaining({ evidence: expect.objectContaining({ referenceRoot: 'DYNAMIC_NODE' }) }),
    ]);

    expect(analyze([
      webhook,
      sink("={{ $('Webhook').json.cmd }}"),
    ], { Webhook: main('Sink') }).findings).toEqual([
      expect.objectContaining({
        policyId: 'TAINTED_COMMAND',
        evidence: expect.objectContaining({ referenceRoot: 'NAMED_NODE', sourceNodeId: 'w' }),
      }),
    ]);
  });

  it('returns byte-stable findings and diagnostics for repeated analysis', () => {
    const input = [
      webhook,
      { id: 'a', name: 'A', type: 'n8n-nodes-base.executeCommand', parameters: { command: '={{ $json.a }}' } },
      { id: 'b', name: 'B', type: 'n8n-nodes-base.postgres', parameters: { query: '={{ $json.b }}' } },
    ];
    const connections = { Webhook: { main: [[{ node: 'A' }, { node: 'B' }]] } };
    expect(JSON.stringify(analyze(input, connections))).toBe(JSON.stringify(analyze(input, connections)));
  });
});
