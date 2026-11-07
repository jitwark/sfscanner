import { createHash } from 'node:crypto';
import { computeGraphLayout, SVG_PREVIEW_SCHEMA_VERSION, type NodeCategory, type SvgPreview, type SvgPreviewListItem, type WorkflowChart } from '@hub/contracts';
import { classifyGraphTier, graphComplexityInputFromChart, type GraphTier } from './graph-tiers.js';
import { escapeXml, renderCategoryMap, renderFullDiagram, type CategorySummary } from './svg-preview-render.js';

export { SVG_PREVIEW_SCHEMA_VERSION } from '@hub/contracts';

/** Fixed so the tier-C map's swatch order never depends on which category appears first. */
const CATEGORY_ORDER: NodeCategory[] = ['trigger', 'http', 'ai', 'code', 'storage', 'flow', 'transform', 'other'];

export type { SvgPreview, SvgPreviewListItem } from '@hub/contracts';

function wrapSvg(width: number, height: number, tier: GraphTier, body: string): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img">` +
    `<title>${escapeXml(`Workflow diagram (tier ${tier})`)}</title>` +
    body +
    `</svg>`
  );
}

function categorySummaries(nodeList: readonly SvgPreviewListItem[]): CategorySummary[] {
  const counts = new Map<NodeCategory, number>();
  for (const node of nodeList) counts.set(node.category, (counts.get(node.category) ?? 0) + 1);
  return CATEGORY_ORDER.filter((category) => counts.has(category)).map((category) => ({ category, count: counts.get(category)! }));
}

/**
 * Deterministic, sanitized static preview for a workflow chart. Reuses
 * `computeGraphLayout` — the same pure function the live interactive canvas
 * uses — so the static preview and "explore canvas" draw the identical graph.
 *
 * Node.js-only (`node:crypto`): this is a build-time pipeline adapter, never
 * shipped to the browser. The renderer functions it calls are pure and carry
 * no forbidden SVG construct (script/foreignObject/event handler/remote
 * reference) by construction — see `svg-preview-render.ts`.
 */
export function renderStaticSvgPreview(chart: WorkflowChart | null | undefined): SvgPreview {
  const layout = computeGraphLayout(chart as WorkflowChart);
  const unresolvedEdgeCount = chart?.unresolvedEdgeCount ?? 0;
  const nodeList: SvgPreviewListItem[] = layout.nodes.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    category: node.category,
  }));

  const tier = classifyGraphTier(graphComplexityInputFromChart(chart ?? undefined));

  if (tier === 'invalid') {
    const svg = wrapSvg(layout.width, layout.height, tier, `<text x="50%" y="50%" text-anchor="middle" font-size="12" fill="#64748b">No diagram is available for this workflow.</text>`);
    return {
      schemaVersion: SVG_PREVIEW_SCHEMA_VERSION,
      tier,
      svg,
      nodeList: [],
      contentHash: createHash('sha256').update(svg, 'utf8').digest('hex'),
      width: layout.width,
      height: layout.height,
      elementCount: 0,
      truncatedLabelCount: 0,
      unresolvedEdgeCount,
    };
  }

  const useMap = tier === 'C';
  const { body, elementCount, truncatedLabelCount } = useMap
    ? { ...renderCategoryMap(categorySummaries(nodeList), layout.width, layout.height), truncatedLabelCount: 0 }
    : renderFullDiagram(layout);

  const svg = wrapSvg(layout.width, layout.height, tier, body);

  return {
    schemaVersion: SVG_PREVIEW_SCHEMA_VERSION,
    tier,
    svg,
    nodeList,
    contentHash: createHash('sha256').update(svg, 'utf8').digest('hex'),
    width: layout.width,
    height: layout.height,
    elementCount,
    truncatedLabelCount,
    unresolvedEdgeCount,
  };
}
