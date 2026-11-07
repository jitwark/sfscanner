import type { Entry } from '@hub/contracts';
import { parseEntryJson } from '@hub/contracts/entry-artifact';
import {
  parseByteRangeIndex,
  type ByteRangeIndex,
  type ByteRangeIndexEntry,
} from '@hub/contracts/byte-range-index';
import { loadManifest } from './manifest';
import { sitePath } from '../ui/site-url.mjs';

type DetailIndexEntry = ByteRangeIndexEntry;
type DetailIndex = ByteRangeIndex;
const ARTIFACT_ID = /^[a-f0-9]{16}$/;

const detailIndexCache = new Map<string, Promise<DetailIndex>>();

/** Test-only reset, mirroring `shard-client.ts`'s `clearShardCache`. */
export function clearDetailIndexCache(): void {
  detailIndexCache.clear();
}

/**
 * Fetches and caches the per-shard offset/length/hash index (P1.7). This is a
 * few hundred KB, fetched at most once per shard per session — not the
 * 12–35 MB shard itself.
 */
function detailIndexArtifact(manifest: Awaited<ReturnType<typeof loadManifest>>, shard: number) {
  return manifest.artifacts.find((item) => item.path === `details/detail-index-${shard}.json`);
}

function detailIndexCacheKey(manifest: Awaited<ReturnType<typeof loadManifest>>, shard: number): string | null {
  const artifact = detailIndexArtifact(manifest, shard);
  return artifact ? `${manifest.schemaVersion}:${manifest.generatedAt}:${artifact.sha256}:${shard}` : null;
}

function fetchDetailIndex(shard: number, manifest: Awaited<ReturnType<typeof loadManifest>>): Promise<DetailIndex> {
  const key = detailIndexCacheKey(manifest, shard);
  const artifact = detailIndexArtifact(manifest, shard);
  const cached = key ? detailIndexCache.get(key) : undefined;
  if (cached) return cached;

  const promise = (async () => {
    const res = await fetch(sitePath(`/data/details/detail-index-${shard}.json`));
    if (!res.ok) throw new Error(`Failed to load detail index ${shard}: ${res.status}`);
    if (!artifact) return parseByteRangeIndex(await res.json());
    const bytes = new Uint8Array<ArrayBuffer>(await res.arrayBuffer());
    if (await sha256Hex(bytes) !== artifact.sha256) {
      throw new Error(`Detail index ${shard} failed its integrity check`);
    }
    return parseByteRangeIndex(JSON.parse(new TextDecoder().decode(bytes)));
  })();

  if (key) detailIndexCache.set(key, promise);
  // Same SW-3 rule as `shard-client.ts`'s `shardCache`: a rejection must not be
  // cached with the same lifetime as a success, or one dropped connection
  // makes the whole shard's entries unreachable until reload.
  if (key) promise.catch(() => { if (detailIndexCache.get(key) === promise) detailIndexCache.delete(key); });
  return promise;
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError';
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array<ArrayBuffer>(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

type RangeAttempt =
  | { kind: 'success'; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'range-unsupported' }
  | { kind: 'aborted' }
  | { kind: 'transient'; reason: 'network' | 'short-body' };

async function attemptRangeRead(path: string, ref: DetailIndexEntry, signal?: AbortSignal): Promise<RangeAttempt> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { Range: `bytes=${ref.offset}-${ref.offset + ref.length - 1}` }, signal });
  } catch (cause) {
    return isAbortError(cause) ? { kind: 'aborted' } : { kind: 'transient', reason: 'network' };
  }
  if (res.status === 200) {
    await Promise.resolve(res.body?.cancel()).catch(() => undefined);
    return { kind: 'range-unsupported' };
  }
  if (res.status !== 206) return { kind: 'transient', reason: 'network' };

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array<ArrayBuffer>(await res.arrayBuffer());
  } catch (cause) {
    return isAbortError(cause) ? { kind: 'aborted' } : { kind: 'transient', reason: 'network' };
  }
  if (bytes.byteLength !== ref.length) return { kind: 'transient', reason: 'short-body' };
  return { kind: 'success', bytes };
}

