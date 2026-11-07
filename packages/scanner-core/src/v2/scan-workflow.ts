import { record, domainList, advisoryRequest } from './scan-request-data';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DEFAULT_SCANNER_LIMITS_V2, MEASURED_LIMIT_IDS, type ScannerLimitsV2 } from '@hub/contracts';
import { canonicalJsonBytes } from '../canonical-json';
import { parseSourceDocument } from '../source/source-parser';
import { resolveScannerLimits } from '../source/scanner-limit-resolution';
import type { ReadonlySourceDocumentV2, SourceSpanUsageV2 } from '../source/source-types';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import type { SecurityWorkflowResult, SecurityWorkflowV2 } from '../workflow-v2/security-workflow';
import { validateTargetContextV3, type TargetContextV3 } from '../semantics/target-context';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from '../semantics/builtin-catalogue';
import { resolveNodeSemanticsForScan } from '../semantics/generic-fallback';
import { SemanticCatalogueAdmissionError } from '../semantics/catalogue-admission';
import type { ResolvedNodeSemanticsV2 } from '../semantics/catalogue-schema';
import { createDiagnostic } from '../capabilities/adapter-evidence';
import { buildAdvisoryFactsV1, type AdvisoryRequestV3 } from '../advisories/advisory-evaluation';
import { resolveAnalyzerSemanticContext, type SemanticContextV2 } from '../capabilities/semantic-context';
import { toNativeWorkflow } from '../capabilities/adapter-workflow';
import { scanCapabilitiesV2 } from '../capabilities/beta-default';
import { createScanLocalTaint } from '../analyzers/taint/scan-local-taint';
import { produceScanLocalTaintV1 } from '../analyzers/taint/scan-local-producer';
import { compileWorkflowFlowWitnesses, createFieldFlowAccessorV1 } from '../analyzers/taint/scan-local-workflow-flow-witnesses';
import { createBetaHardenedCapabilityRegistry } from '../capabilities/beta-hardened';
import type { AdmittedRuleV2, AnalyzerContextV2, CapabilityCandidateV2, CapabilityExecutionV2, SemanticCatalogueViewV2 } from '../capabilities/scheduler';
import { composeScannerResultV2 } from '../result-v2/compose-result';
import { createFindingId } from '../result-v2/identities';
import { rekeyCandidates, rekeyFacts } from '../result-v2/rekey-evidence';
import { resolveRuleAuthorityV2 } from '../rules-v2/rule-authority';
import { analyzeWorkflowInsights } from '../scan-insights';
import { scoreFindingsV2 } from '../result-v2/scoring';
import type { FindingV2, AnalysisDiagnosticV2 } from '../../../../contracts/scanner-v2-evidence';
import type { ScannerResultV2 } from '../../../../contracts/scanner-v2-result';
import {
  ADMITTED_ENGINE_ID, ADMITTED_ENGINE_VERSION, ADMITTED_PROFILE_ID, ADMITTED_PROFILE_VERSION,
  BUILTIN_RULESET_AUTHORITY_V2, BUILTIN_SEMANTICS_AUTHORITY_V2, ENGINE_BUILD_DIGEST_V2,
  authorityIsIntact, createAdmittedCapabilityRegistry, createAdmittedRuleView, createAdmittedSemanticView,
  PROFILE_MANIFEST_DIGEST_V2,
} from './admitted-registry';
import { BETA_DEFAULT_PROFILE_MANIFEST } from '../capabilities/profile-manifest';
import { classifyBudgetOutcome } from '../workflow-v2/budget-outcomes';
import { spanLossIsSecurityRequired } from './span-loss-classification';
import { extractAdmittedBytes } from './scan-request-bytes';
export type ScanWorkflowV2FailureCode = 'UTF8_DECODING_FAILED' | 'INVALID_JSON' | 'MALFORMED_WORKFLOW' | 'WORKFLOW_TOO_LARGE' | 'WORKFLOW_TOO_COMPLEX' | 'INVALID_CONFIG' | 'UNKNOWN_CONFIGURATION_KEY' | 'PROFILE_NOT_ADMITTED' | 'SEMANTIC_CATALOGUE_INVALID' | 'SEMANTIC_CATALOGUE_AMBIGUOUS' | 'RULE_PACK_INVALID' | 'RULE_PACK_UNTRUSTED' | 'TOOL_INVARIANT_FAILED' | 'SERIALIZATION_FAILED' | 'SCAN_TIMEOUT' | 'SCAN_CANCELLED';
export type ScanWorkflowV2Failure = Readonly<{ ok: false; code: ScanWorkflowV2FailureCode; message: string; cause?: string; errors?: readonly string[] }>;
export type ScanWorkflowV2Success = Readonly<{ ok: true; result: ScannerResultV2 }>;
export type ScanWorkflowV2Request = Readonly<{ bytes: Uint8Array; profile: Readonly<{ id: string; version: string }>; target?: unknown; limits?: unknown; approvedDomains?: readonly string[] }>;
export type ScanWorkflowV2Result = ScanWorkflowV2Success | ScanWorkflowV2Failure;

