import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '../workflow';
import { analyzeAiCapabilities } from './ai/ai-capability-analysis';
import { analyzeWorkflowJavaScript } from './code/javascript-analysis';
import { analyzeWorkflowPython } from './code/python-analysis';
import { analyzeWorkflowTaint } from './taint/taint-analysis';
import { amplifyTaint, seedTaintStates } from './taint/taint-sources';
import { propagateTaint } from './taint/taint-propagation';

type TestNode = { id: string; name: string; type: string; typeVersion?: number; parameters: Record<string, unknown> };

const main = (...names: string[]) => ({ main: [names.map((node) => ({ node, type: 'main', index: 0 }))] });

function workflow(nodes: TestNode[], connections: Record<string, unknown> = {}) {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
}

function assertFinding(result: { findings: readonly { policyId: string; location: Record<string, unknown>; evidence: Record<string, unknown> }[] }, policyId: string, node: TestNode) {
  const finding = result.findings.find((candidate) => candidate.policyId === policyId);
  expect(finding).toBeDefined();
  if (!finding) return;
  expect(finding.location).toMatchObject({ nodeId: node.id, nodeName: node.name });
  expect(Object.keys(finding.evidence)).not.toHaveLength(0);
}

function codeNode(type: string, parameters: Record<string, unknown>): TestNode {
  return { id: 'code', name: 'Code', type, typeVersion: 2, parameters };
}

function analyzeJavaScript(source: string, parameters: Record<string, unknown> = {}) {
  return analyzeWorkflowJavaScript(workflow([codeNode('n8n-nodes-base.code', { jsCode: source, ...parameters })]));
}

function analyzePython(source: string, parameters: Record<string, unknown> = {}) {
  return analyzeWorkflowPython(workflow([codeNode('n8n-nodes-base.code', { language: 'pythonNative', pythonCode: source, ...parameters })]));
}

describe('analyzer-backed hardened policy coverage', () => {
  it('detects JavaScript dynamic execution with location and evidence', () => {
    const result = analyzeJavaScript('eval(payload);');
    assertFinding(result, 'JAVASCRIPT_DYNAMIC_EXECUTION', codeNode('n8n-nodes-base.code', {}));
    expect(JSON.stringify(result)).toBe(JSON.stringify(analyzeJavaScript('eval(payload);')));
  });

  it('does not treat JavaScript comments, strings, or malformed code as executable', () => {
    expect(analyzeJavaScript('// eval(payload)\nconst label = "eval(value)";').findings).toEqual([]);
    const malformed = analyzeJavaScript('const = ;');
    expect(malformed.findings).toEqual([]);
    expect(malformed.diagnostics.length).toBeGreaterThan(0);
  });

  it('detects Python dynamic execution with location and evidence', () => {
    const result = analyzePython('exec(payload)');
    assertFinding(result, 'PYTHON_DYNAMIC_EXECUTION', codeNode('n8n-nodes-base.code', {}));
    expect(JSON.stringify(result)).toBe(JSON.stringify(analyzePython('exec(payload)')));
  });

  it('does not treat Python comments, strings, or a non-Python source as executable', () => {
    expect(analyzePython('# exec(payload)\nlabel = "eval(value)"').findings).toEqual([]);
    expect(analyzePython('exec(payload)', { language: 'javaScript' }).findings).toEqual([]);
  });

  const taintCases = [
    ['TAINTED_COMMAND', 'n8n-nodes-base.executeCommand', { command: '={{ $json.command }}' }],
    ['TAINTED_SQL_QUERY', 'n8n-nodes-base.postgres', { query: '={{ $json.query }}' }],
    ['TAINTED_REQUEST_URL', 'n8n-nodes-base.httpRequest', { url: '={{ $json.url }}' }],
    ['TAINTED_FILE_PATH', 'n8n-nodes-base.readWriteFile', { filePath: '={{ $json.path }}' }],
    ['TAINTED_CODE_INPUT', 'n8n-nodes-base.code', { jsCode: '={{ $json.code }}' }],
    ['TAINTED_REQUEST_HEADER', 'n8n-nodes-base.httpRequest', { headerParameters: { parameters: [{ name: 'X-Input', value: '={{ $json.header }}' }] } }],
    ['TAINTED_AI_PROMPT', '@n8n/n8n-nodes-langchain.chainLlm', { prompt: '={{ $json.prompt }}' }],
  ] as const;

  function analyzeTaint(sink: TestNode, sourceType = 'n8n-nodes-base.webhook') {
    const source = { id: 'source', name: 'Source', type: sourceType, parameters: {} };
    return analyzeWorkflowTaint(workflow([source, sink], { Source: main(sink.name) }));
  }

  it.each(taintCases)('%s reports a tainted sink with location and evidence', (policyId, type, parameters) => {
    const sink = { id: 'sink', name: 'Sink', type, parameters };
    const result = analyzeTaint(sink);
    assertFinding(result, policyId, sink);
    expect(JSON.stringify(result)).toBe(JSON.stringify(analyzeTaint(sink)));
  });

  it.each(taintCases)('%s has a safe untainted control', (policyId, type, parameters) => {
    const sink = { id: 'sink', name: 'Sink', type, parameters };
    const result = analyzeTaint(sink, 'n8n-nodes-base.manualTrigger');
    expect(result.findings.some((finding) => finding.policyId === policyId)).toBe(false);
  });

  it('honors the header sanitizer control without suppressing other sink semantics', () => {
    const sink = {
      id: 'sink', name: 'Headers', type: 'n8n-nodes-base.httpRequest',
      parameters: { headerParameters: { parameters: [{ name: 'X-Input', value: '={{ encodeURIComponent($json.header) }}' }] } },
    };
    expect(analyzeTaint(sink).findings.some((finding) => finding.policyId === 'TAINTED_REQUEST_HEADER')).toBe(false);
  });

  function analyzeAgent(sourceType = 'n8n-nodes-base.webhook', gated = false) {
    const source = { id: 'source', name: 'Source', type: sourceType, parameters: {} };
    const agent = { id: 'agent', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} };
    const tool = { id: 'tool', name: 'Tool', type: 'n8n-nodes-base.httpRequestTool', parameters: {} };
    const gate = { id: 'gate', name: 'Approval', type: 'n8n-nodes-base.wait', parameters: { resume: 'form' } };
    const nodes = gated ? [source, gate, agent, tool] : [source, agent, tool];
    const execution = gated ? { Source: main('Approval'), Approval: main('Agent') } : { Source: main('Agent') };
    const parsed = workflow(nodes, {
      ...execution,
      Tool: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
    });
    return analyzeAiCapabilities(parsed, propagateTaint(parsed, seedTaintStates(parsed), {
      transfer: (index, state) => amplifyTaint(nodes[index].type, state),
    }));
  }

  it('detects an ungated AI tool with location and evidence', () => {
    const result = analyzeAgent();
    const agent = { id: 'agent', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} };
    assertFinding(result, 'AI_AGENT_UNGATED_TOOL', agent);
    expect(JSON.stringify(result)).toBe(JSON.stringify(analyzeAgent()));
  });

  it('does not report an AI agent for a manual trigger or dominating approval gate', () => {
    expect(analyzeAgent('n8n-nodes-base.manualTrigger').findings).toEqual([]);
    expect(analyzeAgent('n8n-nodes-base.webhook', true).findings).toEqual([]);
  });
});
