import { sitePath } from '../ui/site-url.mjs';
import type { Manifest } from '../catalogue/manifest';
import { expectedArtifact, verifyArtifactBytes } from './artifact-integrity';
import { evictStaleArtifacts, getCachedIndex, setCachedIndex } from './index-cache';
import {
  SearchIndexError,
  searchReleaseIdentityFromManifest,
  type OptionalSearchPayloadResult,
  type SearchIndexFailureKind,
  type VerifiedSearchIndex,
} from './fetch-index-helpers';

export {
  SearchIndexError,
  searchReleaseIdentityFromManifest,
  formatSearchReleaseIdentity,
  sameSearchReleaseIdentity,
  classifySearchError,
  type ProgressCallback,
  type SearchIndexFailureKind,
  type SearchReleaseIdentity,
  type VerifiedSearchIndex,
  type OptionalSearchPayloadFailureReason,
  type OptionalSearchPayloadResult,
} from './fetch-index-helpers';

async function parseIndex(text: string): Promise<string> {
  try {
    const { parseSearchIndexJson } = await import('@hub/contracts/search-index-artifact');
    parseSearchIndexJson(text);
    return text;
  } catch (cause) {
    if (cause instanceof SearchIndexError) throw cause;
    throw new SearchIndexError('malformed', 'Malformed search index', { cause });
  }
}

/**
 * Streams `search-index.json`, reporting bytes as they arrive.
 *
 * It is read through the body reader rather than with `response.text()` so the
 * library can show real progress: this is a 1.45 MB gzip download and a bare
 * spinner over it reads as a hang. When `content-length` is absent the stream
 * cannot be measured, so it falls back to a single read and reports completion
 * once — a progress bar that jumps 0 to 100 is honest; one that invents
 * intermediate values is not.
 */
export async function fetchSearchIndex(report: (loaded: number, total: number) => void): Promise<string> {
  if (typeof fetch !== 'function') throw new SearchIndexError('unavailable', 'Search index unavailable');
  let response: Response;
  try {
    response = await fetch(sitePath('/data/search-index.json'));
  } catch (cause) {
    throw new SearchIndexError('unavailable', 'Search index unavailable', { cause });
  }
  if (!response.ok) throw new SearchIndexError('http', `search-index.json failed (${response.status})`);

  const total = Number(response.headers.get('content-length') ?? 0);
  if (!response.body || total <= 0) {
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw new SearchIndexError('unavailable', 'Search index could not be read', { cause });
    }
    report(total > 0 ? total : 1, total > 0 ? total : 1);
    return parseIndex(text);
  }

  try {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value) continue;
      chunks.push(part.value);
      loaded += part.value.byteLength;
      report(loaded, total);
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return parseIndex(new TextDecoder().decode(bytes));
  } catch (cause) {
    if (cause instanceof SearchIndexError) throw cause;
    throw new SearchIndexError('unavailable', 'Search index could not be read', { cause });
  }
}

/** Loads the manifest and rejects an index that is not a byte-for-byte member of that release. */
export async function fetchSearchIndexWithRelease(report: (loaded: number, total: number) => void): Promise<VerifiedSearchIndex> {
  const [{ loadManifest }, { sha256 }, { bytesToHex }] = await Promise.all([
    import('../catalogue/manifest'),
    import('@noble/hashes/sha2.js'),
    import('@noble/hashes/utils.js'),
  ]);
  let manifest: Manifest;
  try {
    manifest = await loadManifest();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    const kind: SearchIndexFailureKind = /Malformed manifest|schemaVersion|unsupported/i.test(message)
      ? 'schema'
      : /Failed to load manifest: \d+/.test(message) ? 'http' : 'unavailable';
    throw new SearchIndexError(kind, 'Search release manifest unavailable', { cause });
  }
  const identity = searchReleaseIdentityFromManifest(manifest);
  const cached = await getCachedIndex(identity.searchIndexSha256);
  if (cached) {
    report(1, 1);
    return { indexJson: cached, identity };
  }
  const indexJson = await fetchSearchIndex(report);
  if (bytesToHex(sha256(new TextEncoder().encode(indexJson))) !== identity.searchIndexSha256) {
    throw new SearchIndexError('stale-release', 'Search index does not belong to the loaded release', undefined, identity);
  }
  void setCachedIndex(identity.searchIndexSha256, indexJson);
  void evictStaleArtifacts(identity.searchIndexSha256);
  return { indexJson, identity };
}

/**
 * The extended tier: everything beyond the content-indexed top 2,000.
 *
 * Fetched after the primary index is answering, never before — it exists so the
 * whole catalogue is findable, not so the first search is slower. Returns a
 * tagged result so the lifecycle can distinguish retryable absence/transport
 * failure from malformed data without failing the primary search.
 */
export async function fetchExtendedIndex(): Promise<OptionalSearchPayloadResult> {
  try {
    if (typeof fetch !== 'function') return { ok: false, reason: 'unavailable', retryable: true };
    let response: Response;
    try {
      response = await fetch(sitePath('/data/search-index-extended.json'));
    } catch {
      return { ok: false, reason: 'unavailable', retryable: true };
    }
    if (response.status === 404) return { ok: false, reason: 'absent', retryable: false };
    if (!response.ok) return { ok: false, reason: 'http', retryable: response.status >= 500 };
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { ok: false, reason: 'unavailable', retryable: true };
    }
    const { parseSearchIndexJson } = await import('@hub/contracts/search-index-artifact');
    parseSearchIndexJson(text);

    // Schema-valid does not mean "belongs to this release" — a mismatched CDN
    // edge or cache can serve a stale-but-well-formed extended index. Skip
    // the check (accept unverified) rather than hard-block whenever the
    // manifest can't say what this artifact should be.
    const { loadManifest } = await import('../catalogue/manifest');
    const manifest = await loadManifest().catch(() => undefined);
    const expected = expectedArtifact(manifest, 'search-index-extended.json');
    if (expected && (await verifyArtifactBytes(text, expected)) === 'mismatch') {
      return { ok: false, reason: 'stale-release', retryable: true };
    }

    return { ok: true, json: text };
  } catch {
    return { ok: false, reason: 'malformed', retryable: false };
  }
}
