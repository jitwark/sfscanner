import type { ResolvedNodeSemanticsV2 } from './catalogue-schema';

/**
 * Q02.R1 scoped selector scope: what a record's review actually covered on one
 * selector dimension. ANY_REVIEWED is never a default — admission requires a
 * matching receipt, so neutrality is evidence-gated rather than assumed.
 */
export type SelectorScopeV1 =
  | Readonly<{ kind: 'ABSENT' }>
  | Readonly<{ kind: 'EXACT'; value: string }>
  | Readonly<{ kind: 'ANY_REVIEWED' }>;

export type ScopedRecordV1 = Readonly<{
  record: ResolvedNodeSemanticsV2;
  resourceScope: SelectorScopeV1;
  operationScope: SelectorScopeV1;
}>;

export type ScopeDimensionV1 = 'RESOURCE' | 'OPERATION';

export type ScopeReceiptV1 = Readonly<{ semanticId: string; dimension: ScopeDimensionV1; evidenceDigest: string }>;

export type ScopedCatalogueBodyV1 = Readonly<{
  schemaVersion: '1';
  records: readonly ScopedRecordV1[];
  scopeReceipts: readonly ScopeReceiptV1[];
}>;

export type ScopedCatalogueBundleV1 = ScopedCatalogueBodyV1 & Readonly<{ digest: string }>;

/**
 * Specificity rank for the R2 resolver. For a known-absent selector both ABSENT
 * and ANY_REVIEWED apply; ABSENT is the positive observation and outranks the
 * reviewed-but-unobserved claim (owner-frozen rationale).
 */
export function scopeRank(scope: SelectorScopeV1): 0 | 1 | 2 {
  switch (scope.kind) {
    case 'EXACT': return 2;
    case 'ABSENT': return 1;
    case 'ANY_REVIEWED': return 0;
  }
}
