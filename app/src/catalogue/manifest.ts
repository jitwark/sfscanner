import { sitePath } from '../ui/site-url.mjs';
import {
  parseReleaseManifest,
  type ReleaseManifest,
  type ReleaseManifestArtifact,
} from '@hub/contracts/release-manifest';

export { MANIFEST_SCHEMA_VERSION } from '@hub/contracts/release-manifest';
export type ManifestArtifact = ReleaseManifestArtifact;
export type Manifest = ReleaseManifest;

let cachedManifestPromise: Promise<Manifest> | null = null;

export function loadManifest(): Promise<Manifest> {
  if (!cachedManifestPromise) {
    const request = fetch(sitePath('/data/manifest.json')).then((res) => {
      if (!res.ok) {
        throw new Error(`Failed to load manifest: ${res.status} ${res.statusText}`);
      }
      return res.json().then(parseManifest);
    });
    cachedManifestPromise = request;
    void request.catch(() => {
      if (cachedManifestPromise === request) cachedManifestPromise = null;
    });
  }
  return cachedManifestPromise;
}

export function parseManifest(value: unknown): Manifest {
  return parseReleaseManifest(value);
}

/**
 * Test-only: clears the cached manifest promise so each test starts cold.
 *
 * No production caller exists (AUDIT-SEARCH-004 / R3-F3) — `loadManifest()`'s
 * cache above is scoped to the page load and is never invalidated during a
 * live session. That is deliberate, not a gap: this is a static export with
 * no service worker, so a real release change is only observable after a full
 * reload, which already re-executes this module from a blank slate. What
 * actually guards a moved release is checked on arrival instead —
 * `fetchSearchIndexWithRelease` and `fetchExtendedIndex`
 * (`src/search/fetch-index.ts`) hash-verify each fetched artifact against the
 * manifest that named it, before accepting it.
 */
export function resetManifestCache(): void {
  cachedManifestPromise = null;
}


/** Legacy helper retained for callers that only need deterministic test data. */
export function shardForId(id: string, shardCount: number): number {
  if (shardCount <= 0 || !Number.isFinite(shardCount)) {
    return 0;
  }
  const hexPrefix = id.slice(0, 4);
  const parsed = parseInt(hexPrefix, 16);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return parsed % shardCount;
}
