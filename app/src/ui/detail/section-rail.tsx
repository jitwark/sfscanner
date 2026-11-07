export type DetailSection = {
  id: string;
  label: string;
  count?: number;
};

type SectionRailProps = {
  sections: DetailSection[];
};

export function SectionRail({ sections }: SectionRailProps) {
  // Paint containment keeps the intentionally wide mobile scroller from
  // contributing its scrollable overflow to the document itself.
  return (
    <nav aria-label="Workflow sections" className="min-w-0 overflow-x-hidden [contain:paint] lg:sticky lg:top-24">
      <p className="mb-2 hidden font-mono text-2xs uppercase tracking-[0.16em] text-ink-faint lg:block">
        Inspect
      </p>
      <div data-rail-scroll className="min-w-0 overflow-x-auto overscroll-x-contain pb-2 lg:overflow-visible lg:pb-0">
        <ol className="flex w-max min-w-full gap-2 lg:w-full lg:min-w-0 lg:flex-col">
          {sections.map((section) => (
            <li key={section.id} className="shrink-0 lg:w-full">
              <a
                href={`#${section.id}`}
                aria-label={`${section.label}${section.count !== undefined ? `, ${section.count} reported` : ''}`}
                className="flex min-h-11 items-center justify-between gap-3 rounded-control border border-hairline bg-panel px-3 font-mono text-xs text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-accent-border lg:w-full"
              >
                <span className="min-w-0 flex-1 break-words">{section.label}</span>
                {/* Keep the visible count in the accessible name instead of
                    replacing it with an aria-label on the count element. */}
                {section.count !== undefined && (
                  <span className="rounded-full bg-raised px-1.5 py-0.5 tabular-nums text-ink">
                    {section.count}
                    <span className="sr-only"> reported</span>
                  </span>
                )}
              </a>
            </li>
          ))}
        </ol>
      </div>
    </nav>
  );
}
