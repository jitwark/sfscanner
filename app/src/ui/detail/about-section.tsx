import type { Entry } from '@hub/contracts';
import { DescriptionProvenance, isDescriptionContentPublishable } from './description-provenance';
import { DescriptionSections } from './description-sections';

type AboutSectionProps = {
  entry: Entry;
  compact?: boolean;
};

export function AboutSection({ entry, compact = false }: AboutSectionProps) {
  const publishStructured = Boolean(entry.descriptionContent) && isDescriptionContentPublishable(entry);
  const publishPlain = entry.descriptionSource === 'upstream';

  return (
    <section aria-labelledby="about-heading" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="about-heading" className="font-display text-xl sm:text-2xl font-semibold text-ink">
          About this workflow
        </h2>
        <DescriptionProvenance
          descriptionSource={entry.descriptionSource}
          descriptionProvenance={entry.descriptionProvenance}
        />
      </div>

      {publishStructured && entry.descriptionContent ? (
        <div className={compact ? 'text-sm' : ''}>
          <DescriptionSections content={entry.descriptionContent} />
        </div>
      ) : publishPlain ? (
        <div className="whitespace-pre-line text-pretty text-sm sm:text-base leading-relaxed text-ink-muted">
          {entry.description}
        </div>
      ) : (
        <p role="status" className="rounded-md border border-hairline bg-raised p-3 text-xs sm:text-sm text-ink-muted">
          A publishable description is not available for this workflow. Unverified or fallback prose is not displayed.
        </p>
      )}
    </section>
  );
}