type PreparedRequest = { bytes: Uint8Array; target: TargetContextV3; limits: ScannerLimitsV2; approvedDomains: readonly string[]; advisoryRequest?: AdvisoryRequestV3 };
type NormalizedSuccess = Extract<SecurityWorkflowResult, { ok: true }>;
const REQUEST_KEYS = ['bytes', 'profile', 'target', 'limits', 'approvedDomains', 'advisoryRequest'] as const;
const PROFILE_KEYS = ['id', 'version'] as const;
const LIMIT_KEYS = Object.freeze(Object.getOwnPropertyNames(DEFAULT_SCANNER_LIMITS_V2));

const failure = (code: ScanWorkflowV2FailureCode, message: string, cause?: string): ScanWorkflowV2Failure => Object.freeze({ ok: false, code, message, ...(cause === undefined ? {} : { cause }) });

function prepared(input: unknown): PreparedRequest | ScanWorkflowV2Failure {
  const root = record(input, REQUEST_KEYS, ['bytes', 'profile']); if (!root) return failure('INVALID_CONFIG', 'Scanner request is not a closed data object.');
  const profile = record(root.profile, PROFILE_KEYS, ['id', 'version']);
  if (!profile || typeof profile.id !== 'string' || typeof profile.version !== 'string') return failure('INVALID_CONFIG', 'Scanner profile reference is malformed.');
  if (profile.id !== ADMITTED_PROFILE_ID || profile.version !== ADMITTED_PROFILE_VERSION) return failure('PROFILE_NOT_ADMITTED', 'Scanner profile is not admitted.');
  const partialLimits = root.limits === undefined ? undefined : record(root.limits, LIMIT_KEYS);
  if (root.limits !== undefined && !partialLimits) return failure('INVALID_CONFIG', 'Scanner limits are malformed.');
  const limits = resolveScannerLimits(partialLimits); if (!limits) return failure('INVALID_CONFIG', 'Scanner limits are invalid.');
  const byteExtraction = extractAdmittedBytes(root.bytes, limits.maxBytes);
  if (!byteExtraction.ok) return byteExtraction.failure;
  const bytes = byteExtraction.bytes;
  const approvedDomains = root.approvedDomains === undefined ? [] : domainList(root.approvedDomains);
  if (approvedDomains === undefined) return failure('INVALID_CONFIG', 'Scanner approved domains are malformed.');
  const rawTarget = root.target === undefined ? { schemaVersion: 'scanner-target-v3', edition: 'UNKNOWN', deployment: 'UNKNOWN', role: 'UNKNOWN', taskRunner: 'UNKNOWN', communityPackages: [], configuration: [] } : record(root.target, ['schemaVersion', 'n8nVersion', 'edition', 'deployment', 'role', 'taskRunner', 'communityPackages', 'configuration', 'contextDigest']);
  if (!rawTarget) return failure('INVALID_CONFIG', 'Scanner target is malformed.');
  const advisory = root.advisoryRequest === undefined ? undefined : advisoryRequest(root.advisoryRequest);
  if (root.advisoryRequest !== undefined && advisory === undefined) return failure('INVALID_CONFIG', 'Scanner advisory request is malformed.');
  try { return { bytes, limits, approvedDomains, target: validateTargetContextV3(rawTarget, { allowedConfigurationKeys: BUILTIN_SEMANTIC_CATALOGUE_V2.configurationKeys }), ...(advisory === undefined ? {} : { advisoryRequest: advisory }) }; }
  catch (error) { const reason = error instanceof Error ? error.message : ''; return failure(reason.includes('UNKNOWN_CONFIGURATION_KEY') ? 'UNKNOWN_CONFIGURATION_KEY' : 'INVALID_CONFIG', 'Scanner target is invalid.'); }
}
function semanticView(workflow: SecurityWorkflowV2): { view: SemanticCatalogueViewV2 } | ScanWorkflowV2Failure {
  const resolved = new Map<string, ResolvedNodeSemanticsV2>();
  try {
    for (const node of workflow.nodes) {
      const resolution = resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, node);
      if (resolution) resolved.set(node.ref.identityDigest, resolution.semantics);
    }
    return { view: createAdmittedSemanticView(resolved) };
  } catch (error) { return semanticCatalogueFailure(error); }
}
function semanticCatalogueFailure(error: unknown): ScanWorkflowV2Failure {
  const ambiguous = error instanceof SemanticCatalogueAdmissionError ? error.code === 'SEMANTIC_CATALOGUE_AMBIGUOUS' : error instanceof Error && error.message.includes('SEMANTIC_CATALOGUE_AMBIGUOUS');
  return failure(ambiguous ? 'SEMANTIC_CATALOGUE_AMBIGUOUS' : 'SEMANTIC_CATALOGUE_INVALID', 'Built-in semantic catalogue admission failed.');
}
function ambiguityDiagnostics(workflow: SecurityWorkflowV2): readonly AnalysisDiagnosticV2[] {
  return workflow.ambiguities.map((ambiguity) => createDiagnostic(ambiguity.kind === 'UNRESOLVED_EDGE' || ambiguity.kind === 'AMBIGUOUS_EDGE' ? 'MALFORMED_CONNECTION_INDEX' : ambiguity.kind === 'DUPLICATE_MEMBER' && ambiguity.securityImpact === 'METADATA_ONLY' ? 'DUPLICATE_METADATA_KEY' : ambiguity.kind === 'MALFORMED_SECURITY_VALUE' ? 'MALFORMED_NODE_PARAMETERS' : 'DUPLICATE_SECURITY_KEY', 'source-normalization', true, ambiguity.subject));
}
function addDiagnostics(schedule: { executions: readonly CapabilityExecutionV2[]; candidates: readonly CapabilityCandidateV2[]; diagnostics: readonly AnalysisDiagnosticV2[] }, diagnostics: readonly AnalysisDiagnosticV2[], semanticSha256?: string): typeof schedule {
  const candidates = semanticSha256 === undefined ? schedule.candidates : rekeyCandidates(schedule.candidates, semanticSha256);
  if (diagnostics.length === 0) return { ...schedule, candidates };
  // Keep diagnostic lower bounds in capability work counters without counting them as omitted findings.
  const executions = schedule.executions.map((execution) => {
    const owned = diagnostics.filter((diagnostic) => diagnostic.capabilityId === execution.id), omitted = Math.max(execution.omitted, ...owned.map((diagnostic) => diagnostic.omitted ?? 0));
    return owned.length === 0 && omitted === execution.omitted ? execution : Object.freeze({ ...execution, omitted, diagnosticIds: Object.freeze([...execution.diagnosticIds, ...owned.map(({ id }) => id)]) });
  });
  return { executions: Object.freeze(executions), candidates, diagnostics: Object.freeze([...schedule.diagnostics, ...diagnostics.filter(({ id }) => !schedule.diagnostics.some((prior) => prior.id === id))]) };
}
/**
 * The stored-span budget is the one bound a successful run can truncate against, so its loss is
 * classified by the budget registry rather than assumed: a presentation-only loss degrades, while a
 * loss that removed the spans a security classification is stated through withholds the assessment.
 * The outcome classifies; the diagnostic registry supplies the effect the record must carry.
 */
