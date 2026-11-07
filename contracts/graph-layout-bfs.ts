import type { ChartEdge } from './index';

export type RawPosition = { x: number; y: number };

/**
 * Layered layout for graphs missing embedded editor coordinates: BFS from
 * every in-degree-0 node assigns a column (layer), then nodes within a layer
 * are ordered by first-seen id and spaced evenly around the vertical centre.
 * Cycle-safe: a node stops being re-queued once its visit count exceeds 5.
 */
export function computeBfsLayeredPositions(
  nodeIds: readonly string[],
  edges: readonly ChartEdge[],
  spacing: { x: number; y: number },
): Map<string, RawPosition> {
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) {
    adj.set(id, []);
    inDegree.set(id, 0);
  }

  for (const e of edges) {
    if (adj.has(e.from) && adj.has(e.to)) {
      adj.get(e.from)!.push(e.to);
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }
  }

  const nodeLayers = new Map<string, number>();
  const visitedCounts = new Map<string, number>();
  const queue: Array<{ id: string; layer: number }> = [];

  // Seed queue with in-degree 0 nodes
  for (const id of nodeIds) {
    if ((inDegree.get(id) ?? 0) === 0) {
      queue.push({ id, layer: 0 });
      nodeLayers.set(id, 0);
    }
  }

  // Fallback seed for pure cycles
  if (queue.length === 0 && nodeIds.length > 0) {
    queue.push({ id: nodeIds[0]!, layer: 0 });
    nodeLayers.set(nodeIds[0]!, 0);
  }

  let iterations = 0;
  while (queue.length > 0 && iterations < 1000) {
    iterations++;
    const current = queue.shift()!;
    const count = (visitedCounts.get(current.id) ?? 0) + 1;
    visitedCounts.set(current.id, count);

    if (count > 5) continue; // cap visits to break cycles

    const targets = adj.get(current.id) ?? [];
    for (const tgt of targets) {
      const nextLayer = current.layer + 1;
      const prevMaxLayer = nodeLayers.get(tgt) ?? 0;
      if (nextLayer > prevMaxLayer || !nodeLayers.has(tgt)) {
        nodeLayers.set(tgt, nextLayer);
        queue.push({ id: tgt, layer: nextLayer });
      }
    }
  }

  // Handle any unvisited nodes
  for (const id of nodeIds) {
    if (!nodeLayers.has(id)) {
      nodeLayers.set(id, 0);
    }
  }

  // Group by layer
  const layers = new Map<number, string[]>();
  for (const [id, layerIdx] of nodeLayers.entries()) {
    if (!layers.has(layerIdx)) layers.set(layerIdx, []);
    layers.get(layerIdx)!.push(id);
  }

  // Barycentre ordering and assign coordinates
  const positions = new Map<string, RawPosition>();
  const sortedLayers = Array.from(layers.keys()).sort((a, b) => a - b);
  for (const layerIdx of sortedLayers) {
    const group = layers.get(layerIdx)!;
    for (let i = 0; i < group.length; i++) {
      const id = group[i]!;
      const x = layerIdx * spacing.x;
      const y = (i - (group.length - 1) / 2) * spacing.y;
      positions.set(id, { x, y });
    }
  }

  return positions;
}
