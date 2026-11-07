import { DEFAULT_SCANNER_LIMITS_V2, type ScannerLimitsV2 } from '@hub/contracts';
import crypto from 'node:crypto';
import { parseSourceDocument } from '../../packages/scanner-core/src/source/source-parser.js';
import { normalizeSecurityWorkflow } from '../../packages/scanner-core/src/workflow-v2/normalize-security-workflow.js';
import { validateSemanticNodeType, resolveNodeSemantics } from '../../packages/scanner-core/src/semantics/catalogue-resolver.js';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from '../../packages/scanner-core/src/semantics/builtin-catalogue.js';
import { resolveReviewedScopedSemantics } from '../../packages/scanner-core/src/semantics/generic-fallback.js';
import { BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2, SEMANTIC_CATALOGUE_DIGEST_V2, ENGINE_BUILD_DIGEST_V2, authorityIsIntact } from '../../packages/scanner-core/src/v2/admitted-registry.js';
import type { CorpusV2InputInventory } from '../../scripts/lib/corpus-v2-input-inventory.js';

export type Q02ExclusionReason = 'MALFORMED' | 'MISSING' | 'SOURCE_UNAVAILABLE' | 'COMMUNITY_PACKAGE' | 'INVALID_NODE_IDENTITY' | 'NO_EXECUTABLE_NODE' | 'REJECTED_INPUT';
export type FormalNodeSample = Readonly<{
  entryId: string; bodySha256: string; byteLength: number; exclusion: Q02ExclusionReason | null;
  executableInstances: number | null; reviewedExecutableInstances: number | null; reviewedInertNodes: number; disabledNodes: number;
  resourceRefusal?: Readonly<{ stage: 'SOURCE' | 'NORMALIZATION'; code: 'WORKFLOW_TOO_LARGE' | 'WORKFLOW_TOO_COMPLEX'; cause?: string }>;
}>;
export type FormalMeasurementContext = Readonly<{
  limits: ScannerLimitsV2; lockfileSha256: string;
  runtime: Readonly<{ node: string; v8: string; platform: string; arch: string; loaderArgumentsSha256: string }>;
  tools: Readonly<Record<string, string>>;
}>;
export type FormalCoverageBinding = Readonly<{
  inventoryFileSha256: string; inventorySha256: string; bodyMapSha256: string;
  scopedSemanticsDigest: string; legacySemanticsDigest: string; engineBuildDigest: string;
  sourceReceiptSha256: string; producerSourceSha256: string; sourceBindingsSha256: string;
  measurementContextSha256: string; executionContext: FormalMeasurementContext;
}>;
const hash = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const order = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const official = (type: string) => type.startsWith('n8n-nodes-base.') || type.startsWith('@n8n/n8n-nodes-langchain.');

/** Exact existing source-backed annotation scope, verified from the pinned upstream package. */
function reviewedInert(type: string, version?: string): boolean {
  if (type !== 'n8n-nodes-base.stickyNote' || version !== '1.0.0') return false;
  const resolved = resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, { nodeType: type, version, operation: null });
  return resolved?.semanticId === 'annotation.sticky-note' && resolved.ports.length === 0 && resolved.effects.length === 0;
}

