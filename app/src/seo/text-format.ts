/**
 * Small, shared string-formatting helpers used by title composition and
 * `hubMeta`'s slug-to-heading rendering. Split out of `page-meta.ts` (and,
 * with `entry-title.ts`, kept out of it) purely to stay under the 200-line
 * file cap — there is no behavioural reason these need to be separate.
 */

/** Truncate a string to maxLen on a word boundary. */
export function truncateWordBoundary(str: string, maxLen: number): string {
  if (!str || str.length <= maxLen) return str || '';
  const sub = str.slice(0, maxLen);
  const lastSpace = sub.lastIndexOf(' ');
  if (lastSpace > 0) {
    return sub.slice(0, lastSpace);
  }
  return sub;
}

/** `foo-bar` -> `Foo Bar`. Used for node-type-derived hub slugs and integration names. */
export function capitalize(s: string): string {
  if (!s) return '';
  return s
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
