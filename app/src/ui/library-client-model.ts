import type { FacetCounts, SearchFilters, SearchResultItem } from '../search/search-client';
import { readQueryState } from '../search/query-state';
import type { SearchReleaseIdentity } from '../search/fetch-index';
import type { LibraryItem } from './library-results';

export type Progress = { loaded: number; total: number };
export type LibraryClientProps = { initialItems: LibraryItem[]; initialCounts: FacetCounts; totalCount: number; initialReleaseIdentity?: SearchReleaseIdentity };
export const PAGE_SIZE = 24;
export const EMPTY_FILTERS: SearchFilters = { trigger: [], capability: [], complexity: '', grade: '', rights: '', integration: [], tag: [] };
export function toLibraryItemFromSearch(item: SearchResultItem): LibraryItem { return item; }
export function filtersFromState(state: ReturnType<typeof readQueryState>): SearchFilters {
  return { trigger: state.trigger, capability: state.capability, complexity: state.complexity, grade: state.grade, rights: state.rights, integration: state.integration, tag: state.tag };
}
