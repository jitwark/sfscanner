import { compareCanonicalStrings } from '@hub/contracts/stable-order';

export type LayoutNode = {
  id: string;
  name?: string;
  type?: string;
  position?: [number, number];
};

export type LayoutEdge = {
  from: string;
  to: string;
  kind?: string;
};

export type Point = {
  x: number;
  y: number;
};

function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0.5;
  return Math.max(0, Math.min(1, val));
}

export function layoutWorkflow(nodes: LayoutNode[], edges: LayoutEdge[]): Record<string, Point> {
  const result: Record<string, Point> = {};
  if (!nodes || nodes.length === 0) return result;

  const nodeIds = nodes.map(n => n.id || n.name || '').filter(Boolean);
  if (nodeIds.length === 0) return result;

  // 1. Position-based normalization if >= 80% have finite positions
  let validPosCount = 0;
  for (const node of nodes) {
    if (Array.isArray(node.position) && node.position.length >= 2 &&
        Number.isFinite(node.position[0]) && Number.isFinite(node.position[1])) {
      validPosCount++;
    }
  }

  if (validPosCount / nodes.length >= 0.8) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const positions: Record<string, [number, number]> = {};

    for (const node of nodes) {
      const id = node.id || node.name || '';
      if (!id) continue;
      const valid = Array.isArray(node.position) && node.position.length >= 2 &&
        Number.isFinite(node.position[0]) && Number.isFinite(node.position[1]);
      positions[id] = valid ? [node.position![0], node.position![1]] : [0, 0];
      minX = Math.min(minX, positions[id][0]); maxX = Math.max(maxX, positions[id][0]);
      minY = Math.min(minY, positions[id][1]); maxY = Math.max(maxY, positions[id][1]);
    }

    const rangeX = maxX - minX, rangeY = maxY - minY;
    for (const id of nodeIds) {
      const pos = positions[id] || [0, 0];
      const normX = rangeX === 0 ? 0.5 : (pos[0] - minX) / rangeX;
      const normY = rangeY === 0 ? 0.5 : (pos[1] - minY) / rangeY;
      result[id] = { x: clamp01(normX), y: clamp01(normY) };
    }
    return result;
  }

  // 2. BFS Layered Layout Fallback
  const inDegree: Record<string, number> = {};
  const adj: Record<string, string[]> = {};
  const parents: Record<string, string[]> = {};

  for (const id of nodeIds) {
    inDegree[id] = 0; adj[id] = []; parents[id] = [];
  }

  for (const edge of edges) {
    if (inDegree[edge.to] !== undefined) inDegree[edge.to]++;
    if (adj[edge.from]) adj[edge.from].push(edge.to);
    if (parents[edge.to]) parents[edge.to].push(edge.from);
  }

  const startNodes = nodeIds.filter(id => (inDegree[id] || 0) === 0).sort(compareCanonicalStrings);
  if (startNodes.length === 0 && nodeIds.length > 0) {
    startNodes.push([...nodeIds].sort(compareCanonicalStrings)[0]);
  }

  const layers: Record<string, number> = {};
  const queue: string[] = [];
  const enqueueCount: Record<string, number> = {};

  for (const startNode of startNodes) {
    layers[startNode] = 0; queue.push(startNode); enqueueCount[startNode] = 1;
  }

  let iterations = 0;
  while (queue.length > 0 && iterations < 1000) {
    iterations++;
    const u = queue.shift()!;
    const uLayer = layers[u];

    for (const v of adj[u] || []) {
      if (layers[v] === undefined || layers[v] < uLayer + 1) {
        layers[v] = uLayer + 1;
        const count = enqueueCount[v] || 0;
        if (count < nodeIds.length) {
          queue.push(v); enqueueCount[v] = count + 1;
        }
      }
    }
  }

  for (const id of nodeIds) {
    if (layers[id] === undefined) layers[id] = 0;
  }

  const layerGroups: Record<number, string[]> = {};
  for (const id of nodeIds) {
    const l = layers[id];
    if (!layerGroups[l]) layerGroups[l] = [];
    layerGroups[l].push(id);
  }

  const maxLayer = Math.max(...Object.keys(layerGroups).map(Number), 0);

  // Barycentre heuristic crossing reduction
  for (let l = 1; l <= maxLayer; l++) {
    const group = layerGroups[l] || [];
    const prevGroup = layerGroups[l - 1] || [];
    const prevIndexMap = new Map<string, number>();
    prevGroup.forEach((id, idx) => prevIndexMap.set(id, idx));

    const barycentres = new Map<string, number>();
    group.forEach((id, idx) => {
      const pList = parents[id] || [];
      const prevParents = pList.filter(p => prevIndexMap.has(p));
      if (prevParents.length > 0) {
        const sum = prevParents.reduce((acc, p) => acc + (prevIndexMap.get(p) || 0), 0);
        barycentres.set(id, sum / prevParents.length);
      } else {
        barycentres.set(id, idx);
      }
    });

    group.sort((a, b) => {
      const bA = barycentres.get(a) || 0, bB = barycentres.get(b) || 0;
      return bA !== bB ? bA - bB : compareCanonicalStrings(a, b);
    });
  }

  // Calculate normalized coordinates
  for (let l = 0; l <= maxLayer; l++) {
    const group = layerGroups[l] || [];
    const x = maxLayer === 0 ? 0.5 : l / maxLayer;
    const count = group.length;

    group.forEach((id, idx) => {
      const y = count === 1 ? 0.5 : idx / (count - 1);
      result[id] = { x: clamp01(x), y: clamp01(y) };
    });
  }

  return result;
}
