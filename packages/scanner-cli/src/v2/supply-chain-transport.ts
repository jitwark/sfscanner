import { SnapshotBodyLimitError, type SnapshotTransportV1 } from './supply-chain-fetch.js';
import { snapshotPinReason, type SnapshotPinV1 } from './supply-chain-snapshot.js';

/** Host-only wire adapter. Call only after the release-owned receipt admits this pin.
 * No environment proxy, caller URL, package name, credential, redirect or retry is sent.
 */
export function createPinnedSnapshotTransport(pin: SnapshotPinV1): SnapshotTransportV1 {
  if (snapshotPinReason(pin) !== undefined) throw new TypeError('Invalid admitted snapshot pin');
  const url = pin.url;
  const hostname = new URL(url).hostname;
  return async (request) => {
    if (request.url !== url || new URL(request.url).hostname !== hostname
      || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 5 * 1024 * 1024) {
      throw new TypeError('Snapshot request differs from admitted transport bounds');
    }
    request.signal.throwIfAborted();
    const response = await fetch(url, {
      method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json' }, signal: request.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status, bytes: new Uint8Array() };
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > request.maxBytes)) {
      await response.body?.cancel();
      throw new SnapshotBodyLimitError('Snapshot body exceeds admitted byte bound');
    }
    if (response.body === null) return { status: 200, bytes: new Uint8Array() };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        request.signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        if (next.value.byteLength > request.maxBytes - size) throw new SnapshotBodyLimitError('Snapshot body exceeds admitted byte bound');
        size += next.value.byteLength;
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { status: 200, bytes };
    } finally {
      try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
  };
}
