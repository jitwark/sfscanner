import type { NodeCoverage, NodeCoverageUnknownType, NodeCoverageVersionRow } from '@hub/contracts';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from '../../packages/scanner-core/src/semantics/builtin-catalogue.js';
import { resolveNodeSemantics } from '../../packages/scanner-core/src/semantics/catalogue-resolver.js';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';

/** One scanned body's node type/version surface, projected while its bytes are already in hand. */
export type NodeSample = Readonly<{
  entryId: string;
  nodes: readonly Readonly<{ type: string; version: string }>[];
}>;

/**
 * `typeVersion` reaches the scanner as a numeric or short string (`1`, `1.1`), while catalogue
 * clauses are strict semver. Normalize the same way the v2 source normalizer does; anything else
 * stays an explicit `unspecified` version row instead of being coerced to `1.0.0`.
 */
function strictVersion(value: unknown): string {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+(?:\.\d+){0,2}$/.test(text)) return 'unspecified';
  const parts = text.split('.');
  while (parts.length < 3) parts.push('0');
  return parts.join('.');
}

export function projectNodeSample(entryId: string, bytes: Uint8Array): NodeSample {
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as { nodes?: unknown };
  const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
  return Object.freeze({
    entryId,
    nodes: Object.freeze(nodes.flatMap((node) => {
      if (node === null || typeof node !== 'object') return [];
      const { type, typeVersion } = node as { type?: unknown; typeVersion?: unknown };
      return typeof type === 'string' && type.length > 0 ? [{ type, version: strictVersion(typeVersion) }] : [];
    })),
  });
}

/**
 * Complete inventory of the node types and versions the scanned bodies contain, with the catalogue
 * resolution each pair receives. This measures catalogue coverage, never security accuracy.
 */
export function buildNodeCoverage(samples: readonly NodeSample[]): NodeCoverage {
  const pairs = new Map<string, { row: NodeCoverageVersionRow; workflows: Set<string> }>();
  const types = new Map<string, { workflows: Set<string>; instances: number; versions: Set<string>; modelled: number; total: number }>();
  let instances = 0;

  for (const sample of samples) {
    const seenInWorkflow = new Set<string>();
    for (const node of sample.nodes) {
      instances += 1;
      // `unspecified` is deliberately not strict semver: the resolver refuses it, which is the
      // correct unmodelled outcome, not a scan failure.
      let modelled = false;
      try {
        modelled = resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, { nodeType: node.type, version: node.version }) !== null;
      } catch {
        modelled = false;
      }
      const key = `${node.type}\0${node.version}`;
      const pair = pairs.get(key) ?? { row: { nodeType: node.type, version: node.version, workflows: 0, instances: 0, semantics: modelled ? 'MODELLED' as const : 'UNMODELLED' as const }, workflows: new Set<string>() };
      pair.row = { ...pair.row, instances: pair.row.instances + 1 };
      pair.workflows.add(sample.entryId);
      pairs.set(key, pair);
      if (!seenInWorkflow.has(key)) {
        seenInWorkflow.add(key);
        pair.row = { ...pair.row, workflows: pair.row.workflows + 1 };
        pairs.set(key, pair);
      }
      const type = types.get(node.type) ?? { workflows: new Set<string>(), instances: 0, versions: new Set<string>(), modelled: 0, total: 0 };
      type.workflows.add(sample.entryId);
      type.instances += 1;
      type.versions.add(node.version);
      type.total += 1;
      if (modelled) type.modelled += 1;
      types.set(node.type, type);
    }
  }

  const versions = [...pairs.values()].map((pair) => pair.row)
    .sort((left, right) => compareCanonicalStrings(left.nodeType, right.nodeType) || compareCanonicalStrings(left.version, right.version));
  const unknownTypes: NodeCoverageUnknownType[] = [];
  let modelledTypes = 0;
  let partlyModelledTypes = 0;
  let unmodelledTypes = 0;
  for (const [nodeType, type] of [...types.entries()].sort(([left], [right]) => compareCanonicalStrings(left, right))) {
    if (type.modelled === type.total) modelledTypes += 1;
    else if (type.modelled > 0) partlyModelledTypes += 1;
    else {
      unmodelledTypes += 1;
      unknownTypes.push({
        nodeType,
        workflows: type.workflows.size,
        instances: type.instances,
        versions: [...type.versions].sort(compareCanonicalStrings),
      });
    }
  }

  return Object.freeze({
    observedNodeTypes: types.size,
    observedNodeInstances: instances,
    modelledTypes,
    partlyModelledTypes,
    unmodelledTypes,
    versions: Object.freeze(versions),
    unknownTypes: Object.freeze(unknownTypes),
  });
}
