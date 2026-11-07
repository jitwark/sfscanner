import type { DescriptionProvenance, Entry } from '@hub/contracts';

type DescriptionProvenanceProps = Pick<Entry, 'descriptionSource' | 'descriptionProvenance'>;

export function DescriptionProvenance({ descriptionSource, descriptionProvenance }: DescriptionProvenanceProps) {
  const generated = descriptionSource === 'generated' && descriptionProvenance?.source === 'gemini';
  const label = generated
    ? 'AI-generated description'
    : descriptionSource === 'upstream'
      ? 'Upstream description'
      : descriptionSource === 'fallback'
        ? 'Fallback description'
        : 'Description provenance unknown';
  const detail = generated ? descriptionDetails(descriptionProvenance) : null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-ink-muted">
      <span className="rounded-full border border-hairline bg-raised px-2.5 py-1" aria-label={label}>{label}</span>
      {detail && <details className="group inline-block">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center rounded-control px-2 text-accent-text transition-colors marker:hidden hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border/50 active:bg-panel group-open:bg-raised group-open:text-ink">
          <span aria-hidden="true" className="mr-1.5 transition-transform group-open:rotate-90">›</span>
          Generation details
        </summary>
        <p className="mt-2 max-w-sm rounded-control border border-hairline bg-panel p-2 text-2xs leading-5 text-ink-muted">{detail}</p>
      </details>}
    </div>
  );
}

export function isDescriptionContentPublishable({ descriptionSource, descriptionProvenance }: DescriptionProvenanceProps): boolean {
  return descriptionSource === 'generated' && descriptionProvenance?.source === 'gemini';
}

function descriptionDetails(provenance?: DescriptionProvenance): string {
  const model = provenance?.model ?? 'model not recorded';
  const prompt = provenance?.promptVersion ? ` · prompt ${provenance.promptVersion}` : '';
  const generated = provenance?.generatedAt ? ` · ${provenance.generatedAt}` : '';
  return `Model: ${model}${prompt}${generated}`;
}
