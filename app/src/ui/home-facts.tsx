import Link from 'next/link';
import { CornerSquare } from './primitives/corner-square';

export type HomeFact = { label: string; value: string; detail?: string };

/**
 * Technical metric callout stats adhering to the engineering design specification.
 * Features 36px bold green tabular numbers, 2px radius, and signature corner squares.
 */
export function HomeFacts({ facts }: { facts: HomeFact[] }) {
  return (
    <section aria-label="Catalogue metrics" className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {facts.map((fact) => (
          <div
            key={fact.label}
            className="relative flex flex-col justify-between gap-1 rounded-panel border border-hairline bg-panel p-5"
          >
            <CornerSquare position="top-left" size="sm" />
            <dt className="font-mono text-2xs font-bold uppercase tracking-wider text-ink-muted pl-2">
              {fact.label}
            </dt>
            <dd className="font-sans text-3xl font-bold tabular-nums tracking-tight text-accent-text pt-1">
              {fact.value}
            </dd>
            {fact.detail && (
              <dd className="font-mono text-2xs text-ink-faint">
                {fact.detail}
              </dd>
            )}
          </div>
        ))}
      </dl>
      <div className="flex items-center justify-end px-1">
        <Link
          href="/analytics/"
          className="flex min-h-11 items-center rounded-control font-mono text-xs font-bold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-accent-border"
        >
          See how the catalogue breaks down
          <span aria-hidden="true" className="ml-1">→</span>
        </Link>
      </div>
    </section>
  );
}
