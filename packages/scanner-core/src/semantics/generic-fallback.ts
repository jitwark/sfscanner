import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJsonBytes } from '../canonical-json';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from './builtin-catalogue';
import { resolveNodeSemantics, validateSemanticNodeType } from './catalogue-resolver';
import type { ResolvedNodeSemanticsV2, SemanticCatalogueV2, SemanticProvenanceV2 } from './catalogue-schema';
import { admitScopedCatalogue } from './scoped-catalogue-admission';
import { resolveScopedNodeSemantics } from './scoped-catalogue-resolver';

/**
 * Generic semantic fallback for node types the admitted catalogue does not model.
 *
 * Before this module, an unmodelled node resolved to nothing: it was absent from the semantic view
 * and `capabilities/semantic-context.ts` raised `SEMANTIC_CATALOGUE_MISS` at requiredness, which
 * withheld the whole workflow's verdict (`assessment: null`). The catalogued node families are a
 * small subset of n8n's node types, so that refusal applied to nearly every real workflow even
 * though the parameter, credential and destination audits had already run.
 *
 * The fallback states the *assumption* instead of refusing: main-in → main-out passthrough, both
 * external effects, no claim about destinations, credentials kept where n8n keeps them, and
 * error/retry modes left at the catalogue's own conservative `UNKNOWN`. Parameter auditing does not
 * depend on this record — the structural policies read node parameters directly — so the fallback
 * changes what the engine assumes about data flow, never whether it looks. The workflow still
 * receives a coverage diagnostic per fallback node (`SEMANTIC_CATALOGUE_MISS` at degraded
 * requiredness, rendered by the report as `SEMANTIC_CATALOGUE_MISS · DEGRADED`); the decision record
 * is `docs/decisions/ADR-generic-node-semantic-fallback.md`.
 *
 * The record is not part of the admitted catalogue: adding it there would move the catalogue digest
 * pinned by the CLI, and the fallback is not a claim about n8n (no upstream page exists for it).
 * Provenance therefore binds to the contract text below rather than to source bytes.
 */
export const GENERIC_FALLBACK_SEMANTIC_ID = 'generic.fallback';

const CONTRACT = 'scanner-core generic node semantic fallback v1: main-in/main-out passthrough, READ_EXTERNAL + WRITE_EXTERNAL, unknown error/retry modes, no destination claim, parameters audited by the structural policies';
const PROVENANCE: SemanticProvenanceV2 = Object.freeze({
  sourceUrl: 'https://docs.n8n.io/',
  sourceDigest: bytesToHex(sha256(new TextEncoder().encode(CONTRACT))),
  reviewedAt: '2026-10-17',
  reviewer: 'scanner-core-generic-fallback',
});

export type NodeSemanticsQueryV2 = Readonly<{
  type: string;
  typeVersion?: string;
  /** The scanned node's parameter fields, in the normalized engine shape. */
  parameters: readonly Readonly<{ pointer: string; value: unknown }>[];
  scoringEligibility: 'ELIGIBLE' | 'INDETERMINATE';
}>;
export type NodeSemanticsResolutionV2 = Readonly<{
  semantics: ResolvedNodeSemanticsV2;
  origin: 'CATALOGUE' | 'GENERIC_FALLBACK';
}>;

/** Deep-freezes the record: the semantic view's consumers validate frozen plain data. */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return value;
    seen.add(value);
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * The conservative record for one unmodelled node type. `nodeType` must be the scanned node's own
 * type: `analyzers/destinations/inventory.ts` refuses a record whose `nodeType` does not match.
 */
export function createGenericFallbackSemantics(nodeType: string): ResolvedNodeSemanticsV2 {
  return deepFreeze<ResolvedNodeSemanticsV2>({
    semanticId: GENERIC_FALLBACK_SEMANTIC_ID,
    nodeType,
    versionRange: { clauses: [[{ op: 'GTE', version: '1.0.0' }]] },
    operation: null,
    entry: 'NONE',
    parameterPaths: [],
    authentication: null,
    credentialPaths: ['/credentials'],
    destinationPaths: [],
    effects: ['READ_EXTERNAL', 'WRITE_EXTERNAL'],
    endpoints: [],
    ports: [{ type: 'main', index: 0, itemMode: 'EACH' }],
    overwritePaths: [],
    errorMode: 'UNKNOWN',
    retryMode: 'UNKNOWN',
    disabledMode: 'SKIP',
    provenance: PROVENANCE,
  });
}

