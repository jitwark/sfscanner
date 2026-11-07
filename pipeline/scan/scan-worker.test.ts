import { DEFAULT_SCANNER_LIMITS } from '@hub/contracts';
import { describe, expect, it } from 'vitest';
import { handleScanRequest } from './scan-worker.js';

describe('handleScanRequest', () => {
  it('scans a valid workflow under both profiles', () => {
    const outcome = handleScanRequest({
      workflow: {
        nodes: [{ id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger' }],
        connections: {},
      },
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.defaultResult).toBeTruthy();
      expect(outcome.hardenedResult).toBeTruthy();
    }
  });

  it('reports a parse failure instead of throwing', () => {
    const outcome = handleScanRequest({ workflow: { not: 'a workflow' } });

    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('MALFORMED_WORKFLOW') });
  });

  /**
   * P1.1 regression: this Node worker previously called `parseWorkflowJson`
   * with no options at all, so nothing enforced `maxBytes`/`maxNodes`/
   * `maxConnectionDepth` on this untrusted-JSON ingestion path — every other
   * caller (browser worker, `validate-scanner.ts`) had a limit and this one
   * silently didn't. It now shares `DEFAULT_SCANNER_LIMITS` like every other
   * consumer, via `toWorkflowParseOptions`.
   */
  it('rejects a workflow over the shared node limit instead of scanning it unbounded', () => {
    const tooManyNodes = Array.from({ length: DEFAULT_SCANNER_LIMITS.maxNodes + 1 }, (_, i) => ({
      id: String(i),
      name: `Node ${i}`,
      type: 'n8n-nodes-base.noOp',
    }));

    const outcome = handleScanRequest({ workflow: { nodes: tooManyNodes, connections: {} } });

    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('WORKFLOW_TOO_COMPLEX') });
  });

  it('rejects a workflow over the shared byte limit', () => {
    const hugeParameterValue = 'x'.repeat(DEFAULT_SCANNER_LIMITS.maxBytes + 1);
    const workflow = {
      nodes: [{ id: '1', name: 'Start', type: 'n8n-nodes-base.set', parameters: { value: hugeParameterValue } }],
      connections: {},
    };

    const outcome = handleScanRequest({ workflow });

    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('WORKFLOW_TOO_LARGE') });
  });
});
