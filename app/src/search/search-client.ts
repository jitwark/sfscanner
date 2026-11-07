export { onRankingImproved } from './semantic-vectors';
export {
  getFacetsState, getLoadedItem, getLoadedSearchReleaseIdentity, onFacetsStateChange, onProgress,
  retryFacets, search, warmIndex,
} from './search-client-runtime';
/**
 * Test-only: tears down worker/fallback/module state so each test starts cold.
 *
 * No production caller exists (AUDIT-SEARCH-004 / R3-F3) — the module state it
 * clears (`loadedIndexJson`, `loadedExtendedIndexJson`, etc., in
 * `search-client-runtime.ts`) is scoped to the page load, exactly like the
 * manifest cache `resetManifestCache` clears (`catalogue/manifest.ts`). This is
 * a static export with no service worker, so a release change is only
 * observable after a full reload, which already restarts every one of those
 * modules from a blank slate — there is no live-session path where this reset
 * would need to run. What actually guards a moved release is checked on
 * arrival: `fetchSearchIndexWithRelease` and `fetchExtendedIndex`
 * (`fetch-index.ts`) hash-verify each fetched artifact against the manifest
 * that named it, so a mismatched-release payload is rejected on arrival, not
 * cleared on reset.
 */
export { resetSearchClientState } from './search-client-runtime';
export type { FacetCounts } from './facet-bitset';
export type { SearchFilters } from './worker';
export type { SearchResultItem, SearchResponseData } from './search-client-query';
export type { ProgressCallback } from './fetch-index';
export type { FacetsState } from './facets-state';
export type { FacetsFailureReason } from './fetch-facets';
