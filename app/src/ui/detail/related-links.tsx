import { sitePath } from '../site-url.mjs';
import { detailHref } from '../../catalogue/detail-href';

/** A related workflow, reduced to what a link needs. */
export type RelatedLink = { id: string; slug: string; title: string };

/**
 * Related workflows as plain anchors.
 *
 * `RelatedRail` renders the same six links plus every integration and tag chip,
 * and measures 9 KB — 112 MB across the catalogue. Here the links carry the
 * crawl paths, and the chips are dropped: the hub and library pages already
 * publish them, and repeating them 12,923 times buys a crawler nothing it
 * cannot reach in one hop from the page it is already on.
 */
export function RelatedLinks({ links }: { links: readonly RelatedLink[] }) {
  if (links.length === 0) return null;

  return (
    <section aria-labelledby="related-heading" className="space-y-2">
      <h2 id="related-heading" className="border-b border-hairline pb-2 font-display text-lg font-semibold text-ink">
        Related workflows
      </h2>
      <ul className="space-y-1 text-sm">
        {links.map((link) => (
          <li key={link.id}>
            <a href={sitePath(detailHref(link))} className="break-words text-accent-text underline">{link.title}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}
