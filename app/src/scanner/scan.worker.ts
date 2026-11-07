import { DEFAULT_SCANNER_LIMITS, toWorkflowParseOptions } from '@hub/contracts';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { scanWorkflowV2, type ScanWorkflowV2FailureCode } from '@hub/scanner-core/v2';
import { validateScannerResultV2, type ScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import { scanWorkflow, type ScanWorkflowResult } from './engine';
import { mapTooComplexReason, tryCountRawNodes, type ScanErrorDetails, type TooComplexReason } from './scan-worker-error-mapping';
export type { ScanErrorDetails } from './scan-worker-error-mapping';
export type ScanErrorCode =
  | 'TOO_LARGE'
  | TooComplexReason
  | 'INVALID_JSON'
  | 'NOT_A_WORKFLOW'
  | 'INTERNAL'
  /** Host-side only: the worker never emits this itself, the deadline in run-scan.ts does. */
  | 'TIMEOUT';

export type ScanWorkerRequest =
  | {
      kind: 'scan';
      id: string;
      json: string;
      profile: 'beta-default' | 'beta-hardened';
      approvedDomains?: string[];
    }
  | {
      kind: 'scan-v2';
      id: string;
      json: string;
      profile: 'beta-default';
      approvedDomains?: string[];
    };

export type ScanWorkerResponse =
  | { kind: 'progress'; id: string; phase: 'parse' | 'analyse' | 'render'; pct: number }
  | { kind: 'result'; id: string; result: ScanWorkflowResult }
  | { kind: 'result-v2'; id: string; result: ScannerResultV2 }
  | { kind: 'error'; id: string; code: ScanErrorCode; message: string; details?: ScanErrorDetails }
  | { kind: 'error-v2'; id: string; code: ScanWorkflowV2FailureCode | 'INTERNAL'; message: string };

export const MAX_BYTES = DEFAULT_SCANNER_LIMITS.maxBytes;
export const MAX_NODES = DEFAULT_SCANNER_LIMITS.maxNodes;

type PlainRecord = Record<string, unknown>;
function plainRecord(value: unknown): PlainRecord | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
    }
    return value as PlainRecord;
  } catch {
    return undefined;
  }
}
function closedRecord(value: PlainRecord, allowed: readonly string[], required: readonly string[]): boolean {
  return Object.getOwnPropertyNames(value).every((name) => allowed.includes(name)) && required.every((name) => Object.hasOwn(value, name));
}
function stringArray(value: unknown): value is string[] {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}
/** Both payload-limit rejections, so the code/message pair has one definition. */
function payloadLimitRejection(id: string, v2: boolean): ScanWorkerResponse {
  const message = `Workflow JSON exceeds the ${MAX_BYTES}-byte payload limit.`;
  return v2
    ? { kind: 'error-v2', id, code: 'WORKFLOW_TOO_LARGE', message }
    : { kind: 'error', id, code: 'TOO_LARGE', message };
}
function isWorkerRequest(value: unknown): value is ScanWorkerRequest {
  const record = plainRecord(value);
  if (!record || typeof record.kind !== 'string') return false;
  if (record.kind !== 'scan' && record.kind !== 'scan-v2') return false;
  return closedRecord(record, ['kind', 'id', 'json', 'profile', 'approvedDomains'], ['kind', 'id', 'json', 'profile'])
    && typeof record.id === 'string'
    && typeof record.json === 'string'
    && (record.kind === 'scan-v2' ? record.profile === 'beta-default' : record.profile === 'beta-default' || record.profile === 'beta-hardened')
    && stringArray(record.approvedDomains);
}
function handleScanRequest(
  id: string,
  json: string,
  profile: 'beta-default' | 'beta-hardened',
  approvedDomains?: string[],
): void {
  try {
    // `json.length` is a lower bound on the UTF-8 byte count, so the obvious
    // rejection needs no encode; the second guard measures the exact bytes.
    if (json.length > MAX_BYTES) { postMessage(payloadLimitRejection(id, false)); return; }
    if (new TextEncoder().encode(json).length > MAX_BYTES) { postMessage(payloadLimitRejection(id, false)); return; }

    postMessage({ kind: 'progress', id, phase: 'parse', pct: 25 } satisfies ScanWorkerResponse);

    const parsed = parseWorkflowJson(json, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
    if (!parsed.ok) {
      let code: ScanErrorCode = 'INVALID_JSON';
      let details: ScanErrorDetails | undefined;
      if (parsed.code === 'WORKFLOW_TOO_LARGE') {
        code = 'TOO_LARGE';
      } else if (parsed.code === 'WORKFLOW_TOO_COMPLEX') {
        code = mapTooComplexReason(parsed.cause);
        if (code === 'TOO_MANY_NODES') {
          const observedNodeCount = tryCountRawNodes(json);
          if (observedNodeCount !== undefined) details = { observedNodeCount };
        }
      } else if (parsed.code === 'MALFORMED_WORKFLOW') {
        code = 'NOT_A_WORKFLOW';
      }

      postMessage({
        kind: 'error',
        id,
        code,
        message: parsed.message,
        ...(details ? { details } : {}),
      } satisfies ScanWorkerResponse);
      return;
    }

    if (parsed.workflow.nodeCount > MAX_NODES || parsed.workflow.nodes.length > MAX_NODES) {
      postMessage({
        kind: 'error',
        id,
        code: 'TOO_MANY_NODES',
        message: `Workflow exceeds the ${MAX_NODES}-node complexity limit.`,
        details: { observedNodeCount: parsed.workflow.nodeCount },
      } satisfies ScanWorkerResponse);
      return;
    }

    postMessage({ kind: 'progress', id, phase: 'analyse', pct: 60 } satisfies ScanWorkerResponse);

    // An empty allowlist disables the unapproved-domain policy entirely, so only
    // forward a list the user actually supplied.
    const result = scanWorkflow(parsed.workflow, {
      policyProfile: profile,
      ...(approvedDomains && approvedDomains.length > 0 ? { approvedDomains } : {}),
    });

    postMessage({ kind: 'progress', id, phase: 'render', pct: 90 } satisfies ScanWorkerResponse);

    postMessage({ kind: 'result', id, result } satisfies ScanWorkerResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'An unexpected worker error occurred.';
    postMessage({
      kind: 'error',
      id,
      code: 'INTERNAL',
      message,
    } satisfies ScanWorkerResponse);
  }
}
/**
 * Cheap pre-walk gate for the v2 node budget.
 *
 * `scanWorkflowV2` reaches its node budget only inside `normalizeSecurityWorkflow`, after
 * `parseSourceDocument` has walked and span-recorded the whole document: measured in Chromium against the
 * shipped export, a 10,000-node export whose nodes carry `id`, `type` and `parameters` (589 KB) takes
 * 2.5-4.9 s from the click and exceeded the deadline once, and a realistically shaped one (1.05 MB,
 * `typeVersion` and `position` present) never returns before the host's worker deadline — the host
 * terminates the worker, so the user is told the scan timed out instead of that the document has too many
 * nodes. The v1 path has no such gap: `parseWorkflowJson` enforces the same budget in the pass that
 * validates the document.
 *
 * It fires only where the engine would itself report the same code, so it cannot steal a diagnosis from
 * another cause: the engine rejects over-budget bytes before parsing (`WORKFLOW_TOO_LARGE`), reports
 * `MALFORMED_WORKFLOW` unless the root's last `nodes` member is an array and its last `connections` member
 * an object, and sums the item count of *every* `nodes` member — one over-budget member already puts that
 * sum over budget, so counting the member JSON.parse keeps cannot under-report it.
 */
function nodeLimitRejection(json: string, bytes: Uint8Array): string | undefined {
  if (bytes.length > MAX_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined; // INVALID_JSON is the engine's diagnosis to make.
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const root = parsed as Record<string, unknown>;
  const nodes = root.nodes;
  const connections = root.connections;
  if (!Array.isArray(nodes)) return undefined;
  if (connections === null || typeof connections !== 'object' || Array.isArray(connections)) return undefined;
  return nodes.length > MAX_NODES ? `Workflow exceeds the ${MAX_NODES}-node complexity limit.` : undefined;
}

function handleScanV2Request(id: string, json: string, approvedDomains?: string[]): void {
  try {
    // Cheap guard first; the one encode below serves both the exact cap check
    // and the engine, so no second ≤1.5 MB allocation is introduced.
    if (json.length > MAX_BYTES) { postMessage(payloadLimitRejection(id, true)); return; }
    postMessage({ kind: 'progress', id, phase: 'parse', pct: 25 } satisfies ScanWorkerResponse);
    const bytes = new TextEncoder().encode(json);
    if (bytes.length > MAX_BYTES) { postMessage(payloadLimitRejection(id, true)); return; }
    const nodeLimitMessage = nodeLimitRejection(json, bytes);
    if (nodeLimitMessage !== undefined) {
      postMessage({ kind: 'error-v2', id, code: 'WORKFLOW_TOO_COMPLEX', message: nodeLimitMessage } satisfies ScanWorkerResponse);
      return;
    }
    const result = scanWorkflowV2({
      bytes,
      profile: { id: 'beta-default', version: '2.0.0' },
      ...(approvedDomains === undefined ? {} : { approvedDomains }),
    });
    if (!result.ok) {
      postMessage({ kind: 'error-v2', id, code: result.code, message: result.message } satisfies ScanWorkerResponse);
      return;
    }
    const checked = validateScannerResultV2(result.result);
    if (!checked.ok) {
      postMessage({
        kind: 'error-v2',
        id,
        code: 'INTERNAL',
        message: 'Scanner worker returned a malformed v2 result.',
      } satisfies ScanWorkerResponse);
      return;
    }
    postMessage({ kind: 'progress', id, phase: 'analyse', pct: 60 } satisfies ScanWorkerResponse);
    postMessage({ kind: 'progress', id, phase: 'render', pct: 90 } satisfies ScanWorkerResponse);
    postMessage({ kind: 'result-v2', id, result: checked.result } satisfies ScanWorkerResponse);
  } catch {
    postMessage({
      kind: 'error-v2',
      id,
      code: 'INTERNAL',
      message: 'An unexpected worker error occurred.',
    } satisfies ScanWorkerResponse);
  }
}

// The host owns cancellation: `cancelScan()` in `run-scan.ts` terminates this worker and resolves the
// run, so the worker protocol carries no cancel request and no cancelled response.
addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (!isWorkerRequest(data)) return;

  if (data.kind === 'scan') {
    handleScanRequest(data.id, data.json, data.profile, data.approvedDomains);
  } else {
    handleScanV2Request(data.id, data.json, data.approvedDomains);
  }
});