/** Retains counts only. The engine parser/normalizer preserve duplicate selectors and eligibility. */
export function projectFormalNodeSample(entryId: string, bytes: Uint8Array): FormalNodeSample {
  const base = { entryId, bodySha256: hash(bytes), byteLength: bytes.length,
    executableInstances: 0, reviewedExecutableInstances: 0, reviewedInertNodes: 0, disabledNodes: 0 };
  const parsed = parseSourceDocument(bytes, DEFAULT_SCANNER_LIMITS_V2);
  if (!parsed.ok) return parsed.code === 'WORKFLOW_TOO_LARGE' || parsed.code === 'WORKFLOW_TOO_COMPLEX'
    ? { ...base, exclusion: null, executableInstances: null, reviewedExecutableInstances: null,
      resourceRefusal: { stage: 'SOURCE', code: parsed.code, ...('cause' in parsed ? { cause: parsed.cause } : {}) } }
    : { ...base, exclusion: 'MALFORMED' };
  const normalized = normalizeSecurityWorkflow(parsed.document, DEFAULT_SCANNER_LIMITS_V2);
  if (!normalized.ok) return normalized.code === 'WORKFLOW_TOO_COMPLEX'
    ? { ...base, exclusion: null, executableInstances: null, reviewedExecutableInstances: null,
      resourceRefusal: { stage: 'NORMALIZATION', code: normalized.code, cause: normalized.cause } }
    : { ...base, exclusion: 'MALFORMED' };
  const { workflow } = normalized;
  if (workflow.ambiguities.some((ambiguity) => ambiguity.kind === 'AMBIGUOUS_NODE'
    || (ambiguity.kind === 'DUPLICATE_MEMBER' && ['/nodes', '/connections'].includes(ambiguity.subject.pointer)))) {
    return { ...base, exclusion: 'INVALID_NODE_IDENTITY' };
  }
  const ambiguousFields = new Set(workflow.ambiguities.filter((ambiguity) => ambiguity.kind === 'DUPLICATE_MEMBER'
    || ambiguity.kind === 'MALFORMED_SECURITY_VALUE').map((ambiguity) => ambiguity.subject.pointer));
  let community = false;
  for (const node of workflow.nodes) {
    try { validateSemanticNodeType(node.type); }
    catch { return { ...base, exclusion: 'INVALID_NODE_IDENTITY' }; }
    // An ambiguous disabled flag is not proof a node is non-executable.
    if (node.disabled && !ambiguousFields.has(`${node.ref.source.pointer}/disabled`)) { base.disabledNodes += 1; continue; }
    if (node.scoringEligibility === 'ELIGIBLE' && reviewedInert(node.type, node.typeVersion)) { base.reviewedInertNodes += 1; continue; }
    if (!official(node.type)) community = true;
    base.executableInstances += 1;
    if (resolveReviewedScopedSemantics(node) !== null) base.reviewedExecutableInstances += 1;
  }
  return { ...base, exclusion: community ? 'COMMUNITY_PACKAGE' : base.executableInstances === 0 ? 'NO_EXECUTABLE_NODE' : null };
}

export function coverageRate(numerator: number, denominator: number, target: 90 | 95) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 0 || denominator < numerator) {
    throw new Error('Formal coverage: invalid integer counts');
  }
  return { numerator, denominator, ratio: denominator === 0 ? null : numerator / denominator,
    meetsTarget: denominator > 0 && BigInt(numerator) * 100n >= BigInt(denominator) * BigInt(target) };
}

export function sourceBindingsDigest(inventory: CorpusV2InputInventory): string {
  return hash(JSON.stringify([...inventory.rows].sort((a, b) => order(a.entryId, b.entryId)).map((row) => ({
    entryId: row.entryId, identityKind: row.identityKind, bodySha256: row.bodySha256, byteLength: row.byteLength,
    sourceCommit: row.sourceCommit, sourcePath: row.sourcePath, status: row.status, reasonCode: row.reasonCode,
  }))));
}

