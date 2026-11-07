import {
  readCliSource,
  type CliSource,
  type CliSourceReadResult,
  type CliStdin,
} from './cli-inputs.js';

/** Sentinel returned when an operation is interrupted before it completes. */
export const CLI_ABORTED = Symbol('CLI_ABORTED');
export type CliAborted = typeof CLI_ABORTED;

export function readCliSourceWithCancellation(
  source: CliSource,
  stdin: CliStdin | undefined,
  signal: AbortSignal | undefined,
): Promise<CliSourceReadResult | CliAborted> {
  return runCliOperation(
    () => readCliSource(source, stdin),
    signal,
    source.kind === 'stdin' && stdin === undefined ? () => process.stdin.destroy() : undefined,
  );
}

/**
 * Runs one process-boundary operation without leaving callers waiting on a
 * stream or worker that cannot observe an abort signal itself.
 */
export function runCliOperation<T>(
  start: () => Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T | CliAborted> {
  if (!signal) return start();
  if (signal.aborted) {
    onAbortSafely(onAbort);
    return Promise.resolve(CLI_ABORTED);
  }

  return new Promise<T | CliAborted>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      onAbortSafely(onAbort);
      resolve(CLI_ABORTED);
    };

    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }

    let operation: Promise<T>;
    try {
      operation = start();
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
      return;
    }
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function onAbortSafely(onAbort?: () => void): void {
  try { onAbort?.(); } catch { /* cleanup cannot prevent cancellation */ }
}
