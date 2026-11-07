import { snapshotPinReason, validateSupplyChainSnapshot, type SnapshotPinV1, type SnapshotReasonV1, type SnapshotValidationV1 } from './supply-chain-snapshot';

export type SnapshotTransportRequestV1 = Readonly<{ url: string; signal: AbortSignal; timeoutMs: number; maxBytes: number }>;
export type SnapshotTransportResponseV1 = Readonly<{ status: number; bytes: Uint8Array }>;
export type SnapshotTransportV1 = (request: SnapshotTransportRequestV1) => Promise<SnapshotTransportResponseV1>;

export class SnapshotBodyLimitError extends Error {}

export type SnapshotFetchFailureV1 = Readonly<{
  ok: false;
  reason: 'CANCELLED' | 'TIMEOUT' | 'TRANSPORT_FAILED' | 'STATUS' | 'REDIRECT' | 'OVERSIZED' | SnapshotReasonV1;
}>;

/**
 * One fixed-host HTTPS request through an injected transport. This function performs no network,
 * DNS, redirect, retry, environment or package-name operation; the transport owns the wire.
 */
export async function fetchSupplyChainSnapshot(input: Readonly<{
  pin: SnapshotPinV1;
  transport: SnapshotTransportV1;
  signal?: AbortSignal;
  now: number;
  timeoutMs?: number;
  maxBytes?: number;
}>): Promise<SnapshotValidationV1 | SnapshotFetchFailureV1> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const maxBytes = input.maxBytes ?? 5 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 5 * 1024 * 1024) return Object.freeze({ ok: false, reason: 'TRANSPORT_FAILED' });
  const pinReason = snapshotPinReason(input.pin);
  if (pinReason !== undefined) return Object.freeze({ ok: false, reason: pinReason });
  if (input.signal?.aborted === true) return Object.freeze({ ok: false, reason: 'CANCELLED' });
  const controller = new AbortController();
  const abort = Promise.withResolvers<never>();
  const cancel = (): void => { controller.abort(); abort.reject(new Error('aborted')); };
  input.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => { controller.abort(); timeout.reject(new Error('timeout')); }, timeoutMs);
  try {
    const response = await Promise.race([
      input.transport({ url: input.pin.url, signal: controller.signal, timeoutMs, maxBytes }),
      timeout.promise,
      abort.promise,
    ]);
    if (response.status >= 300 && response.status < 400) return Object.freeze({ ok: false, reason: 'REDIRECT' });
    if (response.status !== 200) return Object.freeze({ ok: false, reason: 'STATUS' });
    if (!(response.bytes instanceof Uint8Array) || response.bytes.byteLength > maxBytes) return Object.freeze({ ok: false, reason: 'OVERSIZED' });
    return validateSupplyChainSnapshot(response.bytes, input.pin, input.now);
  } catch (error) {
    if (error instanceof SnapshotBodyLimitError) return Object.freeze({ ok: false, reason: 'OVERSIZED' });
    const cancelled = input.signal !== undefined && input.signal.aborted;
    return Object.freeze({ ok: false, reason: controller.signal.aborted ? (cancelled ? 'CANCELLED' : 'TIMEOUT') : 'TRANSPORT_FAILED' });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', cancel);
  }
}
