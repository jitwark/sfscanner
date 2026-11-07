// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCANNER_LIMITS } from '@hub/contracts';
import { SAFE_SAMPLE_WORKFLOW } from './safe-sample-workflow';
import type { ScanWorkerRequest, ScanWorkerResponse } from './scan.worker';

const addEventListenerMock = vi.fn();
const postMessageMock = vi.fn();

type MessageListener = (event: MessageEvent<ScanWorkerRequest>) => void;

async function loadWorkerListener(): Promise<MessageListener> {
  await import('./scan.worker');
  const listener = addEventListenerMock.mock.calls[0]?.[1] as MessageListener | undefined;
  if (!listener) throw new Error('scan.worker did not register a message listener');
  return listener;
}

function send(listener: MessageListener, json: string, id: string): void {
  listener({ data: { kind: 'scan', id, json, profile: 'beta-default' } } as MessageEvent<ScanWorkerRequest>);
}
function sendV2(listener: MessageListener, json: string, id: string): void {
  listener({ data: { kind: 'scan-v2', id, json, profile: 'beta-default' } } as MessageEvent<ScanWorkerRequest>);
}


function lastResponse(): ScanWorkerResponse {
  return postMessageMock.mock.calls.at(-1)?.[0] as ScanWorkerResponse;
}

function bareNode(id: string, name: string) {
  return { id, name, type: 'n8n-nodes-base.noOp', parameters: {} };
}

/** One more node than the shared node cap; nothing else in the fixture is large. */
function tooManyNodesWorkflow(): string {
  const nodes = Array.from({ length: DEFAULT_SCANNER_LIMITS.maxNodes + 1 }, (_, index) => bareNode(`n${index}`, `Node ${index}`));
  return JSON.stringify({ name: 'Wide graph', nodes, connections: {} });
}

/** Two nodes, one fan-out with one more edge than the shared edge cap. */
function tooManyEdgesWorkflow(): string {
  const targets = Array.from({ length: DEFAULT_SCANNER_LIMITS.maxEdges + 1 }, () => ({ node: 'B', type: 'main', index: 0 }));
  return JSON.stringify({
    name: 'Wide fan-out',
    nodes: [bareNode('a', 'A'), bareNode('b', 'B')],
    connections: { A: { main: [targets] } },
  });
}

/** A single node; the connections object alone is nested past the shared depth cap. */
function deepConnectionsWorkflow(): string {
  let value: unknown = 'leaf';
  for (let level = 0; level < DEFAULT_SCANNER_LIMITS.maxConnectionDepth + 2; level += 1) {
    value = { [`level-${level}`]: value };
  }
  return JSON.stringify({ name: 'Deep connections', nodes: [bareNode('only', 'OnlyNode')], connections: { metadata: value } });
}

/**
 * AUDIT-SCAN-003 headline case: exactly ONE node, whose parameters alone
 * exceed the shared leaf-count budget. Must never be reported as a node-count
 * problem — that was the audited defect.
 */
function oversizedParametersSingleNodeWorkflow(): string {
  const parameters = Object.fromEntries(
    Array.from({ length: DEFAULT_SCANNER_LIMITS.maxParameterLeaves + 1 }, (_, index) => [`leaf-${index}`, index]),
  );
  return JSON.stringify({
    name: 'Single oversized node',
    nodes: [{ id: 'only', name: 'ParamHeavyNode', type: 'n8n-nodes-base.noOp', parameters }],
    connections: {},
  });
}

function overDepthWorkflow(): string {
  return `{"name":"DEEP_SOURCE_SENTINEL","nodes":[],"connections":{},"metadata":${'['.repeat(512)}0${']'.repeat(512)}}`;
}

