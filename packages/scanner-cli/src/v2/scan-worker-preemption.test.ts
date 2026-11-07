import { describe, expect, it, vi } from 'vitest';
import type * as ScannerCoreModule from '@hub/scanner-core/v2';
import { runBatchV2 } from './batch-runner';
import { DEFAULT_SCAN_CONFIG_V2 } from './contracts';

/**
 * Meaningful RED before `scan-worker-host.ts` exists: the current default scan is an in-process
 * `scanWorkflowV2` call, so a synchronous scan cannot be preempted by the deadline. The mock
 * records whether the default path still runs the scan on the caller thread. After B-03 the
 * default path owns a worker and must not call this function at all; the worker bundle has its
 * own copy of scanner-core, so mocking the source module cannot mask a fallback.
 */
const blocker = vi.hoisted(() => ({ calls: 0, blockedMs: 3_000 }));

vi.mock('@hub/scanner-core/v2', async (importOriginal) => {
  const actual = await importOriginal<typeof ScannerCoreModule>();
  return {
    ...actual,
    scanWorkflowV2: () => {
      blocker.calls += 1;
      const end = Date.now() + blocker.blockedMs;
      while (Date.now() < end) { /* deliberately blocking CPU work */ }
      return { ok: false as const, code: 'TOOL_INVARIANT_FAILED' as const, message: 'blocked default scan' };
    },
  };
});

const encoder = new TextEncoder();

describe('default scan preemption', () => {
  it('does not execute the default scan on the caller thread', async () => {
    const result = await runBatchV2({
      items: [{ label: 'wf.json', isStdin: false }],
      config: DEFAULT_SCAN_CONFIG_V2,
      read: () => encoder.encode('{"nodes":[],"connections":{}}'),
      timeoutMs: 25,
    });
    expect(result.ok).toBe(true);
    expect(blocker.calls).toBe(0);
  }, 10_000);
});
