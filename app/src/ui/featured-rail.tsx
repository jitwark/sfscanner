import Link from 'next/link';
import type { Entry } from '@hub/contracts';
import { detailHref } from '../catalogue/detail-href';
import { sitePath } from './site-url.mjs';
import { GradeBadge, toGrade } from './grade-badge';
import { CornerSquare } from './primitives/corner-square';

type FeaturedRailProps = { entries: Entry[] };

function sourceLabel(entry: Entry): string {
  return entry.source.kind === 'n8n_official' ? 'n8n.io' : entry.source.repo || 'GitHub';
}

/**
 * Featured workflows grid adhering to the engineering design specification.
 * Displays high-value curated workflows with direct run and inspection affordances.
 */
export function FeaturedRail({ entries }: FeaturedRailProps) {
  return (
    <section aria-labelledby="featured-heading" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-hairline pb-3">
        <div>
          <h2 id="featured-heading" className="font-sans text-2xl font-bold tracking-tight text-ink">
            Workflows worth opening
          </h2>
          <p className="mt-1 max-w-[62ch] text-sm leading-6 text-ink-muted">
            Selected by provenance, structure and scanner coverage — not by popularity.
          </p>
        </div>
        <Link
          href="/library/"
          prefetch={false}
          className="flex min-h-11 shrink-0 items-center rounded-control font-mono text-xs font-bold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-accent-border"
        >
          Browse all workflows
          <span aria-hidden="true" className="ml-1.5">→</span>
        </Link>
      </div>

      <div className="grid grid-cols-1 min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.slice(0, 12).map((entry) => {
          const targetHref = sitePath(detailHref(entry));
          return (
            <a
              key={entry.id}
              href={targetHref}
              className="group relative flex min-h-[160px] min-w-0 flex-col justify-between gap-4 rounded-panel border border-hairline bg-panel p-5 transition-colors hover:border-hairline-strong focus-visible:outline-2 focus-visible:outline-accent-border"
            >
              <CornerSquare position="top-left" size="sm" />
              <div className="min-w-0">
                <div className="mb-2.5 flex min-w-0 items-center justify-between gap-3 font-mono text-2xs tabular-nums text-ink-muted pl-2">
                  <span className="truncate">{sourceLabel(entry)}</span>
                  <span className="shrink-0">{entry.structure.nodeCount} nodes</span>
                </div>
                <h3 className="line-clamp-2 break-words font-sans text-base font-bold leading-snug text-ink group-hover:text-accent-text">
                  {entry.title}
                </h3>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                {entry.structure.integrations.slice(0, 3).map((integration) => (
                  <span
                    key={integration}
                    className="max-w-full truncate rounded-control border border-hairline bg-raised px-2 py-0.5 font-mono text-[11px] text-ink-muted"
                  >
                    {integration}
                  </span>
                ))}
                <GradeBadge grade={toGrade(entry.security.grade)} compact />
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}
