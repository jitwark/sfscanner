import { sitePath } from '../ui/site-url.mjs';
import type { FacetDataPayload } from '@hub/contracts/facet-artifact';
import { expectedArtifact, verifyArtifactBytes } from './artifact-integrity';
import { getCachedFacets, setCachedFacets } from './index-cache';

export type FacetsFailureReason = 'unavailable' | 'http' | 'malformed' | 'absent' | 'incomplete' | 'stale';
export type FacetsFetchResult =
  | { ok: true; data: FacetDataPayload }
  | { ok: false; reason: FacetsFailureReason; retryable: boolean };

/**
 * Facets carry live filter counts and bitsets — never the corpus's document
 * universe (see `worker-engine-init.ts`, which reconciles ordinals from the
 * extended index instead, so a facets failure can never hide most of the
 * catalogue). What a facets failure *does* degrade is filtering, and that
 * degradation used to collapse into a bare `undefined`: no reason, no way
 * to tell "the artifact is genuinely absent" from "a corrupt cache entry"
 * from "the release's counts are stale." This reports which, and whether
 * retrying is worth it.
 *
 * `total` is also cross-checked against an independent count from the
 * release manifest — a facets payload can be internally schema-valid (its own
 * `ordinals.length === total`) while still describing far fewer documents
 * than the release actually ships, e.g. a stale artifact left over from a
 * partial rebuild. That looks like a normal, successful response unless
 * checked against an independent total.
 *
 * That independent total is the sum of the two search index artifacts'
 * `entryCount`s, NOT the manifest's `totalEntries`. Facets describe the
 * *searchable* universe (primary + extended, 12,923 in the current release);
 * `totalEntries` counts the whole catalogue (13,221), which includes entries
 * deliberately excluded from search. Comparing against `totalEntries` rejects
 * every well-formed facets payload in production.
 *
 * AUDIT-SEARCH-003: a correct `total` proves the payload describes the right
 * *count* of documents, not that its bytes belong to this release — a CDN
 * edge or cache mixing releases can serve a `facets.json` that is schema-
 * valid and even total-correct by coincidence while a filter's counts or
 * bitsets are actually stale. The fetched bytes are therefore also bound to
 * the manifest's sha256 (and byteSize, checked first as a cheap short-
 * circuit — see `artifact-integrity.ts`), the same way the primary and
 * extended search indexes are bound. A mismatch here is `stale`, not
 * `malformed`: the payload parsed and validated fine, it just isn't this
 * release's, and — like `incomplete` — is worth retrying once a corrected
 * artifact is available.
 */
const SEARCH_INDEX_ARTIFACTS = ['search-index.json', 'search-index-extended.json'] as const;

function searchableEntryCount(manifest: { artifacts: readonly { path: string; entryCount?: number }[] }): number | undefined {
  let total = 0;
  for (const path of SEARCH_INDEX_ARTIFACTS) {
    const artifact = manifest.artifacts.find((candidate) => candidate.path === path);
    if (artifact?.entryCount === undefined) return undefined;
    total += artifact.entryCount;
  }
  return total;
}

export async function fetchFacetsResult(): Promise<FacetsFetchResult> {
  const { loadManifest } = await import('../catalogue/manifest');
  const manifest = await loadManifest().catch(() => undefined);
  const releaseSha = expectedArtifact(manifest, 'facets.json')?.sha256 ?? expectedArtifact(manifest, 'search-index.json')?.sha256;

  if (releaseSha) {
    const cached = await getCachedFacets(releaseSha);
    if (cached) {
      const expectedTotal = manifest ? searchableEntryCount(manifest) : undefined;
      if (expectedTotal === undefined || cached.total === expectedTotal) {
        return { ok: true, data: cached as FacetDataPayload };
      }
    }
  }

  let response: Response;
  try {
    response = await fetch(sitePath('/data/facets.json'));
  } catch {
    return { ok: false, reason: 'unavailable', retryable: true };
  }
  if (response.status === 404) return { ok: false, reason: 'absent', retryable: false };
  if (!response.ok) return { ok: false, reason: 'http', retryable: response.status >= 500 };

  let text: string;
  let data: FacetDataPayload;
  try {
    text = await response.text();
    const { parseFacetPayload } = await import('@hub/contracts/facet-artifact');
    data = parseFacetPayload(JSON.parse(text));
  } catch {
    return { ok: false, reason: 'malformed', retryable: false };
  }

  // Bytes first: a mismatch here means these bytes aren't this release's,
  // regardless of what the (possibly stale) `total` inside them says.
  const expectedBytes = expectedArtifact(manifest, 'facets.json');
  if (expectedBytes && (await verifyArtifactBytes(text, expectedBytes)) === 'mismatch') {
    return { ok: false, reason: 'stale', retryable: true };
  }

  const expectedTotal = manifest ? searchableEntryCount(manifest) : undefined;
  if (expectedTotal !== undefined && data.total !== expectedTotal) {
    return { ok: false, reason: 'incomplete', retryable: true };
  }

  if (releaseSha) {
    void setCachedFacets(releaseSha, data);
  }

  return { ok: true, data };
}

