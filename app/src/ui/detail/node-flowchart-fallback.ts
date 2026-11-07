import type { SvgPreviewListItem, NodeCategory } from '@hub/contracts';

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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates an actual node-and-wire flowchart SVG for Tier C or bar-chart previews.
 * Displays nodes in an organic sequential layout with connecting bezier wires.
 */
export function generateNodeFlowchartSvg(nodes: readonly SvgPreviewListItem[]): string {
  if (!nodes || nodes.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><text x="50%" y="50%" text-anchor="middle" fill="currentColor">No nodes</text></svg>';
  }

  const displayNodes = nodes.slice(0, 24);
  const nodeWidth = 140;
  const nodeHeight = 44;
  const colGap = 40;
  const rowGap = 30;
  const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(displayNodes.length))));
  const rows = Math.ceil(displayNodes.length / cols);

  const totalWidth = cols * (nodeWidth + colGap) + 40;
  const totalHeight = rows * (nodeHeight + rowGap) + 40;

  const positions: Array<{ x: number; y: number }> = [];
  displayNodes.forEach((_, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = 30 + col * (nodeWidth + colGap);
    const y = 30 + row * (nodeHeight + rowGap);
    positions.push({ x, y });
  });

  const paths: string[] = [];
  for (let i = 0; i < positions.length - 1; i++) {
    const curr = positions[i]!;
    const next = positions[i + 1]!;
    const startX = curr.x + nodeWidth;
    const startY = curr.y + nodeHeight / 2;
    const endX = next.x;
    const endY = next.y + nodeHeight / 2;
    const c1X = startX + 20;
    const c2X = endX - 20;
    paths.push(
      `<path d="M ${startX} ${startY} C ${c1X} ${startY}, ${c2X} ${endY}, ${endX} ${endY}" fill="none" stroke="#64748b" stroke-width="1.5" opacity="0.6" />`
    );
  }

  const nodeElements: string[] = [];
  displayNodes.forEach((node, index) => {
    const pos = positions[index]!;
    const cat = node.category;
    const color = (cat && cat in CATEGORY_COLOR) ? CATEGORY_COLOR[cat] : CATEGORY_COLOR.other;
    const name = escapeXml(node.name?.slice(0, 16) || `Node ${index + 1}`);
    const type = escapeXml(node.type?.split('.').pop()?.slice(0, 18) || 'node');

    nodeElements.push(
      `<g id="node-${index}" transform="translate(${pos.x}, ${pos.y})">` +
        `<rect width="${nodeWidth}" height="${nodeHeight}" rx="6" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="1.5" />` +
        `<circle cx="12" cy="${nodeHeight / 2}" r="4" fill="${color}" />` +
        `<text x="22" y="18" font-size="10" font-weight="600" fill="#f2f6f9">${name}</text>` +
        `<text x="22" y="32" font-size="8" font-family="monospace" fill="#94a3b8">${type}</text>` +
      `</g>`
    );
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" preserveAspectRatio="xMidYMid meet" role="img">` +
    `<title>Workflow node diagram (${displayNodes.length} nodes)</title>` +
    paths.join('') +
    nodeElements.join('') +
    `</svg>`
  );
}
