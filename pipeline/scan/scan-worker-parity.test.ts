/**
 * AUDIT-SCAN-002 regression: `scanCandidate`'s worker branch used to send the
 * *already-normalized* workflow (post `parseWorkflowJson`) to the worker,
 * which then reparsed it via `JSON.stringify` + `parseWorkflowJson` again.
 * Normalization had already replaced malformed structures (e.g. a non-object
 * `parameters` coerced to `{}`) by then, so the second parse could never
 * reconstruct the diagnostics the first parse would have produced — the
 * worker path silently reported `COMPLETE` where the direct injected-core
 * path correctly reported `INDETERMINATE` with a diagnostic.
 *
 * These tests run the real worker-thread path (`scanCandidate` with no
 * `options.scan`) side by side with the direct injected-core path
 * (`options.scan: scanWorkflowWithCore`) for the same candidate JSON and
 * assert they agree on grade, score, analysisStatus, diagnostics, and
 * findings.
 */
import { describe, expect, it } from 'vitest';
import type { Candidate } from '@hub/contracts';
import { makeCandidate } from '../__fixtures__/make-entry.js';
import { scanCandidate } from './scan-entry.js';
import { scanWorkflowWithCore } from './scanner-core-adapter.js';

const scannerVersion = 'worker-parity-test';

async function runBothPaths(candidate: Candidate) {
  const worker = await scanCandidate(candidate, { scannerVersion });
  const injected = await scanCandidate(candidate, {
    scannerVersion,
    scan: (workflow, options) => scanWorkflowWithCore(workflow, options),
  });
  return { worker, injected };
}

describe('scanCandidate worker path vs. direct injected-core path', () => {
  it('agrees on grade/score/status/diagnostics/findings for a malformed node parameters value', async () => {
    const candidate = makeCandidate({
      id: 'malformed-parameters',
      json: {
        nodes: [{ id: '1', name: 'Code', type: 'n8n-nodes-base.code', parameters: 'not-object' }],
        connections: {},
      },
    });

    const { worker, injected } = await runBothPaths(candidate);

    expect(worker).toEqual(injected);
    expect(injected).toMatchObject({
      grade: 'UNKNOWN',
      score: 0,
      analysisStatus: 'INDETERMINATE',
      analysisDiagnosticCodes: ['MALFORMED_NODE_PARAMETERS'],
    });
  });

  it('agrees on grade/score/status/diagnostics/findings for a duplicate node name', async () => {
    // DUPLICATE_NODE_NAME is a `workflow.parseDiagnostics` entry but is not
    // surfaced into the public `analysisDiagnosticCodes` today (only
    // DUPLICATE_JSON_KEY and MALFORMED_NODE_PARAMETERS are, per
    // `collectAnalysisDiagnostics`). It still exercises this diagnostic
    // family end to end and both paths must still agree on the outcome.
    const candidate = makeCandidate({
      id: 'duplicate-node-name',
      json: {
        nodes: [
          { id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger' },
          { id: '2', name: 'Start', type: 'n8n-nodes-base.noOp' },
        ],
        connections: {},
      },
    });

    const { worker, injected } = await runBothPaths(candidate);

    expect(worker).toEqual(injected);
    expect(injected.analysisStatus).toBe('COMPLETE');
  });

  it('agrees on grade/score/status/diagnostics/findings for a duplicate JSON key in the raw source text', async () => {
    // A duplicate key can only be represented in the raw JSON *text*, not in a
    // parsed JS object (the second occurrence would already have won). The
    // candidate must be a JSON string for this diagnostic to be reachable at
    // all, which is also what proves the fix threads the true raw source
    // through to the worker rather than a round-tripped/re-serialized value.
    const json = '{"nodes":[{"id":"1","name":"Start","type":"n8n-nodes-base.manualTrigger","name":"Renamed"}],"connections":{}}';
    const candidate = makeCandidate({ id: 'duplicate-json-key', json });

    const { worker, injected } = await runBothPaths(candidate);

    expect(worker).toEqual(injected);
    expect(injected.analysisDiagnosticCodes).toContain('DUPLICATE_JSON_KEY');
  });

  it('produces byte-identical output for a well-formed workflow', async () => {
    const candidate = makeCandidate({
      id: 'well-formed',
      json: {
        nodes: [
          { id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger' },
          { id: '2', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://example.com' } },
        ],
        connections: { Start: { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] } },
      },
    });

    const { worker, injected } = await runBothPaths(candidate);

    expect(worker).toEqual(injected);
    expect(worker.analysisStatus).toBe('COMPLETE');
    expect(worker.analysisDiagnosticCodes).toBeUndefined();
  });
});