const SCOPED_GMAIL_TYPE = 'n8n-nodes-base.gmail';
const SCOPED_GMAIL_VERSION = '2.2.0';
// Pinned from Gmail MessageDescription.js in n8n-nodes-base@2.15.1. `sendAndWait` is deliberately
// absent: its operation value is imported from n8n-workflow and is not asserted by this receipt, so
// it stays on the conservative generic fallback rather than inheriting an unreviewed scope.
const SCOPED_GMAIL_MESSAGE_OPERATIONS = Object.freeze([
  'addLabels', 'delete', 'get', 'getAll', 'markAsRead', 'markAsUnread', 'removeLabels', 'reply', 'send',
]);
const SCOPED_GMAIL_RECORD = resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, {
  nodeType: SCOPED_GMAIL_TYPE, version: SCOPED_GMAIL_VERSION, operation: null,
});
if (SCOPED_GMAIL_RECORD === null) throw new TypeError('Missing Gmail pilot record');
const SCOPED_GMAIL_MESSAGE_EVIDENCE = Object.freeze({
  file: 'dist/nodes/Google/Gmail/v2/MessageDescription.js',
  sha256: '1983d7d70037b76f1d5bd7ea8597141372f01da27f85ddd53d97e3353bb407a9',
  operations: SCOPED_GMAIL_MESSAGE_OPERATIONS,
});
const SCOPED_GMAIL_BODY = {
  schemaVersion: '1' as const,
  records: [{
    record: { ...SCOPED_GMAIL_RECORD, versionRange: { clauses: [[{ op: 'EQ' as const, version: SCOPED_GMAIL_VERSION }]] } },
    resourceScope: { kind: 'EXACT' as const, value: 'message' },
    operationScope: { kind: 'ANY_REVIEWED' as const },
  }],
  scopeReceipts: [{
    semanticId: 'message-mcp.gmail',
    dimension: 'OPERATION' as const,
    evidenceDigest: bytesToHex(sha256(canonicalJsonBytes(SCOPED_GMAIL_MESSAGE_EVIDENCE))),
  }],
};
export const SCOPED_GMAIL_BUNDLE_DIGEST = bytesToHex(sha256(canonicalJsonBytes(SCOPED_GMAIL_BODY)));
export const SCOPED_GMAIL_BUNDLE = admitScopedCatalogue({ ...SCOPED_GMAIL_BODY, digest: SCOPED_GMAIL_BUNDLE_DIGEST });

/** Exact reviewed scopes only; never substitutes a legacy or generic catalogue resolution. */
export function resolveReviewedScopedSemantics(query: NodeSemanticsQueryV2): ResolvedNodeSemanticsV2 | null {
  return resolveScopedPilot(query) ?? null;
}

export function reviewedScopedSemanticsAreIntact(expectedDigest: string): boolean {
  try {
    const admitted = admitScopedCatalogue(SCOPED_GMAIL_BUNDLE);
    return expectedDigest === SCOPED_GMAIL_BUNDLE_DIGEST && admitted.digest === expectedDigest
      && bytesToHex(sha256(canonicalJsonBytes(SCOPED_GMAIL_BODY))) === expectedDigest;
  } catch { return false; }
}

function scopedField(query: NodeSemanticsQueryV2, selector: 'resource' | 'operation'): { present: boolean; value: string | null } {
  const path = selector === 'resource'
    ? /^\/nodes\/(?:0|[1-9]\d*)\/parameters\/resource$/
    : /^\/nodes\/(?:0|[1-9]\d*)\/parameters\/operation$/;
  const fields = query.parameters.filter((candidate) => path.test(candidate.pointer));
  const field = fields.length === 1 ? fields[0] : undefined;
  return { present: fields.length > 0, value: typeof field?.value === 'string' ? field.value : null };
}

