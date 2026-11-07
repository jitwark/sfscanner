import type { ChartEdge, ChartNode, WorkflowChart } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { isFunctionalNode } from '@hub/contracts/functional-nodes';
import { layoutWorkflow, type LayoutEdge, type LayoutNode } from './layout.js';

export function buildChart(workflow: unknown): WorkflowChart {
  let parsed: Record<string, unknown> = {};

  if (typeof workflow === 'string') {
    try {
      parsed = JSON.parse(workflow);
    } catch {
      return { nodes: [], edges: [] };
    }
  } else if (workflow && typeof workflow === 'object') {
    parsed = workflow as Record<string, unknown>;
  }

  const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const connectionsMap = parsed.connections && typeof parsed.connections === 'object'
    ? (parsed.connections as Record<string, unknown>)
    : {};

  // Extract edges with connection kinds
  const edges: ChartEdge[] = [];
  const fromKeys = Object.keys(connectionsMap).sort(compareCanonicalStrings);

  for (const from of fromKeys) {
    const outputsObj = connectionsMap[from];
    if (!outputsObj || typeof outputsObj !== 'object') continue;

    const kinds = Object.keys(outputsObj).sort(compareCanonicalStrings);

    for (const kind of kinds) {
      const outputs = (outputsObj as Record<string, unknown>)[kind];
      if (!Array.isArray(outputs)) continue;

      for (const outputGroup of outputs) {
        if (!Array.isArray(outputGroup)) continue;
        for (const target of outputGroup) {
          if (target && typeof target === 'object' && 'node' in target && typeof target.node === 'string') {
            edges.push({
              from,
              to: target.node,
              kind: kind || 'main',
            });
          }
        }
      }
    }
  }

  // Normalize initial node representations
  const identityByName = new Map<string, string>();
  const usedIds = new Set<string>();
  let nodes = rawNodes
    .map((n, index): LayoutNode & { name: string; type: string } => {
      const rec = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>;
      const name = typeof rec.name === 'string' ? rec.name : (typeof rec.id === 'string' ? rec.id : '');
      const type = typeof rec.type === 'string' ? rec.type : 'Unknown';
      const requestedId = typeof rec.id === 'string' && rec.id ? rec.id : name || `node-${index}`;
      let id = requestedId;
      let suffix = 2;
      while (usedIds.has(id)) id = `${requestedId}-${suffix++}`;
      usedIds.add(id);
      if (name && !identityByName.has(name)) identityByName.set(name, id);
      const position = Array.isArray(rec.position) && rec.position.length >= 2 &&
        Number.isFinite(rec.position[0]) && Number.isFinite(rec.position[1])
        ? [Number(rec.position[0]), Number(rec.position[1])] as [number, number]
        : undefined;

      return { id, name, type, position };
    })
    .filter(n => Boolean(n.id));

  // Resolve n8n's name-based connections to the unique chart IDs. Duplicate
  // display names are retained as separate nodes rather than collapsing into
  // React/SVG key collisions; ambiguous connections intentionally target the
  // first deterministic occurrence.
  //
  // A connection naming a node the file does not contain is not an edge. This
  // used to fall back to the raw name — `identityByName.get(x) ?? x` — which
  // emitted a reference to nothing as though it were an id. That is how 1,745
  // workflows shipped with graphs that draw nothing while reporting a
  // connection count that counted the drawings (CI R-2).
  let unresolvedEdgeCount = 0;
  const normalizedEdges: ChartEdge[] = [];
  for (const edge of edges) {
    const from = identityByName.get(edge.from) ?? (usedIds.has(edge.from) ? edge.from : null);
    const to = identityByName.get(edge.to) ?? (usedIds.has(edge.to) ? edge.to : null);
    if (from === null || to === null) {
      unresolvedEdgeCount += 1;
      continue;
    }
    normalizedEdges.push({ ...edge, from, to });
  }
  edges.length = 0;
  edges.push(...normalizedEdges);

  // Cap at 400 nodes: keep 400 highest-degree nodes
  if (nodes.length > 400) {
    const degreeMap: Record<string, number> = {};
    for (const edge of edges) {
      degreeMap[edge.from] = (degreeMap[edge.from] || 0) + 1;
      degreeMap[edge.to] = (degreeMap[edge.to] || 0) + 1;
    }

    const sortedNodes = [...nodes].sort((a, b) => {
      const degA = degreeMap[a.id] || 0;
      const degB = degreeMap[b.id] || 0;
      if (degB !== degA) return degB - degA;
      return compareCanonicalStrings(a.id, b.id);
    });

    nodes = sortedNodes.slice(0, 400);
    const survivingIds = new Set(nodes.map(n => n.id));

    // Filter edges to only those connecting surviving nodes
    const filteredEdges = edges.filter(e => survivingIds.has(e.from) && survivingIds.has(e.to));
    edges.length = 0;
    edges.push(...filteredEdges);
  }

  // Calculate layout
  const layoutEdges: LayoutEdge[] = edges.map(e => ({ from: e.from, to: e.to, kind: e.kind }));
  const posMap = layoutWorkflow(nodes, layoutEdges);

  const chartNodes: ChartNode[] = nodes.map(n => {
    const pt = posMap[n.id] || { x: 0.5, y: 0.5 };
    return {
      id: n.id,
      name: n.name,
      type: n.type,
      x: pt.x,
      y: pt.y,
      isAnnotation: !isFunctionalNode(n.type),
    };
  });

  // Absent rather than zero on a healthy chart: 13,221 charts are serialised
  // into shards, and a field that is always present costs bytes on every one.
  return unresolvedEdgeCount > 0
    ? { nodes: chartNodes, edges, unresolvedEdgeCount }
    : { nodes: chartNodes, edges };
}
