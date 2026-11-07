import type { WorkflowChart } from './index';
import { compactCoordinates } from './compact-coordinates';
import { computeBfsLayeredPositions } from './graph-layout-bfs';

export type NodeCategory =
  | 'trigger'
  | 'transform'
  | 'ai'
  | 'http'
  | 'code'
  | 'storage'
  | 'flow'
  | 'other';

export type LayoutNode = {
  id: string;
  name: string;
  type: string;
  category: NodeCategory;
  x: number;
  y: number;
  width: number;
  height: number;
  isAnnotation?: boolean;
};

export type LayoutEdge = {
  from: string;
  to: string;
  kind: string;
  pathD: string;
};

export type GraphLayout = {
  width: number;
  height: number;
  viewBox: string;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
};

export function classifyCategory(type: string): NodeCategory {
  const t = (type || '').toLowerCase();
  if (t.includes('trigger') || t.includes('webhook') || t.includes('poll') || t.includes('cron') || t.includes('manual') || t.includes('schedule')) {
    return 'trigger';
  }
  if (t.includes('langchain') || t.includes('openai') || t.includes('anthropic') || t.includes('agent') || t.includes('chain') || t.includes('vector') || t.includes('ai_')) {
    return 'ai';
  }
  if (t.includes('httprequest') || t.includes('http') || t.includes('graphql')) {
    return 'http';
  }
  if (t.includes('code') || t.includes('function') || t.includes('script') || t.includes('executecommand')) {
    return 'code';
  }
  if (t.includes('postgres') || t.includes('mysql') || t.includes('mongo') || t.includes('supabase') || t.includes('redis') || t.includes('s3') || t.includes('sheet') || t.includes('airtable')) {
    return 'storage';
  }
  if (t.includes('if') || t.includes('switch') || t.includes('merge') || t.includes('split') || t.includes('loop') || t.includes('filter') || t.includes('noop')) {
    return 'flow';
  }
  if (t.includes('set') || t.includes('itemlists') || t.includes('crypto') || t.includes('datetime') || t.includes('json')) {
    return 'transform';
  }
  return 'other';
}

const NODE_W = 140;
const NODE_H = 44;
const X_SPACING = 200;
const Y_SPACING = 70;
const PAD_X = 60;
const PAD_Y = 40;

/**
 * Pure and browser-safe: no DOM, no Node primitives. Shared by the live
 * interactive canvas (`app/src/ui/workflow-chart.tsx`) and the build-time
 * static SVG preview generator, so both draw the same graph identically.
 */
export function computeGraphLayout(chart: WorkflowChart): GraphLayout {
  if (!chart || !chart.nodes || chart.nodes.length === 0) {
    return {
      width: 400,
      height: 200,
      viewBox: '0 0 400 200',
      nodes: [],
      edges: [],
    };
  }
  const nodeIds = new Set(chart.nodes.map((node) => node.id));
  const nodeNames = new Map(chart.nodes.map((node) => [node.name, node.id]));
  const chartEdges = chart.edges.map((edge) => ({ ...edge, from: nodeIds.has(edge.from) ? edge.from : (nodeNames.get(edge.from) ?? edge.from), to: nodeIds.has(edge.to) ? edge.to : (nodeNames.get(edge.to) ?? edge.to) }));

  const validCoords = chart.nodes.filter(
    (n) =>
      typeof n.x === 'number' &&
      typeof n.y === 'number' &&
      Number.isFinite(n.x) &&
      Number.isFinite(n.y) &&
      (n.x !== 0 || n.y !== 0),
  );
  const useEmbedded = chart.nodes.length > 0 && validCoords.length / chart.nodes.length >= 0.8;

  const rawPositions = new Map<string, { x: number; y: number }>();

  if (useEmbedded) {
    // Editor coordinates sprawl (median graph: 2,516 units). See compact-coordinates.ts.
    const points = chart.nodes.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0 }));
    const compacted = compactCoordinates(points, { maxXGap: X_SPACING, maxYGap: Y_SPACING, minXGap: NODE_W + 24, minYGap: NODE_H + 16 });
    chart.nodes.forEach((n, index) => rawPositions.set(n.id, compacted[index]!));
  } else {
    const positions = computeBfsLayeredPositions(
      chart.nodes.map((n) => n.id),
      chartEdges,
      { x: X_SPACING, y: Y_SPACING },
    );
    for (const [id, pos] of positions) rawPositions.set(id, pos);
  }

  // Calculate bounds
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const n of chart.nodes) {
    const pos = rawPositions.get(n.id) ?? { x: 0, y: 0 };
    if (pos.x < minX) minX = pos.x;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.y > maxY) maxY = pos.y;
  }

  if (minX === Infinity) { minX = 0; maxX = 0; minY = 0; maxY = 0; }

  const nodes: LayoutNode[] = chart.nodes.map((n) => {
    const raw = rawPositions.get(n.id) ?? { x: 0, y: 0 };
    return {
      id: n.id,
      name: n.name || n.id,
      type: n.type || 'n8n-nodes-base.noOp',
      category: classifyCategory(n.type),
      x: raw.x - minX + PAD_X,
      y: raw.y - minY + PAD_Y,
      width: NODE_W,
      height: NODE_H,
      isAnnotation: n.isAnnotation === true,
    };
  });

  const nodeMap = new Map<string, LayoutNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const edges: LayoutEdge[] = chartEdges
    .filter((e) => nodeMap.has(e.from) && nodeMap.has(e.to))
    .map((e) => {
      const src = nodeMap.get(e.from)!;
      const tgt = nodeMap.get(e.to)!;

      const x1 = src.x + src.width;
      const y1 = src.y + src.height / 2;
      const x2 = tgt.x;
      const y2 = tgt.y + tgt.height / 2;

      let pathD: string;
      if (x2 >= x1 + 10) {
        const dx = Math.max(30, (x2 - x1) / 2);
        pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      } else {
        pathD = `M ${x1} ${y1} C ${x1 + 40} ${y1 + 40}, ${x2 - 40} ${y2 + 40}, ${x2} ${y2}`;
      }

      return {
        from: e.from,
        to: e.to,
        kind: e.kind || 'main',
        pathD,
      };
    });

  const width = Math.max(300, maxX - minX + 2 * PAD_X + NODE_W);
  const height = Math.max(150, maxY - minY + 2 * PAD_Y + NODE_H);

  return {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    nodes,
    edges,
  };
}