function resolveScopedPilot(query: NodeSemanticsQueryV2): ResolvedNodeSemanticsV2 | null | undefined {
  if (query.type !== SCOPED_GMAIL_TYPE || query.typeVersion !== SCOPED_GMAIL_VERSION) return undefined;
  if (query.scoringEligibility !== 'ELIGIBLE') return null;
  const resourceField = scopedField(query, 'resource');
  const operationField = scopedField(query, 'operation');
  // The pinned resource default applies only when no direct resource member exists. Nested,
  // dynamic, unreadable, or duplicate selector members cannot supply the reviewed scope.
  const resource = resourceField.present ? resourceField.value : 'message';
  const scopedOperation = operationField.value;
  if (resource === null || scopedOperation === null) return null;
  // The scope receipt reviews these operations; sendAndWait is deliberately outside it.
  if (!SCOPED_GMAIL_MESSAGE_OPERATIONS.includes(scopedOperation)) return null;
  return resolveScopedNodeSemantics(SCOPED_GMAIL_BUNDLE, {
    nodeType: query.type,
    version: { state: 'KNOWN', value: SCOPED_GMAIL_VERSION },
    resource: { state: 'KNOWN', value: resource },
    operation: { state: 'KNOWN', value: scopedOperation },
    capability: 'NODE_OBSERVED',
  });
}

/**
 * The one per-node resolution both seams use (`v2/scan-workflow.ts` builds the admitted view from
 * it; `capabilities/semantic-context.ts` derives the coverage diagnostics from it), so a node can
 * never be fallback-covered in one seam and missing in the other.
 *
 * `null` means genuinely unresolvable: the node's fields were not readable
 * (`scoringEligibility: 'INDETERMINATE'`), and the caller keeps the fail-closed miss. A node whose
 * `type` member itself was unreadable never reaches this decision — the resolver refuses an empty
 * node type and the scan fails closed with `SEMANTIC_CATALOGUE_INVALID`.
 */
export function resolveNodeSemanticsForScan(
  catalogue: SemanticCatalogueV2,
  query: NodeSemanticsQueryV2,
): NodeSemanticsResolutionV2 | null {
  // Preserve operation/action compatibility for the legacy catalogue lookup. The scoped Gmail
  // pilot reads its own exact direct selectors and cannot inherit this action fallback.
  const operationField = query.parameters.find((field) => field.pointer.endsWith('/operation'));
  const actionField = query.parameters.find((field) => field.pointer.endsWith('/action'));
  const operation = typeof operationField?.value === 'string' ? operationField.value : actionField?.value;
  // A node whose `type` member was unreadable must fail closed through the catalogue's own
  // node-type rule: duplicate `type` members normalize to '', while other unreadable strings stay
  // non-empty, so the shared validator rejects both. An absent version must not turn an unreadable
  // type into a degraded miss, and no version is fabricated to reach the resolver.
  const scoped = resolveScopedPilot(query);
  if (scoped !== undefined) {
    if (scoped !== null) return Object.freeze({ semantics: scoped, origin: 'CATALOGUE' as const });
    if (query.scoringEligibility !== 'ELIGIBLE') return null;
    return Object.freeze({ semantics: createGenericFallbackSemantics(query.type), origin: 'GENERIC_FALLBACK' as const });
  }
  let semantics: ResolvedNodeSemanticsV2 | null;
  if (typeof query.typeVersion === 'string') {
    // The query is built only from an observed version: substituting `1.0.0` asserted the broad
    // `GTE 1.0.0` catalogue record for a node whose version was never read. A present but
    // unparseable string still reaches the resolver's own validation.
    semantics = resolveNodeSemantics(catalogue, {
      nodeType: query.type,
      version: query.typeVersion,
      operation: typeof operation === 'string' ? operation : null,
    });
  } else {
    // A member the normalizer omitted (malformed) also skips the lookup, but never the type rule.
    validateSemanticNodeType(query.type);
    semantics = null;
  }
  if (semantics !== null) return Object.freeze({ semantics, origin: 'CATALOGUE' as const });
  if (query.scoringEligibility !== 'ELIGIBLE') return null;
  return Object.freeze({ semantics: createGenericFallbackSemantics(query.type), origin: 'GENERIC_FALLBACK' as const });
}
