import type { CorpusAnalytics } from '@hub/contracts';
import { BarList } from './bar-list';

const SOURCE_LABEL: Record<string, string> = {
  github: 'GitHub repositories',
  n8n_official: 'n8n.io templates',
};

/** `n8n-nodes-base.googleSheets` is noise in a chart; `googleSheets` is the name. */
function shortNodeType(type: string): string {
  return type.replace(/^n8n-nodes-base\./, '').replace(/^@n8n\/n8n-nodes-langchain\./, 'AI · ');
}

export function SectionHeading({ id, title, aside }: { id: string; title: string; aside?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-hairline pb-2">
      <h2 id={id} className="font-display text-xl font-semibold text-ink">
        {title}
      </h2>
      {aside && <p className="font-mono text-2xs text-ink-faint">{aside}</p>}
    </div>
  );
}

export function CompositionSections({ analytics }: { analytics: CorpusAnalytics }) {
  const { total, integrations, nodeTypes, sources, enrichment } = analytics;

  return (
    <>
      <section aria-labelledby="parts-heading" className="flex flex-col gap-4">
        <SectionHeading
          id="parts-heading"
          title="Composition"
          aside={`${integrations.length.toLocaleString('en-US')} integrations · ${nodeTypes.length.toLocaleString('en-US')} node types`}
        />
        <div className="grid grid-cols-1 min-w-0 gap-4 lg:grid-cols-2">
          <BarList
            title="Integrations"
            total={total}
            rows={integrations.map((row) => ({ label: row.label, count: row.count }))}
          />
          <BarList
            title="Node types"
            total={total}
            rows={nodeTypes.map((row) => ({ label: shortNodeType(row.label), count: row.count }))}
          />
        </div>
      </section>

      <section aria-labelledby="provenance-heading" className="flex flex-col gap-4">
        <SectionHeading id="provenance-heading" title="Provenance" />
        <div className="grid grid-cols-1 min-w-0 gap-4 lg:grid-cols-2">
          <BarList
            title="Sources"
            total={total}
            rows={sources.map((row) => ({ label: SOURCE_LABEL[row.label] ?? row.label, count: row.count }))}
          />
          <BarList
            title="Descriptions"
            total={total}
            rows={[
              { label: 'Generated', count: enrichment.generated },
              { label: 'Upstream', count: enrichment.upstream },
              { label: 'Fallback', count: enrichment.fallback },
            ]}
          />
        </div>
      </section>
    </>
  );
}
