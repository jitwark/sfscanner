import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import type { RankedSearchDisplayItem } from './worker-messages';

/** Applies the public sort modes with a stable canonical ID tie-break. */
export function sortSearchResults(items: RankedSearchDisplayItem[], query: string, sort?: string): void {
  if (sort === 'quality') {
    items.sort((left, right) => (right.qualityScore || 0) - (left.qualityScore || 0) || compareCanonicalStrings(left.id, right.id));
    return;
  }
  if (query.trim()) {
    items.sort((left, right) => (right.score || 0) - (left.score || 0) || compareCanonicalStrings(left.id, right.id));
    return;
  }
  items.sort((left, right) => (right.qualityScore || 0) - (left.qualityScore || 0) || compareCanonicalStrings(left.id, right.id));
}
