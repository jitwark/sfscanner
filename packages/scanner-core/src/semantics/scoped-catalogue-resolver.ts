import type { ResolvedNodeSemanticsV2 } from './catalogue-schema';
import { parseStrictSemver, type StrictSemver } from './semver';
import { matchesVersionRange } from './version-range';
import { scopeRank, type ScopedCatalogueBundleV1, type SelectorScopeV1 } from './scoped-catalogue-schema';

/**
 * An observed selector dimension. UNKNOWN carries the reason, never a substitute value: an
 * unobserved resource or operation is not the same thing as a reviewed absence.
 */
export type ScopedKnown<T> =
  | Readonly<{ state: 'KNOWN'; value: T }>
  | Readonly<{ state: 'UNKNOWN'; reason: string }>;

export type ScopedRequirementV1 = Readonly<{
  nodeType: string;
  version: ScopedKnown<string>;
  resource: ScopedKnown<string | null>;
  operation: ScopedKnown<string | null>;
  capability: string;
}>;

/** A known-null value is a positive absence: only ABSENT matches it, EXACT never does. */
function selectorMatches(scope: SelectorScopeV1, value: string | null): boolean {
  switch (scope.kind) {
    case 'EXACT': return value !== null && value === scope.value;
    case 'ABSENT': return value === null;
    case 'ANY_REVIEWED': return true;
  }
}

/**
 * Resource rank dominates operation rank. Both ranks are 0..2, so base-3 packing preserves the
 * lexicographic order of the (resource, operation) pair without allocating a tuple per record.
 */
function specificity(resourceScope: SelectorScopeV1, operationScope: SelectorScopeV1): number {
  return scopeRank(resourceScope) * 3 + scopeRank(operationScope);
}

/**
 * Resolve one node requirement against the admitted scoped bundle. Returns the bundle's own frozen
 * record, or null when a dimension is UNKNOWN, the version does not parse or match, or the top
 * rank pair is shared by two records. Pure and deterministic: reads only its arguments.
 */
export function resolveScopedNodeSemantics(bundle: ScopedCatalogueBundleV1, query: ScopedRequirementV1): ResolvedNodeSemanticsV2 | null {
  const { version, resource, operation } = query;
  if (version.state !== 'KNOWN' || resource.state !== 'KNOWN' || operation.state !== 'KNOWN') return null;

  let parsed: StrictSemver;
  try {
    parsed = parseStrictSemver(version.value);
  } catch {
    return null;
  }

  let bestScore = -1;
  let winner: ResolvedNodeSemanticsV2 | null = null;
  let tied = false;
  for (const entry of bundle.records) {
    if (entry.record.nodeType !== query.nodeType) continue;
    if (!selectorMatches(entry.resourceScope, resource.value)) continue;
    if (!selectorMatches(entry.operationScope, operation.value)) continue;
    if (!matchesVersionRange(parsed, entry.record.versionRange)) continue;
    const score = specificity(entry.resourceScope, entry.operationScope);
    if (score > bestScore) {
      bestScore = score;
      winner = entry.record;
      tied = false;
    } else if (score === bestScore) {
      // Two records share the top pair: admission should have rejected this, so never pick one.
      tied = true;
    }
  }
  return tied ? null : winner;
}