/** One bounded retry on a transient failure — never an unbounded fallback to the whole shard. */
async function readEntryBytes(path: string, ref: DetailIndexEntry, signal?: AbortSignal): Promise<RangeAttempt> {
  const first = await attemptRangeRead(path, ref, signal);
  return first.kind === 'transient' ? attemptRangeRead(path, ref, signal) : first;
}

export type EntryDetailReason =
  | 'not-found'
  | 'range-unsupported'
  | 'short-body'
  | 'hash-mismatch'
  | 'malformed'
  | 'network'
  | 'aborted';

export type EntryDetailResult = { ok: true; entry: Entry } | { ok: false; reason: EntryDetailReason };

/**
 * Bounded, byte-addressed replacement for reading a whole 12–35 MB catalogue
 * shard to find one entry (P1.7). Fetches the manifest (existing cost), then
 * at most a few hundred KB (the per-shard index, cached) plus the entry's own
 * few KB — never the shard.
 */
export async function loadEntryDetail(id: string, signal?: AbortSignal): Promise<EntryDetailResult> {
  if (!ARTIFACT_ID.test(id)) return { ok: false, reason: 'not-found' };
  const manifest = await loadManifest();
  const shard = Object.hasOwn(manifest.catalogueShards, id) ? manifest.catalogueShards[id] : undefined;
  if (shard === undefined) return { ok: false, reason: 'not-found' };

  let index: DetailIndex;
  try {
    index = await fetchDetailIndex(shard, manifest);
  } catch (cause) {
    return isAbortError(cause) ? { ok: false, reason: 'aborted' } : { ok: false, reason: 'network' };
  }
  const ref = Object.hasOwn(index, id) ? index[id] : undefined;
  if (!ref) return { ok: false, reason: 'not-found' };
  const detailArtifact = manifest.artifacts.find((artifact) => artifact.path === `details/detail-${shard}.jsonl`);
  if (detailArtifact && (!Number.isSafeInteger(detailArtifact.byteSize) || ref.offset + ref.length > detailArtifact.byteSize)) {
    return { ok: false, reason: 'malformed' };
  }

  const path = sitePath(`/data/details/detail-${shard}.jsonl`);
  const attempt = await readEntryBytes(path, ref, signal);
  if (attempt.kind === 'aborted') return { ok: false, reason: 'aborted' };
  if (attempt.kind === 'range-unsupported') return { ok: false, reason: 'range-unsupported' };
  if (attempt.kind === 'transient') return { ok: false, reason: attempt.reason };

  const hash = await sha256Hex(attempt.bytes);
  if (hash !== ref.sha256) return { ok: false, reason: 'hash-mismatch' };

  try {
    const parsed = parseEntryJson(new TextDecoder().decode(attempt.bytes));
    if (parsed.id !== id) {
      return { ok: false, reason: 'malformed' };
    }
    return { ok: true, entry: parsed };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

const ENTRY_DETAIL_ERROR_MESSAGES: Record<Exclude<EntryDetailReason, 'not-found'>, string> = {
  'range-unsupported': 'Unable to load workflow: the server did not support a partial read.',
  'short-body': 'Unable to load workflow: the connection was interrupted.',
  'hash-mismatch': 'Unable to load workflow: the data failed an integrity check.',
  malformed: 'Unable to load workflow: the response could not be read.',
  network: 'Unable to load workflow: a network error occurred.',
  aborted: 'Unable to load workflow: the request was cancelled.',
};

/**
 * Same signature as the whole-shard `fetchEntryById` it replaces, so
 * `view-client.tsx`'s null-or-thrown-message contract is unchanged.
 */
export async function fetchEntryById(id: string, signal?: AbortSignal): Promise<Entry | null> {
  const result = await loadEntryDetail(id, signal);
  if (result.ok) return result.entry;
  if (result.reason === 'not-found') return null;
  throw new Error(ENTRY_DETAIL_ERROR_MESSAGES[result.reason]);
}
