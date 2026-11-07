import type { GraphLayout, NodeCategory } from '@hub/contracts';

/** Fixed per-category colors so the preview never varies build to build. */
const CATEGORY_COLOR: Record<NodeCategory, string> = {
  trigger: '#22c55e',
  ai: '#a855f7',
  http: '#3b82f6',
  code: '#f59e0b',
  storage: '#06b6d4',
  flow: '#ec4899',
  transform: '#64748b',
  other: '#94a3b8',
};

const MAX_LABEL_LENGTH = 40;

/** XML-escapes text content. Every label reaching the SVG string goes through this. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export type TruncatedLabel = { text: string; truncated: boolean };

/** Bounds a label so one hostile/legitimate long name can't dominate the payload. */
export function truncateLabel(value: string): TruncatedLabel {
  if (value.length <= MAX_LABEL_LENGTH) return { text: value, truncated: false };
  return { text: `${value.slice(0, MAX_LABEL_LENGTH - 1)}…`, truncated: true };
}

/**
 * Full per-node/per-edge diagram (tiers A and B). Every element is a plain
 * shape, path, or text node — no script, foreignObject, event handler, or
 * remote reference is ever constructed, so there is nothing to sanitize out.
 */
export function renderFullDiagram(layout: GraphLayout): { body: string; elementCount: number; truncatedLabelCount: number } {
  let elementCount = 0;
  let truncatedLabelCount = 0;
  const parts: string[] = [];

  layout.edges.forEach((edge, index) => {
    parts.push(`<path id="e-${index}" d="${edge.pathD}" fill="none" stroke="#cbd5e1" stroke-width="1.5" />`);
    elementCount += 1;
  });

  layout.nodes.forEach((node, index) => {
    const color = CATEGORY_COLOR[node.category] ?? CATEGORY_COLOR.other;
    const { text, truncated } = truncateLabel(node.name);
    if (truncated) truncatedLabelCount += 1;
    const titleType = truncateLabel(node.type);
    if (titleType.truncated) truncatedLabelCount += 1;
    parts.push(
      `<g id="n-${index}">` +
        `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="6" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="1.5" />` +
        `<title>${escapeXml(text)} (${escapeXml(titleType.text)})</title>` +
        `<text x="${node.x + node.width / 2}" y="${node.y + node.height / 2}" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="#0f172a">${escapeXml(text)}</text>` +
        `</g>`,
    );
    elementCount += 2; // rect (as part of g) counted with its text; g itself not separately counted.
  });

  return { body: parts.join(''), elementCount, truncatedLabelCount };
}

export type CategorySummary = { category: NodeCategory; count: number };

/**
 * Bounded overview for tier C: one swatch per category present, never one
 * shape per node, so an extreme graph's payload stays flat regardless of how
 * many nodes it actually has.
 */
export function renderCategoryMap(summaries: readonly CategorySummary[], width: number, height: number): { body: string; elementCount: number } {
  const parts: string[] = [];
  const swatchWidth = width / Math.max(1, summaries.length);
  const maxCount = Math.max(1, ...summaries.map((summary) => summary.count));
  summaries.forEach((summary, index) => {
    const color = CATEGORY_COLOR[summary.category] ?? CATEGORY_COLOR.other;
    const x = index * swatchWidth;
    const barHeight = Math.min(height - 40, Math.max(8, (summary.count / maxCount) * (height - 40)));
    parts.push(
      `<g id="c-${index}">` +
        `<rect x="${x + 4}" y="${height - barHeight}" width="${Math.max(1, swatchWidth - 8)}" height="${barHeight}" fill="${color}" fill-opacity="0.35" stroke="${color}" />` +
        `<title>${escapeXml(summary.category)}: ${summary.count}</title>` +
        `<text x="${x + swatchWidth / 2}" y="${height - barHeight - 6}" text-anchor="middle" font-size="10" fill="#0f172a">${escapeXml(summary.category)} (${summary.count})</text>` +
        `</g>`,
    );
  });
  return { body: parts.join(''), elementCount: summaries.length };
}
