import { DEFAULT_SCANNER_LIMITS, toWorkflowParseOptions } from '@hub/contracts';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { describe, expect, it } from 'vitest';

function workflowWithNodeCount(count: number): string {
  return JSON.stringify({
    nodes: Array.from({ length: count }, (_, i) => ({
      id: String(i),
      name: `Node ${i}`,
      type: 'n8n-nodes-base.noOp',
    })),
    connections: {},
  });
}

/**
 * P1.1 acceptance: boundary coverage (limit-1/limit/limit+1) for the shared
 * defaults every consumer (`scan.worker.ts`, `pipeline/scan/scan-worker.ts`,
 * `validate-scanner.ts`) now passes through `toWorkflowParseOptions`. This
 * exercises the real option names `parseWorkflowJson` reads, not a re-typed copy.
 */
describe('parseWorkflowJson at the shared limit boundaries', () => {
  const options = toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS);

  it('accepts a node count one below the shared limit', () => {
    const result = parseWorkflowJson(workflowWithNodeCount(DEFAULT_SCANNER_LIMITS.maxNodes - 1), options);
    expect(result.ok).toBe(true);
  });

  it('accepts a node count exactly at the shared limit', () => {
    const result = parseWorkflowJson(workflowWithNodeCount(DEFAULT_SCANNER_LIMITS.maxNodes), options);
    expect(result.ok).toBe(true);
  });

  it('rejects a node count one above the shared limit', () => {
    const result = parseWorkflowJson(workflowWithNodeCount(DEFAULT_SCANNER_LIMITS.maxNodes + 1), options);
    expect(result).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX' });
  });

  it('accepts a payload one byte below the shared byte limit', () => {
    const json = padToExactBytes(safeWorkflowJson(), DEFAULT_SCANNER_LIMITS.maxBytes - 1);
    expect(parseWorkflowJson(json, options).ok).toBe(true);
  });

  it('accepts a payload exactly at the shared byte limit', () => {
    const json = padToExactBytes(safeWorkflowJson(), DEFAULT_SCANNER_LIMITS.maxBytes);
    expect(parseWorkflowJson(json, options).ok).toBe(true);
  });

  it('rejects a payload one byte above the shared byte limit', () => {
    const json = padToExactBytes(safeWorkflowJson(), DEFAULT_SCANNER_LIMITS.maxBytes + 1);
    expect(parseWorkflowJson(json, options)).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_LARGE' });
  });
});

function safeWorkflowJson(): { name: string; nodes: unknown[]; connections: Record<string, unknown> } {
  return { name: '', nodes: [{ id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger' }], connections: {} };
}

/** Pads `name` with spaces so the serialized byte length is exactly `targetBytes`. */
function padToExactBytes(workflow: { name: string }, targetBytes: number): string {
  const withoutName = JSON.stringify({ ...workflow, name: '' });
  const baseBytes = new TextEncoder().encode(withoutName).length;
  const padded = { ...workflow, name: ' '.repeat(Math.max(0, targetBytes - baseBytes)) };
  const json = JSON.stringify(padded);
  const actual = new TextEncoder().encode(json).length;
  if (actual !== targetBytes) throw new Error(`padding drifted: wanted ${targetBytes}, got ${actual}`);
  return json;
}
