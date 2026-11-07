import type { SvgPreviewArtifact } from '@hub/contracts';

type StaticWorkflowPreviewProps = { preview: SvgPreviewArtifact };

const SVG_ROOT = /^<svg\b[^>]*>/i;

/**
 * The wrapper owns the accessible name; the serialized SVG is its visual
 * child. Normalize the root attributes so it cannot become a second image or
 * keyboard stop in the browser accessibility tree.
 */
function makeSvgDecorative(svg: string): string {
  const root = svg.match(SVG_ROOT)?.[0];
  if (!root) return svg;
  const attributes = root
    .replace(/\saria-hidden\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '')
    .replace(/\sfocusable\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '')
    .replace(/\stabindex\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '');
  return `${attributes.slice(0, -1)} aria-hidden="true" focusable="false">${svg.slice(root.length)}`;
}

/**
 * Static preview only. The SVG has already passed the shared contract parser;
 * this component deliberately has no event handlers, canvas, or client-only
 * chart imports. The node list is the accessible, complete fallback when a
 * reader cannot inspect the image.
 */
export function StaticWorkflowPreview({ preview }: StaticWorkflowPreviewProps) {
  const diagramLabel = preview.tier === 'invalid'
    ? `Workflow diagram unavailable, tier ${preview.tier}, ${preview.nodeList.length} nodes`
    : `Workflow diagram, tier ${preview.tier}, ${preview.nodeList.length} nodes`;

  return (
    <div
      data-static-preview
      className="space-y-4"
    >
      <div
        role="img"
        aria-label={diagramLabel}
        className="overflow-hidden rounded-control border border-hairline bg-page p-2 [&>svg]:h-auto [&>svg]:max-h-[28rem] [&>svg]:min-h-48 [&>svg]:w-full"
        dangerouslySetInnerHTML={{ __html: makeSvgDecorative(preview.svg) }}
      />
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-ink-muted">
        <span>Tier {preview.tier}</span>
        <span>{preview.nodeList.length} workflow nodes</span>
        {preview.unresolvedEdgeCount > 0 && (
          <span role="status">
            {preview.unresolvedEdgeCount} declared connections could not be resolved.
          </span>
        )}
      </div>
      <details open className="rounded-control border border-hairline bg-raised px-4 py-3">
        <summary className="cursor-pointer font-mono text-xs font-semibold uppercase tracking-[0.12em] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border">
          View all workflow nodes ({preview.nodeList.length})
        </summary>
        <pre aria-label="Workflow node list" className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-ink-muted">
          {preview.nodeList.map((node) => `${node.name || 'Unnamed node'} — ${node.type}`).join('\n')}
        </pre>
      </details>
    </div>
  );
}
