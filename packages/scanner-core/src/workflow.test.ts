import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS, toWorkflowParseOptions } from '@hub/contracts';
import {
  DEFAULT_WORKFLOW_PARSE_OPTIONS,
  fingerprintJson,
  parseWorkflowJson,
} from './workflow';
import { MAX_SOURCE_PARSER_DEPTH } from './source/source-preflight';
import { MAX_DUPLICATE_KEY_POINTER_BYTES } from './workflow-source-locations';

const minimalWorkflow = JSON.stringify({
  nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger' }],
  connections: {},
});

function resultOf(value: unknown, options?: Parameters<typeof parseWorkflowJson>[1]) {
  const result = parseWorkflowJson(typeof value === 'string' ? value : JSON.stringify(value), options);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.workflow;
}

function workflowAtDocumentDepth(depth: number): string {
  const nestedDuplicate = '{"duplicate":1,"duplicate":2}';
  const arrays = depth - 2; // Root workflow object and duplicate-key object use two levels.
  return `{"nodes":[],"connections":{},"metadata":${'['.repeat(arrays)}${nestedDuplicate}${']'.repeat(arrays)}}`;
}

describe('scanner-core workflow parser', () => {
  it('accepts a minimal workflow and normalizes the fallback id', () => {
    const workflow = resultOf(JSON.parse(minimalWorkflow));

    expect(workflow.nodeCount).toBe(1);
    expect(workflow.nodes[0]).toMatchObject({
      id: 'Start',
      name: 'Start',
      type: 'n8n-nodes-base.manualTrigger',
      parameters: {},
      sourcePath: '/nodes/0',
    });
    expect(workflow.graph.edges).toEqual([]);
    expect(workflow.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts current exports with metadata while ignoring non-scanner fields', () => {
    const workflow = resultOf({
      name: 'Export',
      nodes: [{ id: 'one', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} }],
      connections: {},
      active: false,
      settings: { executionOrder: 'v1' },
      meta: { instanceId: 'redacted-in-test' },
    });

    expect(workflow.name).toBe('Export');
    expect(workflow.nodes).toHaveLength(1);
  });

  it('rejects invalid JSON and malformed workflow shapes', () => {
    expect(parseWorkflowJson('{ invalid')).toMatchObject({ ok: false, code: 'INVALID_JSON' });
    expect(parseWorkflowJson(JSON.stringify({ nodes: 'not-an-array', connections: {} })))
      .toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
    expect(parseWorkflowJson(JSON.stringify({ nodes: [{}], connections: {} })))
      .toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
    expect(parseWorkflowJson(JSON.stringify({ nodes: [], connections: [] })))
      .toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
  });

  it('rejects payloads and node counts over their configured limits', () => {
    expect(parseWorkflowJson(minimalWorkflow, { maxBytes: 1 }))
      .toMatchObject({ ok: false, code: 'WORKFLOW_TOO_LARGE' });
    const nodes = [
      { name: 'One', type: 'n8n-nodes-base.noOp' },
      { name: 'Two', type: 'n8n-nodes-base.noOp' },
    ];
    expect(parseWorkflowJson(JSON.stringify({ nodes, connections: {} }), { maxNodes: 1 }))
      .toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'NODE_LIMIT' });
  });

  it('rejects an omitted-options workflow above the frozen default node limit', () => {
    const nodes = Array.from({ length: DEFAULT_SCANNER_LIMITS.maxNodes + 1 }, (_, index) => ({
      name: `Node ${index}`,
      type: 'n8n-nodes-base.noOp',
    }));

    expect(parseWorkflowJson(JSON.stringify({ nodes, connections: {} }))).toMatchObject({
      ok: false,
      code: 'WORKFLOW_TOO_COMPLEX',
      cause: 'NODE_LIMIT',
    });
  });

  it('keeps local parser defaults exactly equal to the contracts v1 projection', () => {
    expect(DEFAULT_WORKFLOW_PARSE_OPTIONS).toEqual(toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
  });

  it('preserves an explicit zero parser limit instead of defaulting it', () => {
    expect(parseWorkflowJson(minimalWorkflow, { maxNodes: 0 })).toMatchObject({
      ok: false,
      code: 'WORKFLOW_TOO_COMPLEX',
      cause: 'NODE_LIMIT',
    });
  });

  it('uses UTF-8 byte length at the payload boundary', () => {
    const json = JSON.stringify({ name: '🚀', nodes: [], connections: {} });
    const bytes = new TextEncoder().encode(json).length;

    expect(parseWorkflowJson(json, { maxBytes: bytes }).ok).toBe(true);
    expect(parseWorkflowJson(json, { maxBytes: bytes - 1 }))
      .toMatchObject({ ok: false, code: 'WORKFLOW_TOO_LARGE' });
  });

  it('rejects connection and parameter complexity over configured budgets', () => {
    expect(parseWorkflowJson(JSON.stringify({
      nodes: [],
      connections: { main: [{ nested: [{ target: { node: 'later' } }] }] },
    }), { maxConnectionDepth: 2 })).toMatchObject({
      ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'CONNECTION_DEPTH_LIMIT',
    });

    expect(parseWorkflowJson(JSON.stringify({
      nodes: [{ name: 'Deep', type: 'noOp', parameters: { first: { second: 'value' } } }],
      connections: {},
    }), { maxParameterDepth: 1 })).toMatchObject({
      ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'PARAMETER_COMPLEXITY_LIMIT',
    });

    expect(parseWorkflowJson(JSON.stringify({
      nodes: [{ name: 'Many', type: 'noOp', parameters: { first: 1, second: 2 } }],
      connections: {},
    }), { maxParameterLeaves: 1 })).toMatchObject({
      ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'PARAMETER_COMPLEXITY_LIMIT',
    });
  });

  it('reports the edge-limit cause distinctly from node, depth, and parameter causes', () => {
    const nodes = [
      { name: 'A', type: 'noOp' },
      { name: 'B', type: 'noOp' },
    ];
    const targets = Array.from({ length: 2 }, () => ({ node: 'B', type: 'main', index: 0 }));
    expect(parseWorkflowJson(JSON.stringify({
      nodes,
      connections: { A: { main: [targets] } },
    }), { maxEdges: 1 })).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'EDGE_LIMIT' });
  });

  it('preserves node source spans and reports malformed parameters', () => {
    const json = '{"nodes":[{"name":"Node","type":"noOp","parameters":"bad"}],"connections":{}}';
    const workflow = resultOf(JSON.parse(json));

    const startOffset = json.indexOf('{"name"');
    const endOffset = json.indexOf('}]', startOffset) + 1;
    expect(workflow.nodes[0].sourceSpan).toEqual({
      start: { line: 1, column: startOffset + 1, offset: startOffset },
      end: { line: 1, column: endOffset + 1, offset: endOffset },
    });
    expect(workflow.nodes[0].parameters).toEqual({});
    expect(workflow.parseDiagnostics).toContainEqual({
      code: 'MALFORMED_NODE_PARAMETERS',
      nodeIndex: 0,
      pointer: '/nodes/0/parameters',
    });
  });

  it('reports duplicate names, ids, and nested JSON keys without dropping nodes', () => {
    const json = '{"nodes":[{"id":"same","name":"Dup","type":"noOp",'
      + '"parameters":{"url":"one","url":"two"}},{"id":"same","name":"Dup","type":"noOp"}],'
      + '"connections":{}}';
    const workflow = resultOf(json);

    expect(workflow.nodes).toHaveLength(2);
    expect(workflow.parseDiagnostics).toEqual(expect.arrayContaining([
      { code: 'DUPLICATE_NODE_NAME', nodeIndexes: [0, 1] },
      { code: 'DUPLICATE_NODE_ID', nodeIndexes: [0, 1] },
      { code: 'DUPLICATE_JSON_KEY', pointer: '/nodes/0/parameters/url', key: 'url' },
    ]));
  });

  it('accepts the parser safety ceiling and reports its deepest duplicate key', () => {
    const json = workflowAtDocumentDepth(MAX_SOURCE_PARSER_DEPTH);
    const result = parseWorkflowJson(json);

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.workflow.parseDiagnostics).toContainEqual({
        code: 'DUPLICATE_JSON_KEY',
        pointer: `/metadata/${'0/'.repeat(MAX_SOURCE_PARSER_DEPTH - 2)}duplicate`,
        key: 'duplicate',
      });
    }
  });

  it('rejects a workflow whose duplicate pointer output exceeds its aggregate budget', () => {
    const arrayDepth = MAX_SOURCE_PARSER_DEPTH - 2;
    const pointerBytes = '/metadata'.length + arrayDepth * 2 + 1 + 3;
    const duplicateCount = Math.floor(MAX_DUPLICATE_KEY_POINTER_BYTES / pointerBytes) + 1;
    const members = Array.from({ length: duplicateCount }, (_, index) => {
      const key = index.toString(16).padStart(3, '0');
      return `"${key}":0,"${key}":1`;
    }).join(',');
    const json = `{"nodes":[],"connections":{},"metadata":${'['.repeat(arrayDepth)}{${members}}${']'.repeat(arrayDepth)}}`;
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(DEFAULT_SCANNER_LIMITS.maxBytes);

    expect(parseWorkflowJson(json)).toMatchObject({
      ok: false,
      code: 'WORKFLOW_TOO_COMPLEX',
      cause: 'DUPLICATE_KEY_LOCATION_LIMIT',
    });
  });

  it.each([MAX_SOURCE_PARSER_DEPTH + 1, 2048])(
    'rejects valid JSON at document depth %i as a complexity limit without throwing',
    (depth) => {
      const json = workflowAtDocumentDepth(depth);
      expect(() => JSON.parse(json)).not.toThrow();

      expect(() => parseWorkflowJson(json)).not.toThrow();
      expect(parseWorkflowJson(json)).toMatchObject({
        ok: false,
        code: 'WORKFLOW_TOO_COMPLEX',
        cause: 'DOCUMENT_DEPTH_LIMIT',
      });
    },
  );

  it('treats __proto__, constructor, and prototype as ordinary JSON data', () => {
    const json = '{"__proto__":{"polluted":true},"constructor":"root-constructor",'
      + '"prototype":"root-prototype","nodes":[{"name":"Start",'
      + '"type":"n8n-nodes-base.manualTrigger","parameters":{"__proto__":'
      + '{"nested":true},"constructor":"constructor-value",'
      + '"prototype":"prototype-value"}}],"connections":{"__proto__":'
      + '{"main":[]}}}';

    const result = parseWorkflowJson(json);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parameters = result.workflow.nodes[0].parameters;
    expect(Object.getPrototypeOf(parameters)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.workflow.connections)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.workflow.nodes)).toBe(Array.prototype);
    expect(Object.prototype.hasOwnProperty.call(parameters, '__proto__')).toBe(true);
    expect(parameters.__proto__).toEqual({ nested: true });
    expect(parameters.constructor).toBe('constructor-value');
    expect(parameters.prototype).toBe('prototype-value');
    expect(Object.prototype.hasOwnProperty.call(result.workflow.connections, '__proto__')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(parameters.__proto__, 'nested')).toBe(true);
    expect(Object.getPrototypeOf(parameters.__proto__)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(Object.prototype).not.toHaveProperty('nested');
    expect(Array.prototype).not.toHaveProperty('polluted');
    expect(Date.prototype).not.toHaveProperty('polluted');
  });

  it('binds the last duplicate nodes member to the last member source span', () => {
    const json = '{"nodes":[{"id":"first","name":"First","type":"noOp"}],'
      + '"nodes":[{"id":"last","name":"Last","type":"noOp"}],"connections":{}}';
    const workflow = resultOf(json);

    expect(workflow.nodes[0].id).toBe('last');
    expect(json.slice(workflow.nodes[0].sourceSpan!.start.offset, workflow.nodes[0].sourceSpan!.end.offset))
      .toContain('"last"');
    expect(workflow.parseDiagnostics).toContainEqual({
      code: 'DUPLICATE_JSON_KEY', pointer: '/nodes', key: 'nodes',
    });
  });

  it('produces a whitespace-independent deterministic fingerprint', () => {
    const compact = parseWorkflowJson(minimalWorkflow);
    const pretty = parseWorkflowJson(JSON.stringify(JSON.parse(minimalWorkflow), null, 2));

    expect(compact.ok && pretty.ok).toBe(true);
    if (!compact.ok || !pretty.ok) return;
    expect(compact.workflow.fingerprint).toBe(pretty.workflow.fingerprint);
    expect(fingerprintJson({ b: 2, a: 1 })).toBe(
      '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    );
  });
});
