import type { Entry } from '@hub/contracts';
import { Chip } from './primitives/chip';
import { sitePath } from './site-url.mjs';
import { detailHref } from '../catalogue/detail-href';

type RelatedRailProps = { entry: Entry; related: Entry[] };

/**
 * `min-w-0` is load-bearing here, not decoration.
 *
 * This rail lives in a 20rem grid track. A grid item's default `min-width:auto`
 * refuses to shrink below its content, so a single long workflow title pushed
 * the track to 505px and put 129px of horizontal scroll on every detail page
 * wide enough to show the two-column layout. The title is clamped for the same
 * reason.
 */
export function RelatedRail({ entry, related }: RelatedRailProps) {
  const visibleRelated = eligibleRelated(entry, related);

  return (
    <aside aria-labelledby="related-heading" className="flex min-w-0 flex-col gap-8">
      <section className="flex min-w-0 flex-col gap-3">
        <h2 id="related-heading" className="border-b border-hairline pb-2 font-display text-lg font-semibold text-ink">
          Related workflows
        </h2>
        <div className="grid min-w-0 gap-px overflow-hidden rounded-panel border border-hairline bg-hairline">
          {visibleRelated.map((item) => (
            // An anchor, not a `Link`: Next's router prefetches an RSC payload
            // that only the 250 pre-rendered pages have, and this rail would ask
            // for six 404s on every detail page. An anchor needs sitePath.
            <a
              key={item.id}
              href={sitePath(detailHref(item))}
              className="group flex min-h-11 min-w-0 flex-col justify-center bg-panel px-3 py-2.5 transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-border"
            >
              <span className="line-clamp-2 text-sm font-medium text-ink group-hover:text-accent-text">{item.title}</span>
              <span className="mt-0.5 truncate font-mono text-2xs text-ink-faint">
                {item.structure?.integrations?.slice(0, 2).join(' · ') || item.structure?.trigger || ''}
              </span>
            </a>
          ))}
          {visibleRelated.length === 0 && (
            <p className="bg-panel px-3 py-2.5 text-sm text-ink-muted">No related workflows are available yet.</p>
          )}
        </div>
      </section>
      <section className="flex min-w-0 flex-col gap-3">
        <h2 className="border-b border-hairline pb-2 font-display text-lg font-semibold text-ink">Explore this workflow</h2>
        <div className="flex flex-wrap gap-2">
          {/* Library filters, not hub pages. A hub only exists for a value
              with enough published entries behind it, so `/integrations/agent/`
              was a 404 on every workflow that used an unhubbed integration —
              and widening search past the rights gate made many more of those
              reachable. A filtered library view exists for every value by
              construction, and shows the matches immediately. */}
          {entry.structure.integrations.map((integration) => (
            <Chip key={`integration-${integration}`} href={sitePath(`/library/?integration=${encodeURIComponent(toSlug(integration))}`)}>
              {integration}
            </Chip>
          ))}
          {entry.tags.map((tag) => (
            <Chip key={`tag-${tag}`} href={sitePath(`/library/?tag=${encodeURIComponent(toSlug(tag))}`)}>
              #{tag}
            </Chip>
          ))}
        </div>
      </section>
    </aside>
  );
}

function eligibleRelated(entry: Entry, related: readonly Entry[]): Entry[] {
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  const eligible: Entry[] = [];

  for (const item of related) {
    if (!item.id.trim() || !item.slug.trim() || item.id === entry.id || item.slug === entry.slug) continue;
    if (seenIds.has(item.id) || seenSlugs.has(item.slug)) continue;
    seenIds.add(item.id);
    seenSlugs.add(item.slug);
    eligible.push(item);
    if (eligible.length === 6) break;
  }

  return eligible;
}

function toSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
