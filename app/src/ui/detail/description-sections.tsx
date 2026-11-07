import type { GeneratedDescription } from '@hub/contracts';

function cleanStep(step: string): string {
  return step.trim().replace(/^(?:step\s*)?\d+\s*[.)\-:]\s*/i, '');
}

export function DescriptionSections({ content }: { content: GeneratedDescription }) {
  return (
    <div className="space-y-6 text-base leading-7 text-ink-muted">
      <h3 className="font-display text-xl font-semibold text-ink">{content.headline}</h3>
      <p>{content.outcome}</p>
      <section aria-labelledby="before-after-heading" className="rounded-lg border border-hairline bg-raised p-4">
        <h4 id="before-after-heading" className="font-display text-lg font-semibold text-ink">Before and after</h4>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div><dt className="text-xs font-mono uppercase tracking-wide text-ink-faint">Before</dt><dd>{content.beforeAfter.before}</dd></div>
          <div><dt className="text-xs font-mono uppercase tracking-wide text-ink-faint">After</dt><dd>{content.beforeAfter.after}</dd></div>
        </dl>
      </section>
      <aside role="note" aria-label="Example scenario" className="rounded-lg border border-accent-border/40 bg-accent/10 p-4 text-ink">
        {content.exampleScenario}
      </aside>
      <section aria-labelledby="how-it-works-heading">
        <h4 id="how-it-works-heading" className="font-display text-lg font-semibold text-ink">How it works</h4>
        <ol aria-label="How it works" className="mt-3 list-decimal space-y-2 pl-5">
          {content.howItWorks.map((step, index) => <li key={`${index}-${step}`}>{cleanStep(step)}</li>)}
        </ol>
      </section>
      <section aria-labelledby="limitations-heading">
        <h4 id="limitations-heading" className="font-display text-lg font-semibold text-ink">What to keep in mind</h4>
        <ul className="mt-3 list-disc space-y-2 pl-5">{content.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>
      <section aria-labelledby="audience-heading">
        <h4 id="audience-heading" className="font-display text-lg font-semibold text-ink">Who this is for</h4>
        <p className="mt-2">{content.audience}</p>
      </section>
    </div>
  );
}
