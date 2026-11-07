// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import { runScanV2, ScanError } from './run-scan';

/**
 * The v2 engine answers `MALFORMED_WORKFLOW` for a document whose root shape is wrong
 * (`packages/scanner-core/src/v2/workflow-v2/normalize-security-workflow.ts`). The browser
 * scanner must report that as the input-classification error `NOT_A_WORKFLOW` — the same
 * code the v1 worker path emits (`scan.worker.ts`) and the same code
 * `app/e2e/scanner-recovery-qa.spec.ts:35` asserts. Falling through to `V2_FAILURE` tells the
 * reader "the local scanner could not complete this scan", which is an internal-failure claim
 * about valid-looking input.
 *
 * The fake worker forwards the engine's own outcome, so each row first proves the fixture
 * reaches the `MALFORMED_WORKFLOW` branch and then asserts the classification the UI receives.
 */
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;

  postMessage(message: { kind: string; id: string; json?: string }): void {
    if (message.kind !== 'scan-v2' || message.json === undefined) return;
    queueMicrotask(() => {
      if (this.terminated) return;
      const result = scanWorkflowV2({
        bytes: new TextEncoder().encode(message.json!),
        profile: { id: 'beta-default', version: '2.0.0' },
      });
      const data = result.ok
        ? { kind: 'result-v2', id: message.id, result: result.result }
        : { kind: 'error-v2', id: message.id, code: result.code, message: result.message };
      this.onmessage?.({ data } as MessageEvent);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const WRONG_ROOT_SHAPE_DOCUMENTS = [
  // The exact document `app/e2e/scanner-recovery-qa.spec.ts:35` submits.
  ['a credentials and settings export', JSON.stringify({ credentials: {}, settings: {} })],
  ['an empty JSON object', '{}'],
] as const;

describe('runScanV2 error classification', () => {
  for (const [label, json] of WRONG_ROOT_SHAPE_DOCUMENTS) {
    it(`reports ${label} as NOT_A_WORKFLOW, not an internal scan failure`, async () => {
      const engine = scanWorkflowV2({
        bytes: new TextEncoder().encode(json),
        profile: { id: 'beta-default', version: '2.0.0' },
      });
      expect(engine.ok).toBe(false);
      if (engine.ok) return; // Narrowed for TypeScript; the assertion above already failed.
      expect(engine.code).toBe('MALFORMED_WORKFLOW');

      const rejection: unknown = await runScanV2({ json, profile: 'beta-default', approvedDomains: [] })
        .then(() => undefined, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(ScanError);
      expect((rejection as ScanError).code).toBe('NOT_A_WORKFLOW');
    });
  }
});
