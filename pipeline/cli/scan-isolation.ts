import { Worker } from 'node:worker_threads';
import type { CliScanOutcome, ScanCoreOptions } from './scan-core.js';
import type { CliScanWorkerResponse } from './scan-worker.js';

export type CliScanCancellation = {
  ok: false;
  kind: 'cancelled';
  code: 'TIMEOUT' | 'CANCELLED';
  message: string;
};

export type IsolatedCliScanOutcome = CliScanOutcome | CliScanCancellation;

export type ScanIsolationOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

const UNSAFE_WORKER_FLAGS = /^--(?:max[-_]old[-_]space[-_]size|max[-_]semi[-_]space[-_]size|max[-_]heap[-_]size|stack[-_]size)(?:=|$)/u;

export function scanJsonWithIsolation(
  json: string,
  options: ScanCoreOptions,
  isolation: ScanIsolationOptions = {},
): Promise<IsolatedCliScanOutcome> {
  if (isolation.signal?.aborted) return Promise.resolve(cancelled('CANCELLED'));

  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./scan-worker-bootstrap.mjs', import.meta.url), {
        execArgv: [...workerExecArgv(process.execArgv), '--conditions=import'],
      });
    } catch {
      resolve(internalFailure('Could not start the scanner worker.'));
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(cancelled('CANCELLED'));
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      isolation.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (outcome: IsolatedCliScanOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().catch(() => undefined).finally(() => resolve(outcome));
    };

    worker.once('message', (message: unknown) => {
      if (!isWorkerResponse(message)) {
        finish(internalFailure('Scanner worker returned an invalid response.'));
      } else if (message.kind === 'error') {
        finish(internalFailure(message.message));
      } else {
        finish(message.outcome);
      }
    });
    worker.once('error', () => finish(internalFailure('Scanner worker failed.')));
    worker.once('exit', (code) => {
      if (settled) return;
      finish(code === 0
        ? internalFailure('Scanner worker exited before returning a result.')
        : internalFailure(`Scanner worker exited with code ${code}.`));
    });

    if (isolation.signal) {
      isolation.signal.addEventListener('abort', onAbort, { once: true });
      if (isolation.signal.aborted) { onAbort(); return; }
    }
    if (isolation.timeoutMs !== undefined) {
      timer = setTimeout(() => finish(cancelled('TIMEOUT', isolation.timeoutMs)), isolation.timeoutMs);
    }

    try {
      worker.postMessage({ kind: 'scan', json, options });
    } catch {
      finish(internalFailure('Could not send the workflow to the scanner worker.'));
    }
  });
}

function workerExecArgv(execArgv: readonly string[]): string[] {
  const safe = execArgv.filter((flag) => !UNSAFE_WORKER_FLAGS.test(flag));
  return safe.some((flag) => flag === 'tsx/esm') ? safe : [...safe, '--import', 'tsx/esm'];
}

function isWorkerResponse(value: unknown): value is CliScanWorkerResponse {
  if (!value || typeof value !== 'object') return false;
  const message = value as { kind?: unknown; message?: unknown; outcome?: unknown };
  if (message.kind === 'error') return typeof message.message === 'string';
  return message.kind === 'result' && isCliScanOutcome(message.outcome);
}

function isCliScanOutcome(value: unknown): value is CliScanOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const outcome = value as { ok?: unknown; kind?: unknown; code?: unknown; message?: unknown; result?: unknown };
  if (outcome.ok === true) return Boolean(outcome.result) && typeof outcome.result === 'object';
  return outcome.ok === false && (outcome.kind === 'input' || outcome.kind === 'internal')
    && typeof outcome.code === 'string' && typeof outcome.message === 'string';
}

function cancelled(code: CliScanCancellation['code'], timeoutMs?: number): CliScanCancellation {
  return code === 'TIMEOUT'
    ? { ok: false, kind: 'cancelled', code, message: `Scan timed out after ${timeoutMs}ms; worker terminated.` }
    : { ok: false, kind: 'cancelled', code, message: 'Scan was cancelled; worker terminated.' };
}

function internalFailure(message: string): CliScanOutcome {
  return { ok: false, kind: 'internal', code: 'INTERNAL', message };
}
