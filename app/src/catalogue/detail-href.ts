export type DetailLinkInput = {
  id: string;
  slug: string;
  /** Whether Next pre-rendered this page. No longer decides the route; see below. */
  isPrerendered?: boolean;
};

/**
 * Where a reader goes to read about this workflow.
 *
 * This used to branch on `isPrerendered`, sending anything Next had not built
 * to the client shell at `/w/view/?id=`. That was correct while 250 slugs had a
 * page. Since `scripts/generate-lean-pages.tsx` writes one for every entry,
 * branching would leave 12,971 pages reachable by a crawler and by nobody
 * clicking through the site.
 *
 * The two tiers still differ in what the page contains — the pre-rendered one
 * carries an interactive canvas — but not in where it lives.
 */
export function detailHref(item: DetailLinkInput): string {
  return `/w/${encodeURIComponent(item.slug)}/`;
}

/**
 * The client shell, which loads an entry by id and hydrates the canvas.
 *
 * Now a destination rather than a fallback: the statically rendered pages link
 * here for the canvas, the readiness checklist and the full findings.
 *
 * `relatedIds` carries the caller's already-correct `computeRelated` output
 * (build-time, full-catalogue) so the client shell can show related workflows
 * without re-fetching the catalogue or a search index — see `view-client.tsx`
 * and `entry-detail-client.ts`'s byte-addressed per-entry fetch, which it reuses
 * for each related id.
 */
export function interactiveHref(id: string, relatedIds: readonly string[] = []): string {
  const related = Array.from(new Set(relatedIds)).filter((candidate) => candidate && candidate !== id);
  const base = `/w/view/?id=${encodeURIComponent(id)}`;
  return related.length > 0 ? `${base}&related=${related.map((candidate) => encodeURIComponent(candidate)).join(',')}` : base;
}

/**
 * Whether Next's client router can navigate to a workflow page without a
 * document load.
 *
 * Only the 250 pages Next pre-rendered have the RSC payload its router fetches
 * — `index.txt` and `__next._tree.txt` beside the HTML. For the other 12,971
 * those files do not exist, so `next/link` prefetches two 404s per card on
 * every hydrated page that lists results, and a click pays a failed request
 * before falling back to the document load it needed anyway.
 *
 * Callers use a plain anchor when this is false. The saved transition is worth
 * less than the requests it costs: 1.9% of the catalogue is client-routable,
 * and a static export's pages are small.
 */
export function isClientRoutable(item: Pick<DetailLinkInput, 'isPrerendered'>): boolean {
  return item.isPrerendered === true;
}
