import Link from 'next/link';
import type { Route } from 'next';
import { toNormalizedTag, type SearchDisplayItem } from '@hub/contracts';
import { detailHref, isClientRoutable } from '../catalogue/detail-href';
import { sitePath } from './site-url.mjs';
import { GradeBadge, toGrade } from './grade-badge';
import { CARD_MIN_CONTENT_HEIGHT } from './row-offsets';

export type ResultCardItem = SearchDisplayItem;
export type ResultCardProps = {
  item: ResultCardItem;
  isHighlighted?: boolean;
  activeDescendantId?: string;
};

function Chip({ label, muted = false }: { label: string; muted?: boolean }) {
  return (
    <span
      className={`whitespace-nowrap rounded-control border border-hairline px-2 py-0.5 font-mono text-[11px] ${
        muted ? 'text-ink-faint' : 'bg-raised text-ink-muted'
      }`}
    >
      {label}
    </span>
  );
}

/**
 * One result row.
 *
 * A scanning surface, not a card wall: a hairline rule between rows rather than
 * a filled plate around each one, so a screenful of results reads as a list you
 * run your eye down. Counts are mono and tabular, right-aligned in a fixed
 * column, so the digits line up between rows instead of jittering with the
 * title length.
 */
export function ResultCard({ item, isHighlighted = false, activeDescendantId }: ResultCardProps) {
  const { id, slug, title, summary, grade, nodeCount = 0 } = item;

  const trigger = toNormalizedTag('trigger', item.triggers[0] ?? 'unknown', 0).label;
  const displayIntegrations = item.integrations.slice(0, 4);
  const remainingCount = item.integrations.length - displayIntegrations.length;
  const isLinkOnly = item.rights === 'link_only';
  // Next's Link applies its configured basePath; a raw anchor needs sitePath.
  // Only the 250 Next-rendered pages have the RSC payload its router fetches,
  // so everything else takes an anchor rather than prefetching two 404s.
  const routable = isClientRoutable({ isPrerendered: item.isPrerendered });
  const rawHref = detailHref({ id, slug });
  const targetHref = routable ? rawHref : sitePath(rawHref);
  const titleClassName = 'inline-flex min-h-11 max-w-full items-center rounded-control px-2 -ml-2 text-sm font-semibold text-ink transition-colors hover:text-accent-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-border active:text-accent-text md:text-base';
  const titleContent = (
    <>
      <span className="line-clamp-1">{title}</span>
      {/* Stretched so the whole row is the target, while the accessible
          name stays the title alone. */}
      <span className="absolute inset-0" aria-hidden="true" />
    </>
  );
  const sourceRepo = item.sourceRepo?.trim() || 'Source unavailable';

  return (
    <article
      id={activeDescendantId}
      style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${CARD_MIN_CONTENT_HEIGHT}px` }}
      className={`group relative flex min-h-[92px] flex-col justify-between gap-2 border-b border-hairline px-1 py-3 transition-colors last:border-0 hover:bg-raised md:flex-row md:items-center md:gap-6 md:px-2 ${
        isHighlighted ? 'bg-raised ring-2 ring-accent-border' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        {routable
          ? <Link href={targetHref as Route} className={titleClassName}>{titleContent}</Link>
          : <a href={targetHref} className={titleClassName}>{titleContent}</a>}

        <p className="mt-0.5 line-clamp-2 max-w-3xl text-xs leading-5 text-ink-muted">
          {summary || 'No overview description available for this workflow.'}
        </p>

        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {displayIntegrations.map((chip) => (
            <Chip key={chip} label={toNormalizedTag('integration', chip, 0).label} />
          ))}
          {remainingCount > 0 && <Chip label={`+${remainingCount}`} muted />}
          {item.tags.map((tag) => (
            <Chip key={tag} label={toNormalizedTag('intent', tag, 0).label} muted />
          ))}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 md:w-56 md:flex-col md:items-end">
        <GradeBadge grade={toGrade(grade)} compact />
        {/* Each value keeps its own element rather than being interpolated into
            one string: a label that only exists as part of a larger text node
            cannot be found by a test, or by anything else that reads the DOM. */}
        <p className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-ink-faint">
          <span>{nodeCount} nodes</span>
          <span aria-hidden="true">·</span>
          <span>{trigger}</span>
        </p>
        <p className="flex items-center gap-1.5 font-mono text-[11px] text-ink-faint">
          <span>{isLinkOnly ? 'Link-only' : 'Redistributable'}</span>
          <span aria-hidden="true" className="hidden sm:inline">·</span>
          <span className="hidden sm:inline">{sourceRepo}</span>
        </p>
      </div>
    </article>
  );
}