/** Private report only. Legacy public NodeCoverage is intentionally independent. */
export function buildFormalNodeCoverage(inventory: CorpusV2InputInventory, samples: readonly FormalNodeSample[], binding: FormalCoverageBinding, expected: FormalCoverageBinding = binding) {
  if (!authorityIsIntact() || Object.keys(binding).length !== 11
    || Object.entries(binding).some(([key, value]) => key !== 'executionContext' && (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)))
    || JSON.stringify(binding) !== JSON.stringify(expected)
    || binding.measurementContextSha256 !== hash(JSON.stringify(binding.executionContext))
    || JSON.stringify(binding.executionContext.limits) !== JSON.stringify(DEFAULT_SCANNER_LIMITS_V2)
    || binding.inventorySha256 !== inventory.inventorySha256 || binding.sourceBindingsSha256 !== sourceBindingsDigest(inventory)
    || binding.scopedSemanticsDigest !== BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2.digest
    || binding.legacySemanticsDigest !== SEMANTIC_CATALOGUE_DIGEST_V2 || binding.engineBuildDigest !== ENGINE_BUILD_DIGEST_V2
    || binding.sourceReceiptSha256 !== BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2.sourceReceiptSha256) {
    throw new Error('Formal coverage: input/source/authority binding mismatch');
  }
  const rows = new Map(inventory.rows.map((row) => [row.entryId, row]));
  const sampleOf = new Map(samples.map((sample) => [sample.entryId, sample]));
  if (rows.size !== inventory.rows.length || sampleOf.size !== samples.length || samples.some((sample) => !rows.has(sample.entryId))) {
    throw new Error('Formal coverage: duplicate or unknown input identity');
  }
  if (samples.some((sample) => !sample.entryId || !/^[0-9a-f]{64}$/.test(sample.bodySha256)
    || [sample.byteLength, sample.reviewedInertNodes, sample.disabledNodes].some((count) => !Number.isSafeInteger(count) || count < 0)
    || (sample.resourceRefusal ? sample.exclusion !== null || sample.executableInstances !== null || sample.reviewedExecutableInstances !== null
      : sample.executableInstances === null || sample.reviewedExecutableInstances === null
        || !Number.isSafeInteger(sample.executableInstances) || !Number.isSafeInteger(sample.reviewedExecutableInstances)
        || sample.executableInstances < 0 || sample.reviewedExecutableInstances < 0
        || sample.reviewedExecutableInstances > sample.executableInstances
        || (sample.exclusion === null && sample.executableInstances === 0)))) throw new Error('Formal coverage: invalid sample counts or identity');
  const inventoryStatuses = { AVAILABLE: 0, MISSING: 0, SOURCE_UNAVAILABLE: 0, UNPARSEABLE: 0, REJECTED: 0 };
  for (const row of rows.values()) {
    if (!row.entryId || !(row.status in inventoryStatuses)) throw new Error('Formal coverage: invalid inventory identity/status');
    inventoryStatuses[row.status] += 1;
  }
  if (Object.keys(inventoryStatuses).some((status) => inventoryStatuses[status as keyof typeof inventoryStatuses] !== inventory.counts[status as keyof typeof inventoryStatuses])) {
    throw new Error('Formal coverage: inventory count mismatch');
  }
  const counts = { cohortWorkflows: 0, workflowsWithExecutableNodes: 0, executableInstances: 0,
    reviewedExecutableInstances: 0, fullyModelledWorkflows: 0, reviewedInertNodes: 0 };
  const wholeCorpus = { inventoryRows: rows.size, availableBodies: 0, missing: 0, sourceUnavailable: 0,
    malformed: 0, rejected: 0, measurementUnknown: 0, communityPackage: 0, invalidNodeIdentity: 0, noExecutableNode: 0, formalCohort: 0, disabledNodes: 0, reviewedInertNodes: 0, inventoryStatuses };
  const exclusions: { entryId: string; reason: Q02ExclusionReason; reasonCode?: string | null }[] = [];
  const unknownMeasurements: ({ entryId: string } & NonNullable<FormalNodeSample['resourceRefusal']>)[] = [];
  for (const row of [...rows.values()].sort((a, b) => order(a.entryId, b.entryId))) {
    const sample = sampleOf.get(row.entryId);
    if (sample && (sample.bodySha256 !== row.bodySha256 || sample.byteLength !== row.byteLength)) {
      throw new Error('Formal coverage: body hash/length mismatch');
    }
    if (row.status === 'AVAILABLE' && !sample) throw new Error('Formal coverage: missing examined input sample');
    let reason: Q02ExclusionReason | null;
    switch (row.status) {
      case 'MISSING': wholeCorpus.missing += 1; reason = 'MISSING'; break;
      case 'SOURCE_UNAVAILABLE': wholeCorpus.sourceUnavailable += 1; reason = 'SOURCE_UNAVAILABLE'; break;
      case 'UNPARSEABLE': reason = 'MALFORMED'; break;
      case 'REJECTED': wholeCorpus.rejected += 1; reason = 'REJECTED_INPUT'; break;
      case 'AVAILABLE': wholeCorpus.availableBodies += 1; reason = sample!.exclusion; break;
      default: throw new Error('Formal coverage: unsupported input status');
    }
    if (sample) wholeCorpus.disabledNodes += sample.disabledNodes;
    if (sample) wholeCorpus.reviewedInertNodes += sample.reviewedInertNodes;
    if (row.status === 'AVAILABLE' && sample?.resourceRefusal) {
      wholeCorpus.measurementUnknown += 1;
      unknownMeasurements.push({ entryId: row.entryId, ...sample.resourceRefusal });
      continue;
    }
    if (reason !== null) {
      if (reason === 'MALFORMED') wholeCorpus.malformed += 1;
      if (reason === 'COMMUNITY_PACKAGE') wholeCorpus.communityPackage += 1;
      if (reason === 'INVALID_NODE_IDENTITY') wholeCorpus.invalidNodeIdentity += 1;
      if (reason === 'NO_EXECUTABLE_NODE') wholeCorpus.noExecutableNode += 1;
      exclusions.push({ entryId: row.entryId, reason, ...(reason === 'REJECTED_INPUT' ? { reasonCode: row.reasonCode } : {}) }); continue;
    }
    counts.cohortWorkflows += 1; counts.workflowsWithExecutableNodes += 1;
    counts.executableInstances += sample!.executableInstances!;
    counts.reviewedExecutableInstances += sample!.reviewedExecutableInstances!;
    counts.reviewedInertNodes += sample!.reviewedInertNodes;
    if (sample!.executableInstances === sample!.reviewedExecutableInstances) counts.fullyModelledWorkflows += 1;
  }
  wholeCorpus.formalCohort = counts.cohortWorkflows;
  const instances = coverageRate(counts.reviewedExecutableInstances, counts.executableInstances, 95);
  const workflows = coverageRate(counts.fullyModelledWorkflows, counts.workflowsWithExecutableNodes, 90);
  const incomplete = unknownMeasurements.length > 0;
  if (counts.cohortWorkflows + exclusions.length + unknownMeasurements.length !== rows.size) throw new Error('Formal coverage: row conservation failed');
  return { schemaVersion: 'q02-formal-coverage-v1' as const,
    status: incomplete ? 'INCOMPLETE' as const : 'COMPLETE' as const,
    countsScope: incomplete ? 'EXAMINED_COHORT_ONLY' as const : 'FULL_COHORT' as const,
    cohort: { id: 'q02-official-nodes-v1', ruleVersion: 'executable-official-scoped-v1', namespaces: ['n8n-nodes-base', '@n8n/n8n-nodes-langchain'] },
    binding, counts, rates: {
      reviewedExecutableInstances: { numerator: incomplete ? null : instances.numerator, denominator: incomplete ? null : instances.denominator, ratio: incomplete ? null : instances.ratio, meets95Percent: !incomplete && instances.meetsTarget },
      fullyModelledWorkflows: { numerator: incomplete ? null : workflows.numerator, denominator: incomplete ? null : workflows.denominator, ratio: incomplete ? null : workflows.ratio, meets90Percent: !incomplete && workflows.meetsTarget },
    }, exclusions, unknownMeasurements, wholeCorpus };
}
export type Q02FormalCoverageV1 = ReturnType<typeof buildFormalNodeCoverage>;
