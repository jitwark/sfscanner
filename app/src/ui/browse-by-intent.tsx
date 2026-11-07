import type { IntentFamily, IntentItem } from './intent-catalog';
import { sitePath } from './site-url.mjs';

type BrowseByIntentProps = { catalog: Record<IntentFamily, IntentItem[]> };

const families: Array<[IntentFamily, string]> = [
  ['integration', 'Integrations'], ['tag', 'Tags'], ['trigger', 'Triggers'],
  ['capability', 'Capabilities'], ['security', 'Security'], ['rights', 'Rights'],
];

export function BrowseByIntent({ catalog }: BrowseByIntentProps) {
  return (
    <section aria-labelledby="browse-by-intent-heading" className="space-y-5 border-t border-hairline pt-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="browse-by-intent-heading" className="text-2xl text-ink">Browse by intent</h2>
          <p className="mt-1 max-w-[62ch] text-sm text-ink-muted">Start with the services, patterns, and workflow signals that matter to you.</p>
        </div>
      </div>
      <div data-intent-rail className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 md:grid md:grid-cols-2 md:overflow-visible lg:grid-cols-3">
        {families.map(([family, title]) => <IntentGroup key={family} family={family} title={title} items={catalog[family]} />)}
      </div>
    </section>
  );
}

function IntentGroup({ family, title, items }: { family: IntentFamily; title: string; items: IntentItem[] }) {
  const headingId = `intent-${family}-heading`;
  return (
    <section aria-labelledby={headingId} className="min-w-[270px] snap-start border border-hairline bg-panel p-4 md:min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={headingId} className="font-display text-base font-semibold text-ink">{title}</h3>
        <a href={sitePath('/library/')} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control px-2 font-mono text-xs text-accent-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-border active:bg-raised active:text-accent-text">Explore all workflows</a>
      </div>
      <ul className="mt-3 space-y-1">
        {items.map((item) => (
          <li key={item.slug}>
            <a href={sitePath(item.href)} aria-label={`${item.label} ${item.count} workflows`} className="flex min-h-11 items-center justify-between gap-3 rounded-control px-2 text-sm text-ink-muted hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-border active:bg-raised active:text-accent-text">
              <span>{item.label}</span><span className="font-mono text-xs tabular-nums text-ink-faint">{item.count}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
