import {
  parseSvgPreviewArtifact,
  type SvgPreviewArtifact,
} from '@hub/contracts';
import {
  parseByteRangeIndex,
  type ByteRangeIndex,
  type ByteRangeIndexEntry,
} from '@hub/contracts/byte-range-index';
import { loadManifest } from './manifest';
import { sitePath } from '../ui/site-url.mjs';

type PreviewIndexEntry = ByteRangeIndexEntry;
type PreviewIndex = ByteRangeIndex;
const ARTIFACT_ID = /^[a-f0-9]{16}$/;

const previewIndexCache = new Map<string, Promise<PreviewIndex>>();

export type PreviewUnavailableReason =
  | 'not-found'
  | 'range-unsupported'
  | 'short-body'
  | 'hash-mismatch'
  | 'malformed'
  | 'network'
  | 'aborted';

export type PreviewResult =
  | { ok: true; preview: SvgPreviewArtifact }
  | { ok: false; reason: PreviewUnavailableReason };

export function clearPreviewCache(): void {
  previewIndexCache.clear();
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError';
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array<ArrayBuffer>(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function previewIndexArtifact(manifest: Awaited<ReturnType<typeof loadManifest>>, shard: number) {
  return manifest.artifacts.find((item) => item.path === `previews/preview-index-${shard}.json`);
}

function previewIndexCacheKey(manifest: Awaited<ReturnType<typeof loadManifest>>, shard: number): string | null {
  const artifact = previewIndexArtifact(manifest, shard);
  return artifact ? `${manifest.schemaVersion}:${manifest.generatedAt}:${artifact.sha256}:${shard}` : null;
}

function fetchPreviewIndex(
  shard: number,
  manifest: Awaited<ReturnType<typeof loadManifest>>,
  signal?: AbortSignal,
): Promise<PreviewIndex> {
  const key = previewIndexCacheKey(manifest, shard);
  const artifact = previewIndexArtifact(manifest, shard);
  const cached = key ? previewIndexCache.get(key) : undefined;
  if (cached) return cached;
  const promise = (async () => {
    const response = await fetch(sitePath(`/data/previews/preview-index-${shard}.json`), { signal });
    if (!response.ok) throw new Error(`Preview index unavailable: ${response.status}`);
    if (!artifact) return parseByteRangeIndex(await response.json());
    const bytes = new Uint8Array<ArrayBuffer>(await response.arrayBuffer());
    if (await sha256Hex(bytes) !== artifact.sha256) {
      throw new Error(`Preview index ${shard} failed its integrity check`);
    }
    return parseByteRangeIndex(JSON.parse(new TextDecoder().decode(bytes)));
  })();
  if (key) previewIndexCache.set(key, promise);
  if (key) promise.catch(() => {
    if (previewIndexCache.get(key) === promise) previewIndexCache.delete(key);
  });
  return promise;
}

type RangeAttempt =
  | { kind: 'success'; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'range-unsupported' }
  | { kind: 'aborted' }
  | { kind: 'transient'; reason: 'network' | 'short-body' };

async function attemptRangeRead(path: string, ref: PreviewIndexEntry, signal?: AbortSignal): Promise<RangeAttempt> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { Range: `bytes=${ref.offset}-${ref.offset + ref.length - 1}` },
      signal,
    });
  } catch (cause) {
    return isAbortError(cause) ? { kind: 'aborted' } : { kind: 'transient', reason: 'network' };
  }
  if (response.status === 200) {
    await Promise.resolve(response.body?.cancel()).catch(() => undefined);
    return { kind: 'range-unsupported' };
  }
  if (response.status !== 206) return { kind: 'transient', reason: 'network' };
  try {
    const bytes = new Uint8Array<ArrayBuffer>(await response.arrayBuffer());
    return bytes.byteLength === ref.length
      ? { kind: 'success', bytes }
      : { kind: 'transient', reason: 'short-body' };
  } catch (cause) {
    return isAbortError(cause) ? { kind: 'aborted' } : { kind: 'transient', reason: 'network' };
  }
}

async function readRange(path: string, ref: PreviewIndexEntry, signal?: AbortSignal): Promise<RangeAttempt> {
  const first = await attemptRangeRead(path, ref, signal);
  return first.kind === 'transient' ? attemptRangeRead(path, ref, signal) : first;
}

/** Fetches one validated preview line, never the whole preview shard. */
export async function loadPreviewById(id: string, signal?: AbortSignal): Promise<PreviewResult> {
  if (!ARTIFACT_ID.test(id)) return { ok: false, reason: 'not-found' };
  let manifest: Awaited<ReturnType<typeof loadManifest>>;
  try {
    manifest = await loadManifest();
  } catch (cause) {
    return isAbortError(cause) ? { ok: false, reason: 'aborted' } : { ok: false, reason: 'network' };
  }
  const shard = Object.hasOwn(manifest.catalogueShards, id) ? manifest.catalogueShards[id] : undefined;
  if (shard === undefined) return { ok: false, reason: 'not-found' };

  let index: PreviewIndex;
  try {
    index = await fetchPreviewIndex(shard, manifest, signal);
  } catch (cause) {
    return isAbortError(cause) ? { ok: false, reason: 'aborted' } : { ok: false, reason: 'network' };
  }
  const ref = Object.hasOwn(index, id) ? index[id] : undefined;
  if (!ref) return { ok: false, reason: 'not-found' };
  const previewArtifact = manifest.artifacts.find((artifact) => artifact.path === `previews/preview-${shard}.jsonl`);
  if (previewArtifact && ref.offset + ref.length > previewArtifact.byteSize) {
    return { ok: false, reason: 'malformed' };
  }

  const attempt = await readRange(sitePath(`/data/previews/preview-${shard}.jsonl`), ref, signal);
  if (attempt.kind === 'aborted') return { ok: false, reason: 'aborted' };
  if (attempt.kind === 'range-unsupported') return { ok: false, reason: 'range-unsupported' };
  if (attempt.kind === 'transient') return { ok: false, reason: attempt.reason };
  if (await sha256Hex(attempt.bytes) !== ref.sha256) return { ok: false, reason: 'hash-mismatch' };

  try {
    const parsed = parseSvgPreviewArtifact(JSON.parse(new TextDecoder().decode(attempt.bytes)));
    if (!parsed) return { ok: false, reason: 'malformed' };
    const actualSvgHash = await sha256Hex(new TextEncoder().encode(parsed.svg) as Uint8Array<ArrayBuffer>);
    return parsed.contentHash === actualSvgHash ? { ok: true, preview: parsed } : { ok: false, reason: 'hash-mismatch' };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
