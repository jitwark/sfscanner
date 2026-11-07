import { parentPort } from 'node:worker_threads';
import { DEFAULT_SCANNER_LIMITS, toWorkflowParseOptions } from '@hub/contracts';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { scanWorkflowWithCore } from './scanner-core-adapter.js';

export type ScanRequest = { workflow: unknown };
export type ScanWorkerOutcome =
  | { ok: true; defaultResult: unknown; hardenedResult: unknown }
  | { ok: false; error: string };

/**
 * The message handler as a pure function, importable outside a real worker
 * thread. `new Worker()` can only load this file's `.ts` extension when the
 * host process itself carries a TS loader hook (tsx does; a plain `vitest`
 * process does not) — this export is what makes the parsing/limit-enforcement
 * logic testable without depending on that.
 *
 * AUDIT-SCAN-002: `workflow` must be the raw source (a JSON string, or a
 * plain JS value one `JSON.stringify` away from that same source) so this
 * parse is the single authoritative one. An already-*normalized*
 * `NormalizedWorkflow` must never be sent here — normalization has already
 * replaced malformed structures (e.g. a non-object `parameters` coerced to
 * `{}`), so reserializing and reparsing it can never reconstruct the parser
 * diagnostics the true first parse would have produced.
 */
export function handleScanRequest({ workflow }: ScanRequest): ScanWorkerOutcome {
  try {
    const json = typeof workflow === 'string' ? workflow : JSON.stringify(workflow);
    const parsed = parseWorkflowJson(json, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
    if (!parsed.ok) throw new Error(`workflow did not parse: ${parsed.code}`);
    const defaultResult = scanWorkflowWithCore(parsed.workflow, { policyProfile: 'beta-default' });
    const hardenedResult = scanWorkflowWithCore(parsed.workflow, { policyProfile: 'beta-hardened' });
    return { ok: true, defaultResult, hardenedResult };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

if (parentPort) {
  parentPort.once('message', (request: ScanRequest) => {
    try {
      parentPort?.postMessage(handleScanRequest(request));
    } finally {
      parentPort?.close();
    }
  });
}
