import { createHash } from 'node:crypto';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function canonicalizeJson(val: unknown): string {
  if (val === null) return 'null';
  if (typeof val === 'string') return JSON.stringify(val);
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) throw new Error('Cannot canonicalize non-finite number as canonical JSON');
    return Object.is(val, -0) ? '0' : JSON.stringify(val);
  }
  if (typeof val !== 'object') {
    throw new Error(`Cannot canonicalize ${typeof val} as canonical JSON`);
  }
  if (Array.isArray(val)) {
    return '[' + val.map(canonicalizeJson).join(',') + ']';
  }
  const obj = val as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(obj);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Cannot canonicalize a non-plain object as canonical JSON');
  }
  if (Object.getOwnPropertySymbols(obj).some((symbol) => Object.prototype.propertyIsEnumerable.call(obj, symbol))) {
    throw new Error('Cannot canonicalize symbol properties as canonical JSON');
  }
  const keys = Object.keys(obj).sort(compareCanonicalStrings);
  const pairs = keys.map((k) => JSON.stringify(k) + ':' + canonicalizeJson(obj[k]));
  return '{' + pairs.join(',') + '}';
}

/**
 * Canonicalize a TypeScript value at a JSON boundary. Optional object fields
 * are omitted exactly as JSON.stringify omits them; invalid numeric values
 * remain visible to canonicalizeJson and are still rejected.
 */
export function canonicalizeJsonForHash(val: unknown): string {
  const omitUndefined = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((item) => item === undefined ? null : omitUndefined(item));
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const record = value as Record<PropertyKey, unknown>;
      const copy: Record<PropertyKey, unknown> = {};
      for (const key of Object.keys(record)) if (record[key] !== undefined) copy[key] = omitUndefined(record[key]);
      for (const symbol of Object.getOwnPropertySymbols(value)) {
        if (Object.prototype.propertyIsEnumerable.call(value, symbol)) copy[symbol] = record[symbol];
      }
      return copy;
    }
    return value;
  };
  return canonicalizeJson(omitUndefined(val));
}

export function fingerprint(json: unknown): string {
  return sha256(canonicalizeJson(json));
}

type ExtractedNode = {
  id: string;
  name: string;
  type: string;
  originalIndex: number;
};

type ExtractedEdge = {
  sourceKey: string;
  targetKey: string;
  output: string;
  index: number;
};

export function structuralHash(json: unknown): string {
  if (!json || typeof json !== 'object') {
    return sha256(JSON.stringify({ trigger: '', nodeTypes: [], edges: [] }));
  }

  const rawObj = json as Record<string, unknown>;
  const rawNodes = Array.isArray(rawObj.nodes) ? rawObj.nodes : [];

  const nodes: ExtractedNode[] = rawNodes.map((item: unknown, idx: number) => {
    const n = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return {
      id: String(n.id ?? n.name ?? idx),
      name: String(n.name ?? n.id ?? idx),
      type: String(n.type ?? 'unknown'),
      originalIndex: idx,
    };
  });

  let trigger = '';
  const TRIGGER_PATTERNS = /webhook|trigger|cron|poll|start|schedule|emailRead/i;
  const triggerNode = nodes.find((n) => TRIGGER_PATTERNS.test(n.type));
  if (triggerNode) {
    trigger = triggerNode.type;
  }

  const edges: ExtractedEdge[] = [];
  const rawConnections =
    rawObj.connections && typeof rawObj.connections === 'object'
      ? (rawObj.connections as Record<string, unknown>)
      : {};

  for (const [sourceKey, outputs] of Object.entries(rawConnections)) {
    if (!outputs || typeof outputs !== 'object') continue;
    for (const [outputName, outputGroups] of Object.entries(outputs as Record<string, unknown>)) {
      if (!Array.isArray(outputGroups)) continue;
      for (const group of outputGroups) {
        if (!Array.isArray(group)) continue;
        for (const targetItem of group) {
          if (targetItem && typeof targetItem === 'object') {
            const target = targetItem as Record<string, unknown>;
            if (target.node) {
              edges.push({
                sourceKey,
                targetKey: String(target.node),
                output: outputName,
                index: typeof target.index === 'number' ? target.index : 0,
              });
            }
          }
        }
      }
    }
  }

  const inDegreeMap = new Map<string, number>();
  const outDegreeMap = new Map<string, number>();

  for (const node of nodes) {
    inDegreeMap.set(node.name, 0);
    inDegreeMap.set(node.id, 0);
    outDegreeMap.set(node.name, 0);
    outDegreeMap.set(node.id, 0);
  }

  for (const edge of edges) {
    outDegreeMap.set(edge.sourceKey, (outDegreeMap.get(edge.sourceKey) ?? 0) + 1);
    inDegreeMap.set(edge.targetKey, (inDegreeMap.get(edge.targetKey) ?? 0) + 1);
  }

  const sortedNodes = [...nodes].sort((a, b) => {
    if (a.type !== b.type) return compareCanonicalStrings(a.type, b.type);
    const inA = (inDegreeMap.get(a.name) ?? 0) + (inDegreeMap.get(a.id) ?? 0);
    const inB = (inDegreeMap.get(b.name) ?? 0) + (inDegreeMap.get(b.id) ?? 0);
    if (inA !== inB) return inA - inB;
    const outA = (outDegreeMap.get(a.name) ?? 0) + (outDegreeMap.get(a.id) ?? 0);
    const outB = (outDegreeMap.get(b.name) ?? 0) + (outDegreeMap.get(b.id) ?? 0);
    if (outA !== outB) return outA - outB;
    return a.originalIndex - b.originalIndex;
  });

  const nodeKeyToPos = new Map<string, number>();
  sortedNodes.forEach((node, pos) => {
    nodeKeyToPos.set(node.name, pos);
    nodeKeyToPos.set(node.id, pos);
  });

  const positionalEdges: Array<{ from: number; to: number; output: string; index: number }> = [];
  for (const edge of edges) {
    const from = nodeKeyToPos.get(edge.sourceKey);
    const to = nodeKeyToPos.get(edge.targetKey);
    if (from !== undefined && to !== undefined) {
      positionalEdges.push({
        from,
        to,
        output: edge.output,
        index: edge.index,
      });
    }
  }

  positionalEdges.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    if (a.to !== b.to) return a.to - b.to;
    if (a.output !== b.output) return compareCanonicalStrings(a.output, b.output);
    return a.index - b.index;
  });

  const nodeTypes = sortedNodes.map((n) => n.type);

  const projection = {
    trigger,
    nodeTypes,
    edges: positionalEdges,
  };

  return sha256(JSON.stringify(projection));
}