function spanLossDiagnostics(usage: SourceSpanUsageV2): Readonly<{ diagnostics: readonly AnalysisDiagnosticV2[] }> | ScanWorkflowV2Failure {
  if (usage.omitted === 0) return { diagnostics: [] };
  const outcome = classifyBudgetOutcome({ budget: 'maxStoredSourceSpans', securityRequired: spanLossIsSecurityRequired(BETA_DEFAULT_PROFILE_MANIFEST) });
  if (outcome.kind !== 'DIAGNOSTIC') return failure('TOOL_INVARIANT_FAILED', 'Stored-span exhaustion has no diagnostic outcome.');
  return { diagnostics: [createDiagnostic(outcome.code, 'source-normalization', true)] };
}
function limitUsage(limits: ScannerLimitsV2, source: ReadonlySourceDocumentV2, sourceWorkUnits: number, workflow: NormalizedSuccess, findings: number, diagnostics: number, spanUsage: SourceSpanUsageV2) {
  const examined: Readonly<Record<(typeof MEASURED_LIMIT_IDS)[number], number>> = {
    maxBytes: source.utf8Bytes,
    maxNodes: workflow.counters.nodesExamined,
    maxEdges: workflow.counters.edgesRetained,
    maxConnectionDepth: workflow.counters.connectionDepth,
    maxParameterDepth: workflow.counters.parameterDepth,
    maxParameterLeaves: workflow.counters.parameterLeaves,
    maxSyntaxNodes: source.syntaxNodeCount,
    maxRawEdges: workflow.counters.rawEdgesExamined,
    maxDuplicateKeys: source.duplicateCount,
    maxDiagnostics: diagnostics,
    maxStoredSourceSpans: spanUsage.examined,
    maxSourceWork: sourceWorkUnits,
    maxFindings: findings,
  };
  // Only budgets with a real counter appear. Emitting a row for a dormant, unwired or unmeasured
  // budget would state a maximum it never enforced and an `examined: 0` it never measured. The
  // stored-span row stays the one budget a successful run can truncate against, so it carries the
  // parser's own omitted/exhausted accounting.
  return [...MEASURED_LIMIT_IDS].sort().map((id) => Object.freeze({
    id,
    maximum: limits[id],
    examined: examined[id],
    omitted: id === 'maxStoredSourceSpans' ? spanUsage.omitted : 0,
    exhausted: id === 'maxStoredSourceSpans' && spanUsage.omitted > 0,
  }));
}
function safeName(name: string | null): string | null { return name !== null && name.length <= 512 && !/[\u0000-\u001f\u007f]|(?:https?|ftp):\/\/|(?:password|secret|token|api[ _-]*key)\s*[:=]|(?:^|[/\\])\.\.(?:[/\\]|$)/i.test(name) ? name : null; }
function finalFindings(candidates: readonly CapabilityCandidateV2[], rules: ReadonlyMap<string, AdmittedRuleV2>, semanticSha256: string): FindingV2[] {
  const output = new Map<string, FindingV2>();
  for (const candidate of candidates) for (const item of candidate.findings) {
    // A rule the admitted catalogue does not carry is refused here, never dropped: the candidate
    // boundary already rejects such a finding, so reaching this point is a scanner invariant
    // failure, and silently omitting it would publish a clean-looking result over hidden evidence.
    const resolution = resolveRuleAuthorityV2(rules, item.ruleId);
    if (!resolution.ok) throw new TypeError('Unadmitted rule at the finding boundary');
    const rule = resolution.rule;
    const body = { ruleId: item.ruleId, ruleRevision: rule.revision, effect: rule.effect, severity: rule.severity, confidence: rule.confidence, evidenceClass: item.evidenceClass, conclusion: item.conclusion, applicability: item.applicability, subject: item.subject, factRefs: [...item.factRefs], traceRefs: [...item.traceRefs], remediationId: rule.remediationId }; const finding = { ...body, findingId: createFindingId(body, { semanticSha256 }) }; output.set(finding.findingId, finding);
  }
  return [...output.values()];
}
function buildScanContext(input: unknown): ({
  request: PreparedRequest; parsed: ReadonlySourceDocumentV2; spanUsage: SourceSpanUsageV2; sourceWorkUnits: number;
  normalized: NormalizedSuccess & { semanticSha256: string }; semanticContext: SemanticContextV2; context: AnalyzerContextV2;
} | ScanWorkflowV2Failure) {
  const request = prepared(input); if ('ok' in request) return request;
  if (!authorityIsIntact() || BETA_DEFAULT_PROFILE_MANIFEST.digest !== PROFILE_MANIFEST_DIGEST_V2) return failure('TOOL_INVARIANT_FAILED', 'Scanner built-in authority is inconsistent.');
  const parsed = parseSourceDocument(request.bytes, request.limits); if (!parsed.ok) return failure(parsed.code, parsed.message, 'cause' in parsed ? parsed.cause : undefined);
  const normalizedResult = normalizeSecurityWorkflow(parsed.document, request.limits); if (!normalizedResult.ok) return failure(normalizedResult.code, normalizedResult.message, 'cause' in normalizedResult ? normalizedResult.cause : undefined);
  const normalized = { ...normalizedResult, semanticSha256: bytesToHex(sha256(canonicalJsonBytes({ workflow: normalizedResult.semanticSha256, target: request.target.contextDigest }))) };
  const semantics = semanticView(normalized.workflow); if ('ok' in semantics) return semantics;
  let semanticContext: SemanticContextV2;
  try {
    semanticContext = resolveAnalyzerSemanticContext({ source: parsed.document, workflow: normalized.workflow, catalogue: BUILTIN_SEMANTIC_CATALOGUE_V2, capabilityId: 'structural-policies', required: true });
  } catch (error) {
    if (error instanceof SemanticCatalogueAdmissionError) return semanticCatalogueFailure(error);
    throw error;
  }
  const context: AnalyzerContextV2 = Object.freeze({ source: parsed.document, workflow: normalized.workflow, target: request.target, limits: request.limits, semantics: semantics.view, rules: createAdmittedRuleView(), priorOutcomes: new Map() });
  return { request, parsed: parsed.document, spanUsage: parsed.sourceSpanUsage, sourceWorkUnits: parsed.sourceWorkUnits, normalized, semanticContext, context };
}
export function scanWorkflowV2(input: unknown): ScanWorkflowV2Result {
  try {
    const built = buildScanContext(input); if ('ok' in built) return built;
    const { request, parsed, spanUsage, sourceWorkUnits, normalized, semanticContext, context } = built;
    const schedule = scanCapabilitiesV2(context, BETA_DEFAULT_PROFILE_MANIFEST, createAdmittedCapabilityRegistry(request.approvedDomains));
    const flowWitnesses = compileWorkflowFlowWitnesses({ workflow: normalized.workflow, semantics: context.semantics, limits: request.limits, semanticSha256: normalized.semanticSha256 });
    const spanLoss = spanLossDiagnostics(spanUsage); if ('ok' in spanLoss) return spanLoss;
    const extra = [...spanLoss.diagnostics, ...ambiguityDiagnostics(normalized.workflow), ...semanticContext.diagnostics, ...flowWitnesses.diagnostics];
    const advisoryFacts = buildAdvisoryFactsV1({ target: request.target, ...(request.advisoryRequest === undefined ? {} : { request: request.advisoryRequest }) });
    const flowCandidate: CapabilityCandidateV2 = { findings: [], diagnostics: [], facts: [...flowWitnesses.facts, ...advisoryFacts], traces: flowWitnesses.traces, seen: 0, analyzed: 0, skipped: 0, omitted: 0 };
    const completed = addDiagnostics({ ...schedule, candidates: [...schedule.candidates, flowCandidate] }, extra, normalized.semanticSha256);
    const native = awaitableInsights(context);
    const findings = finalFindings(completed.candidates, context.rules.rules, normalized.semanticSha256);
    const assessment = scoreFindingsV2(findings, native.complexity);
    const limits = { schemaVersion: request.limits.schemaVersion, digest: bytesToHex(sha256(canonicalJsonBytes(request.limits))), usage: limitUsage(request.limits, parsed, sourceWorkUnits, normalized, findings.length, completed.diagnostics.length, spanUsage) };
    const composed = composeScannerResultV2({ engine: { id: ADMITTED_ENGINE_ID, version: ADMITTED_ENGINE_VERSION, buildDigest: ENGINE_BUILD_DIGEST_V2 }, input: { rawSha256: parsed.rawSha256, semanticSha256: normalized.semanticSha256, ambiguitySha256: normalized.ambiguitySha256, ambiguityCount: normalized.ambiguityCount, utf8Bytes: parsed.utf8Bytes }, profile: { id: ADMITTED_PROFILE_ID, version: ADMITTED_PROFILE_VERSION }, ruleset: { ...BUILTIN_RULESET_AUTHORITY_V2, rules: context.rules.rules }, semantics: BUILTIN_SEMANTICS_AUTHORITY_V2, target: request.target, limits, analysis: { executions: completed.executions, diagnostics: completed.diagnostics, candidates: completed.candidates }, facts: rekeyFacts(semanticContext.facts, normalized.semanticSha256), workflow: native.workflow, assessment, stats: { rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings: completed.candidates.reduce((sum, candidate) => sum + candidate.omitted, 0) } });
    if (!composed.ok) return failure('TOOL_INVARIANT_FAILED', 'Scanner result composition failed.');
    if (composed.result.stats.serializedBytes > request.limits.maxSerializedResultBytes) return failure('WORKFLOW_TOO_COMPLEX', 'Scanner result exceeds the configured serialization limit.', 'SERIALIZED_RESULT_LIMIT');
    return { ok: true, result: composed.result };
  } catch { return failure('TOOL_INVARIANT_FAILED', 'Scanner encountered an internal invariant failure.'); }
}
export type DormantHardenedScanResultV2 = Readonly<{
  ok: true; context: AnalyzerContextV2; candidates: readonly CapabilityCandidateV2[]; byCapability: ReadonlyMap<string, CapabilityCandidateV2>;
}> | ScanWorkflowV2Failure;
export function scanWorkflowDormantHardenedV2(input: unknown): DormantHardenedScanResultV2 {
  try {
    const built = buildScanContext(input); if ('ok' in built) return built;
    const { context, normalized } = built;
    const getTaint = createScanLocalTaint(context, produceScanLocalTaintV1); const getFieldFlow = createFieldFlowAccessorV1({ workflow: context.workflow, semantics: context.semantics, limits: context.limits, semanticSha256: normalized.semanticSha256 });
    const registry = createBetaHardenedCapabilityRegistry({ getTaint, getFieldFlow });
    const ids = ['graph-semantics', 'taint-confidentiality', 'taint-integrity', 'agentic-control'] as const;
    const candidates: CapabilityCandidateV2[] = [];
    const byCapability = new Map<string, CapabilityCandidateV2>();
    for (const id of ids) {
      const spec = registry.get(id);
      if (!spec) continue;
      const candidate = spec.run(context);
      candidates.push(candidate);
      byCapability.set(id, candidate);
    }
    return Object.freeze({ ok: true, context, candidates: Object.freeze(candidates), byCapability });
  } catch { return failure('TOOL_INVARIANT_FAILED', 'Dormant hardened scan encountered an internal invariant failure.'); }
}
function awaitableInsights(context: AnalyzerContextV2): { workflow: ScannerResultV2['workflow']; complexity: ScannerResultV2['workflow']['complexity'] } {
  const native = toNativeWorkflow(context); const insights = analyzeWorkflowInsights(native);
  const { connectionCount: _connectionCount, ...overview } = insights.workflow;
  return { workflow: { ...overview, name: safeName(insights.workflow.name), edgeCount: context.workflow.edges.length, resolvedEdgeCount: context.workflow.edges.filter((edge) => edge.resolution === 'RESOLVED').length }, complexity: insights.workflow.complexity };
}