describe('scan worker parser boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('addEventListener', addEventListenerMock);
    vi.stubGlobal('postMessage', postMessageMock);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock('@hub/scanner-core/v2');
  });

  it('parses scan input with the shared scanner-core parser and returns a result', async () => {
    const listener = await loadWorkerListener();

    send(listener, SAFE_SAMPLE_WORKFLOW, 'shared-parser-scan');

    expect(postMessageMock).toHaveBeenCalledWith({
      kind: 'progress',
      id: 'shared-parser-scan',
      phase: 'parse',
      pct: 25,
    });
    expect(postMessageMock).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'result',
      id: 'shared-parser-scan',
    }));
  });
  it('ignores malformed closed-protocol requests without echoing unknown fields', async () => {
    const listener = await loadWorkerListener();

    listener({
      data: {
        kind: 'scan-v2',
        id: 'malformed-protocol-scan',
        json: SAFE_SAMPLE_WORKFLOW,
        profile: 'beta-default',
        unknown: 'secret',
      },
    } as unknown as MessageEvent<ScanWorkerRequest>);

    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('validates v2 results before posting them to the host', async () => {
    vi.doMock('@hub/scanner-core/v2', () => ({
      scanWorkflowV2: () => ({ ok: true, result: {} }),
    }));
    const listener = await loadWorkerListener();

    sendV2(listener, SAFE_SAMPLE_WORKFLOW, 'malformed-v2-result-scan');

    expect(lastResponse()).toEqual({
      kind: 'error-v2',
      id: 'malformed-v2-result-scan',
      code: 'INTERNAL',
      message: 'Scanner worker returned a malformed v2 result.',
    });
  });


  it('does not convert raw prototype-like JSON keys into an INTERNAL error', async () => {
    const listener = await loadWorkerListener();
    const json = '{"__proto__":{"polluted":true},"nodes":[{"id":"start",'
      + '"name":"Start","type":"n8n-nodes-base.manualTrigger",'
      + '"parameters":{"__proto__":{"nested":true},"constructor":"value",'
      + '"prototype":"value"}}],"connections":{}}';

    send(listener, json, 'prototype-safe-scan');

    expect(lastResponse()).toMatchObject({ kind: 'result', id: 'prototype-safe-scan' });
    expect(lastResponse()).not.toMatchObject({ code: 'INTERNAL' });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('returns INVALID_JSON for an exact malformed raw JSON payload', async () => {
    const listener = await loadWorkerListener();

    send(listener, '{"nodes":', 'malformed-json-scan');

    expect(lastResponse()).toMatchObject({
      kind: 'error',
      id: 'malformed-json-scan',
      code: 'INVALID_JSON',
    });
  });

  it('returns a redacted DOCUMENT_TOO_DEEP error for valid JSON over the source parser ceiling', async () => {
    const listener = await loadWorkerListener();
    const json = overDepthWorkflow();
    expect(() => JSON.parse(json)).not.toThrow();

    send(listener, json, 'deep-document-scan');

    expect(lastResponse()).toMatchObject({
      kind: 'error',
      id: 'deep-document-scan',
      code: 'DOCUMENT_TOO_DEEP',
    });
    expect(JSON.stringify(lastResponse())).not.toContain('DEEP_SOURCE_SENTINEL');
    expect(JSON.stringify(lastResponse())).not.toContain('metadata');
  });

  describe('WORKFLOW_TOO_COMPLEX cause attribution (AUDIT-SCAN-003)', () => {
    it('reports TOO_MANY_NODES, with the observed count, when only the node budget is violated', async () => {
      const listener = await loadWorkerListener();

      send(listener, tooManyNodesWorkflow(), 'nodes-scan');

      expect(lastResponse()).toMatchObject({
        kind: 'error',
        id: 'nodes-scan',
        code: 'TOO_MANY_NODES',
        details: { observedNodeCount: DEFAULT_SCANNER_LIMITS.maxNodes + 1 },
      });
    });

    it('reports TOO_MANY_EDGES, not TOO_MANY_NODES, when only the edge budget is violated', async () => {
      const listener = await loadWorkerListener();

      send(listener, tooManyEdgesWorkflow(), 'edges-scan');

      expect(lastResponse()).toMatchObject({ kind: 'error', id: 'edges-scan', code: 'TOO_MANY_EDGES' });
    });

    it('reports CONNECTIONS_TOO_DEEP, not TOO_MANY_NODES, when only the connection-nesting budget is violated', async () => {
      const listener = await loadWorkerListener();

      send(listener, deepConnectionsWorkflow(), 'depth-scan');

      expect(lastResponse()).toMatchObject({ kind: 'error', id: 'depth-scan', code: 'CONNECTIONS_TOO_DEEP' });
    });

    it('reports PARAMETERS_TOO_COMPLEX for a single-node workflow with oversized parameters (the audited defect)', async () => {
      const listener = await loadWorkerListener();

      send(listener, oversizedParametersSingleNodeWorkflow(), 'params-scan');

      const response = lastResponse();
      expect(response).toMatchObject({ kind: 'error', id: 'params-scan', code: 'PARAMETERS_TOO_COMPLEX' });
      expect(response).not.toMatchObject({ code: 'TOO_MANY_NODES' });
    });

    it('never echoes node names or parameter content in a TOO_COMPLEX error response', async () => {
      const listener = await loadWorkerListener();
      const fixtures: Array<[string, string]> = [
        ['nodes-leak-check', tooManyNodesWorkflow()],
        ['edges-leak-check', tooManyEdgesWorkflow()],
        ['depth-leak-check', deepConnectionsWorkflow()],
        ['params-leak-check', oversizedParametersSingleNodeWorkflow()],
      ];

      for (const [id, json] of fixtures) {
        send(listener, json, id);
        const serialized = JSON.stringify(lastResponse());
        expect(serialized).not.toContain('OnlyNode');
        expect(serialized).not.toContain('ParamHeavyNode');
        expect(serialized).not.toContain('leaf-');
      }
    });
  });

  /**
   * `scanWorkflowV2` reaches its node budget only after `parseSourceDocument` has walked and span-recorded
   * the whole document — 2.5-4.9 s in the browser for a 10,000-node export, and past the host's
   * worker deadline for a realistically shaped one, where the user is shown the TIMEOUT notice instead of
   * the node limit. The worker therefore counts the top-level nodes before it calls the engine.
   */
  describe('v2 node budget is checked before the engine walks the document', () => {
    it('answers with WORKFLOW_TOO_COMPLEX without calling the engine at all', async () => {
      const engine = vi.fn(() => ({ ok: false, code: 'TOO_COMPLEX_FROM_THE_ENGINE', message: 'walked the document' }));
      vi.doMock('@hub/scanner-core/v2', () => ({ scanWorkflowV2: engine }));
      const listener = await loadWorkerListener();

      sendV2(listener, tooManyNodesWorkflow(), 'v2-node-budget');

      expect(lastResponse()).toEqual({
        kind: 'error-v2',
        id: 'v2-node-budget',
        code: 'WORKFLOW_TOO_COMPLEX',
        message: `Workflow exceeds the ${DEFAULT_SCANNER_LIMITS.maxNodes}-node complexity limit.`,
      });
      expect(engine).not.toHaveBeenCalled();
    });

    /**
     * The byte check is the guard's cheapest step and must stay ahead of the parse: an over-`MAX_BYTES`
     * document is the engine's to reject from its own O(1) size check, so costing the worker a document
     * walk first can only add latency to the one shape that has to decline fastest. A parse of this
     * fixture is not academic — the shared cap is 1.5 MB.
     */
    it('declines an over-MAX_BYTES document without parsing it', async () => {
      const engine = vi.fn(() => ({ ok: false, code: 'WORKFLOW_TOO_LARGE', message: 'the engine judged these bytes' }));
      vi.doMock('@hub/scanner-core/v2', () => ({ scanWorkflowV2: engine }));
      const listener = await loadWorkerListener();
      const json = `{"nodes":[],"connections":{},"pad":"${'x'.repeat(DEFAULT_SCANNER_LIMITS.maxBytes)}"}`;
      const parse = vi.spyOn(JSON, 'parse');

      sendV2(listener, json, 'v2-oversized-before-parse');

      // Parsing this document means handing the whole payload to JSON.parse, so its length identifies it.
      expect(parse.mock.calls.filter(([value]) => typeof value === 'string' && value.length === json.length)).toEqual([]);
      expect(lastResponse()).toMatchObject({ kind: 'error-v2', id: 'v2-oversized-before-parse', code: 'WORKFLOW_TOO_LARGE' });
      parse.mockRestore();
    });

    /**
     * The gate must not steal a diagnosis from another budget: `parseSourceDocument` rejects over-budget
     * bytes before it parses, `normalizeSecurityWorkflow` reports `MALFORMED_WORKFLOW` when the root's
     * `connections` member is not an object, and it sums the item count of *every* `nodes` member rather
     * than the last one JSON.parse keeps — so each document below is still the engine's to judge.
     *
     * The padded over-byte document used to be here. It is now classified before the engine runs, so
     * keeping it would have repinned a pre-engine rejection as an engine verdict; it is asserted below
     * for what it actually is.
     */
    it('leaves a document whose real diagnosis belongs to another budget to the engine', async () => {
      const engine = vi.fn(() => ({ ok: false, code: 'ENGINE_VERDICT', message: 'the engine judged this document' }));
      vi.doMock('@hub/scanner-core/v2', () => ({ scanWorkflowV2: engine }));
      const listener = await loadWorkerListener();
      const halfBudget = Array.from({ length: Math.ceil(DEFAULT_SCANNER_LIMITS.maxNodes / 2) + 1 }, () => '{}');
      const overBudgetNodes = Array.from({ length: DEFAULT_SCANNER_LIMITS.maxNodes + 1 }, () => '{}');
      const cases: Array<[string, string]> = [
        ['v2-malformed-connections', `{"nodes":[${overBudgetNodes}],"connections":[]}`],
        ['v2-duplicate-node-members', `{"nodes":[${halfBudget}],"nodes":[${halfBudget}],"connections":{}}`],
      ];

      for (const [id, json] of cases) {
        sendV2(listener, json, id);
        expect(lastResponse()).toMatchObject({ kind: 'error-v2', id, code: 'ENGINE_VERDICT' });
      }
      expect(engine).toHaveBeenCalledTimes(cases.length);

      // Genuine pre-engine classification: the node budget, not the engine.
      sendV2(listener, `{"nodes":[${overBudgetNodes}],"connections":{}}`, 'v2-over-node-budget');
      expect(lastResponse()).toMatchObject({ kind: 'error-v2', id: 'v2-over-node-budget', code: 'WORKFLOW_TOO_COMPLEX' });
      expect(engine).toHaveBeenCalledTimes(cases.length);
    });
  });

  /**
   * W-009: "24" is a page cap (`HUB_PAGE_SIZE`, `MAX_STATIC_HUBS_PER_KIND`, the
   * flowchart slice) and a node-type count, never an admission limit. A finding
   * that treats a 25-node workflow as rejected has mistaken a presentation
   * constant for the contract, so this pins the real admission boundary from the
   * other side of it: 25 nodes are admitted, and 5,001 are not.
   */
  describe('node admission boundary (W-009)', () => {
    it('admits a 25-node workflow; 24 is a page cap, not an admission limit', async () => {
      const listener = await loadWorkerListener();
      // The same node shape as `SAFE_SAMPLE_WORKFLOW`, which is what the v2
      // engine admits: `bareNode` is the v1 fixture and omits `typeVersion` and
      // `position`, so a document built from it fails normalization for reasons
      // that have nothing to do with how many nodes it has.
      const node = (index: number) => ({
        id: `n${index}`,
        name: `Node ${index}`,
        type: 'n8n-nodes-base.noOp',
        typeVersion: 1,
        position: [index * 120, 0],
        parameters: {},
      });
      const nodes = Array.from({ length: 25 }, (_, index) => node(index));
      sendV2(listener, JSON.stringify({ name: '25 nodes', nodes, connections: {} }), 'v2-25-nodes');
      expect(lastResponse()).toMatchObject({ kind: 'result-v2', id: 'v2-25-nodes' });
    });
  });
});
