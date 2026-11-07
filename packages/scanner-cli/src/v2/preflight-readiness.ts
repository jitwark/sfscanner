/**
 * Preflight readiness (PD-01, PD-02): keeps matched finding severity separate from analysis
 * completeness and target-specific compatibility, and inventories the prerequisites a workflow
 * export declares. It never infers credential ownership/validity, package installation, endpoint
 * configuration or live behavior; a no-match result is never safety or migration clearance.
 * Pure, deterministic and free of host APIs so the browser worker and CLI share one contract.
 */
import { cmp, collectPreflightInventory, hasKnownIdentity, isDict, text } from '@hub/contracts/preflight-prerequisites';
import type {
  PreflightCommunityNodeV1, PreflightCredentialV1, PreflightEnvironmentV1, PreflightIntegrationV1,
  PreflightNodeEvidenceV1, PreflightPrerequisitesV1, PreflightProvenanceV1, PreflightSubworkflowV1,
  RawNodeV1,
} from '@hub/contracts/preflight-prerequisite-types';
import { pinnedTargetFactV1 } from './preflight-target-facts';

export type {
  PreflightCommunityNodeV1, PreflightCredentialV1, PreflightEnvironmentV1, PreflightIntegrationV1,
  PreflightNodeEvidenceV1, PreflightPrerequisitesV1, PreflightProvenanceV1, PreflightSubworkflowV1,
} from '@hub/contracts/preflight-prerequisite-types';

export const PREFLIGHT_READINESS_SCHEMA_V1 = 'n8n-preflight-readiness-v1' as const;
export const PREFLIGHT_SEVERITIES_V1 = Object.freeze(['critical', 'high', 'medium', 'low', 'info'] as const);
export type PreflightSeverityV1 = (typeof PREFLIGHT_SEVERITIES_V1)[number];
export type PreflightCompletenessV1 = 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE';
export type N8nTargetV1 = '1.x' | '2.x';
export type PreflightCompletenessCodeV1 = 'ANALYSIS_NOT_REPORTED' | 'MALFORMED_NODE_ENTRY' | 'UNKNOWN_NODE_TYPE' | 'UNSUPPORTED_NODE'
  | 'UNRESOLVED_EDGE' | 'AMBIGUITY' | 'TRUNCATED_ANALYSIS' | 'DYNAMIC_PREREQUISITE_VALUE' | 'PREREQUISITE_INVENTORY_LIMIT'
  | 'DYNAMIC_ENVIRONMENT_ACCESS' | 'ENVIRONMENT_EVIDENCE_OMITTED';
export type PreflightTargetCodeV1 = 'FEATURE_NOT_SUPPORTED_BY_TARGET' | 'TYPE_VERSION_NOT_SUPPORTED_BY_TARGET' | 'TYPE_VERSION_UNKNOWN'
  | 'DEFAULT_NODE_EXCLUSION_CONFIGURATION_UNKNOWN';

export const PREFLIGHT_DISCLAIMER_V1 = Object.freeze({
  id: 'NOT_SAFETY_CLEARANCE' as const,
  text: 'A clean or low-severity scan is not safety clearance: it does not prove the workflow is bug-free, secure, fully analyzed or runnable, and it does not replace an import, execution, deployment or credential check on the declared target.',
});

export type PreflightFindingInputV1 = Readonly<{ ruleId: string; severity: string; node?: string | null; message?: string | null }>;
export type PreflightFindingV1 = Readonly<{ ruleId: string; severity: PreflightSeverityV1; node: string | null; message: string | null }>;
export type PreflightAnalysisSignalsV1 = Readonly<{ supportedNodes?: number; unsupportedNodes?: number; unresolvedEdges?: number; ambiguities?: number; truncated?: boolean }>;
export type PreflightCompletenessReasonV1 = Readonly<{ code: PreflightCompletenessCodeV1; count: number; detail: string }>;
export type PlatformCompatibilityFactV1 = Readonly<{
  featureId: string; description: string; nodeTypes: readonly string[]; supportedTargets: readonly N8nTargetV1[];
  maxTypeVersionByTarget?: Readonly<Partial<Record<N8nTargetV1, string>>>; source: string;
}>;
export type PreflightTargetSourceEvidenceV1 = Readonly<{
  kind: 'PINNED_SOURCE'; tag: string; commit: string; path: string; startLine: number; endLine: number; sha256: string;
}>;
export type PreflightTargetFindingV1 = Readonly<{ code: PreflightTargetCodeV1; featureId: string; subject: string; nodeType: string | null; typeVersion: string | null; source: string; detail: string; pointer?: string; sourceEvidence?: PreflightTargetSourceEvidenceV1 }>;
export type PreflightReadinessOptionsV1 = Readonly<{
  workflow: unknown; n8nTarget?: N8nTargetV1 | 'UNKNOWN' | null; platformFacts?: readonly PlatformCompatibilityFactV1[];
  requiredPlatformFeatures?: readonly string[]; analysis?: PreflightAnalysisSignalsV1; findings?: readonly PreflightFindingInputV1[];
  n8nVersion?: string | null;
}>;
export type PreflightReadinessReportV1 = Readonly<{
  schemaVersion: typeof PREFLIGHT_READINESS_SCHEMA_V1; safetyClearance: 'NOT_PROVIDED'; disclaimer: typeof PREFLIGHT_DISCLAIMER_V1;
  completeness: Readonly<{ status: PreflightCompletenessV1; reasons: readonly PreflightCompletenessReasonV1[] }>;
  findings: Readonly<{ total: number; bySeverity: Readonly<Record<PreflightSeverityV1, number>>; highestSeverity: PreflightSeverityV1 | null; items: readonly PreflightFindingV1[] }>;
  prerequisites: PreflightPrerequisitesV1;
  target: Readonly<{ declared: N8nTargetV1 | null; declaredVersion?: string | null; status: 'INDETERMINATE' | 'NO_RECOGNIZED_CHANGE' | 'INCOMPATIBLE' | 'UNKNOWN'; migrationTested: false; findings: readonly PreflightTargetFindingV1[]; notes: readonly string[] }>;
}>;

/** No pinned platform fact is admitted yet, so every compatibility fact must arrive with its own source (B3). */
export const DEFAULT_PLATFORM_FACTS_V1: readonly PlatformCompatibilityFactV1[] = Object.freeze([]);

const SEVERITY_RANK: Readonly<Record<PreflightSeverityV1, number>> = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3, info: 4 });
const COMPLETENESS_ORDER: readonly PreflightCompletenessCodeV1[] = Object.freeze(['MALFORMED_NODE_ENTRY', 'UNKNOWN_NODE_TYPE', 'UNSUPPORTED_NODE', 'UNRESOLVED_EDGE', 'AMBIGUITY', 'TRUNCATED_ANALYSIS', 'DYNAMIC_PREREQUISITE_VALUE', 'PREREQUISITE_INVENTORY_LIMIT', 'DYNAMIC_ENVIRONMENT_ACCESS', 'ENVIRONMENT_EVIDENCE_OMITTED', 'ANALYSIS_NOT_REPORTED']);
const ro = <T>(value: T): Readonly<T> => Object.freeze(value);
const isCounter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
type AnalysisEvidenceV1 = Readonly<{ reported: boolean; supportedNodes: number; unsupportedNodes: number; unresolvedEdges: number; ambiguities: number; truncated: boolean }>;

/** Absent, partial or malformed signals prove nothing, so they are never admitted as affirmative analysis evidence. */
function readAnalysis(analysis: unknown, nodeCount: number): AnalysisEvidenceV1 {
  const { supportedNodes, unsupportedNodes, unresolvedEdges, ambiguities, truncated } = isDict(analysis) ? analysis : {};
  if (!isCounter(supportedNodes) || supportedNodes > nodeCount || !isCounter(unsupportedNodes) || !isCounter(unresolvedEdges)
    || !isCounter(ambiguities) || typeof truncated !== 'boolean') return ro({ reported: false, supportedNodes: 0, unsupportedNodes: 0, unresolvedEdges: 0, ambiguities: 0, truncated: false });
  return ro({ reported: true, supportedNodes, unsupportedNodes, unresolvedEdges, ambiguities, truncated });
}

function compareTypeVersions(left: string, right: string): number | null {
  if (!/^[0-9]+(\.[0-9]+){0,2}$/.test(left) || !/^[0-9]+(\.[0-9]+){0,2}$/.test(right)) return null;
  const parts = (value: string): number[] => [...value.split('.').map(Number), 0, 0].slice(0, 3); const a = parts(left); const b = parts(right);
  return (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);
}

function completenessReasons(options: PreflightReadinessOptionsV1, inventory: Readonly<{
  malformed: number; nodes: readonly RawNodeV1[]; subworkflows: readonly PreflightSubworkflowV1[]; inventoryTruncated: boolean;
  environmentIncomplete: Readonly<{ computed: boolean; omitted: boolean }>;
}>): readonly PreflightCompletenessReasonV1[] {
  const { malformed, nodes, subworkflows, inventoryTruncated, environmentIncomplete } = inventory;
  const signals = readAnalysis(options.analysis, nodes.length);
  const counts: Record<PreflightCompletenessCodeV1, number> = {
    ANALYSIS_NOT_REPORTED: signals.reported ? 0 : 1, MALFORMED_NODE_ENTRY: malformed,
    UNKNOWN_NODE_TYPE: nodes.filter((node) => !hasKnownIdentity(node)).length, UNSUPPORTED_NODE: signals.reported ? Math.max(signals.unsupportedNodes, nodes.length - signals.supportedNodes) : 0,
    UNRESOLVED_EDGE: signals.unresolvedEdges, AMBIGUITY: signals.ambiguities, TRUNCATED_ANALYSIS: signals.truncated ? 1 : 0,
    DYNAMIC_PREREQUISITE_VALUE: subworkflows.filter((row) => row.resolution === 'DYNAMIC').length, PREREQUISITE_INVENTORY_LIMIT: inventoryTruncated ? 1 : 0,
    DYNAMIC_ENVIRONMENT_ACCESS: environmentIncomplete.computed ? 1 : 0, ENVIRONMENT_EVIDENCE_OMITTED: environmentIncomplete.omitted ? 1 : 0,
  };
  const details: Record<PreflightCompletenessCodeV1, string> = {
    ANALYSIS_NOT_REPORTED: 'Analysis signals are absent, partial or malformed, so the retained evidence cannot prove the workflow was fully analyzed.', MALFORMED_NODE_ENTRY: 'Node entries without a type were skipped and stay unanalyzed.',
    UNKNOWN_NODE_TYPE: 'Node types with no admitted local-utility or remote-access model, and no credential reference declared on an official type, have no built-in semantic model.', UNSUPPORTED_NODE: 'Nodes whose semantics the analyzer reported as unsupported were not modeled.',
    UNRESOLVED_EDGE: 'Connection edges that could not be resolved leave the reachable graph partial.', AMBIGUITY: 'Duplicate or ambiguous members were reported by normalization and stay unresolved.',
    TRUNCATED_ANALYSIS: 'Analysis stopped at a bound, so the retained evidence covers only part of the workflow.', DYNAMIC_PREREQUISITE_VALUE: 'A subworkflow id is dynamic and cannot be resolved offline.',
    PREREQUISITE_INVENTORY_LIMIT: 'Parameter traversal stopped at an internal inventory limit, so the environment reference inventory may be incomplete.',
    DYNAMIC_ENVIRONMENT_ACCESS: 'Computed environment or variable access cannot be named offline.',
    ENVIRONMENT_EVIDENCE_OMITTED: 'Environment evidence was omitted because its parameter path may contain sensitive dynamic keys.',
  };
  return ro(COMPLETENESS_ORDER.filter((code) => counts[code] > 0).map((code) => ro({ code, count: counts[code], detail: details[code] })));
}

function normalizeFindings(input: readonly PreflightFindingInputV1[] | undefined): readonly PreflightFindingV1[] {
  if (input === undefined) return ro([]); if (!Array.isArray(input)) throw new TypeError('findings must be an array');
  const rows = input.map((item, index) => {
    const ruleId = isDict(item) ? text(item.ruleId) : null;
    if (ruleId === null) throw new TypeError(`findings[${index}] needs a ruleId`);
    const severity = isDict(item) && typeof item.severity === 'string' ? item.severity.trim().toLowerCase() : '';
    if (!(PREFLIGHT_SEVERITIES_V1 as readonly string[]).includes(severity)) throw new TypeError(`findings[${index}] has unsupported severity ${JSON.stringify(isDict(item) ? item.severity : undefined)}`);
    return ro({ ruleId, severity: severity as PreflightSeverityV1, node: isDict(item) ? text(item.node) : null, message: isDict(item) ? text(item.message) : null });
  });
  return ro(rows.sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || cmp(left.ruleId, right.ruleId) || cmp(left.node ?? '', right.node ?? '')));
}

/** A fact is admitted only when every field it carries is well formed; a discarded constraint must not become a clean verdict. */
const isPlatformFact = (fact: unknown): fact is PlatformCompatibilityFactV1 => isDict(fact) && text(fact.featureId) !== null && text(fact.source) !== null
  && Array.isArray(fact.nodeTypes) && fact.nodeTypes.every((type) => text(type) !== null) && Array.isArray(fact.supportedTargets) && fact.supportedTargets.every((target) => target === '1.x' || target === '2.x')
  && (fact.maxTypeVersionByTarget === undefined || (isDict(fact.maxTypeVersionByTarget) && Object.entries(fact.maxTypeVersionByTarget).every(([target, version]) => (target === '1.x' || target === '2.x') && text(version) !== null)));

const targetCaveat = 'This is not a migration test and does not prove the workflow imports or executes.';
const observedTypeVersion = (value: string | null): string | null => value !== null && /^[0-9]+(\.[0-9]+){0,2}$/.test(value) ? value : null;
const versionFamily = (version: string): N8nTargetV1 | null => version === '2.x' || version.startsWith('2.') ? '2.x' : version === '1.x' || version.startsWith('1.') ? '1.x' : null;

function evaluateExactTarget(version: string, nodes: readonly RawNodeV1[]): PreflightReadinessReportV1['target'] {
  const fact = pinnedTargetFactV1(version);
  const declared = versionFamily(version);
  if (fact === undefined) return ro({ declared, declaredVersion: version, status: 'INDETERMINATE' as const, migrationTested: false as const, findings: ro([]), notes: ro([`No applicable fact exists in this exact pinned subset for ${version}; target status remains indeterminate, with no further conclusion from this packet and no migration-success claim.`]) });
  const matched = nodes.filter((node) => node.type === fact.nodeType).sort((left, right) => left.index - right.index || cmp(left.name, right.name));
  if (matched.length === 0) return ro({ declared, declaredVersion: version, status: 'NO_RECOGNIZED_CHANGE' as const, migrationTested: false as const, findings: ro([]), notes: ro([`No executeCommand match exists in the frozen exact pinned subset for ${fact.evidence.tag}. This is not migration success and does not prove the workflow imports or executes.`]) });
  const findings = matched.map((node) => ro({
    code: 'DEFAULT_NODE_EXCLUSION_CONFIGURATION_UNKNOWN' as const, featureId: 'execute-command-default-exclusion', subject: node.name,
    nodeType: fact.nodeType, typeVersion: observedTypeVersion(node.typeVersion), source: fact.source,
    detail: `The pinned upstream default for ${fact.evidence.tag} contains ${fact.nodeType} in its default NODES_EXCLUDE list. An operator may override NODES_EXCLUDE, but the actual host list and configuration are unknown and must be reviewed.`,
    pointer: `/nodes/${node.index}/type`, sourceEvidence: fact.evidence,
  }));
  return ro({ declared, declaredVersion: version, status: 'INDETERMINATE' as const, migrationTested: false as const, findings: ro(findings), notes: ro([`The frozen exact pinned subset records the upstream default exclusion; the actual host NODES_EXCLUDE list and configuration are unknown and must be reviewed. ${targetCaveat}`]) });
}

function evaluateTarget(options: PreflightReadinessOptionsV1, nodes: readonly RawNodeV1[]): PreflightReadinessReportV1['target'] {
  if (typeof options.n8nVersion === 'string') return evaluateExactTarget(options.n8nVersion, nodes);
  if (options.requiredPlatformFeatures !== undefined && !Array.isArray(options.requiredPlatformFeatures)) throw new TypeError('requiredPlatformFeatures must be an array');
  const facts = options.platformFacts ?? DEFAULT_PLATFORM_FACTS_V1;
  for (const fact of facts) if (!isPlatformFact(fact)) throw new TypeError('malformed platform compatibility fact');
  const declared = options.n8nTarget === '1.x' || options.n8nTarget === '2.x' ? options.n8nTarget : null;
  const caveat = 'this is not a migration test and does not prove the workflow imports or executes';
  if (declared === null) return ro({ declared: null, status: 'INDETERMINATE' as const, migrationTested: false as const, findings: ro([]), notes: ro([`No n8n target was declared, so platform compatibility is unknown; ${caveat} anywhere.`]) });
  const required = options.requiredPlatformFeatures ?? []; const findings: PreflightTargetFindingV1[] = []; const admitted = new Set(facts.map((fact) => fact.featureId));
  for (const fact of facts) {
    const matched = nodes.filter((node) => fact.nodeTypes.includes(node.type));
    if (matched.length === 0 && !required.includes(fact.featureId)) continue;
    const subject = matched.map((node) => node.name).join(', ') || `feature:${fact.featureId}`;
    if (!fact.supportedTargets.includes(declared)) findings.push(ro({ code: 'FEATURE_NOT_SUPPORTED_BY_TARGET' as const, featureId: fact.featureId, subject, nodeType: matched[0]?.type ?? null, typeVersion: null, source: fact.source, detail: `${text(fact.description) ?? fact.featureId} is not admitted as supported on n8n ${declared}.` }));
    const maximum = fact.maxTypeVersionByTarget?.[declared]; if (typeof maximum !== 'string') continue;
    for (const node of matched) {
      const verdict = node.typeVersion === null ? null : compareTypeVersions(node.typeVersion, maximum); if (verdict !== null && verdict <= 0) continue;
      findings.push(ro({ code: verdict === null ? 'TYPE_VERSION_UNKNOWN' as const : 'TYPE_VERSION_NOT_SUPPORTED_BY_TARGET' as const, featureId: fact.featureId, subject: node.name, nodeType: node.type, typeVersion: node.typeVersion, source: fact.source, detail: verdict === null ? `The ${node.name} typeVersion is absent or unreadable, so target support is unknown.` : `typeVersion ${node.typeVersion} exceeds the maximum admitted for n8n ${declared} (${maximum}).` }));
    }
  }
  for (const featureId of new Set(required)) if (!admitted.has(featureId)) findings.push(ro({ code: 'FEATURE_NOT_SUPPORTED_BY_TARGET' as const, featureId, subject: `feature:${featureId}`, nodeType: null, typeVersion: null, source: 'caller:requiredPlatformFeatures', detail: `Required platform feature ${featureId} has no admitted fact.` }));
  const status = findings.some((finding) => finding.code !== 'TYPE_VERSION_UNKNOWN') ? 'INCOMPATIBLE' as const : findings.length > 0 ? 'UNKNOWN' as const : 'NO_RECOGNIZED_CHANGE' as const;
  const conclusion = status === 'INCOMPATIBLE' ? 'Admitted pinned facts conflict with the declared target.'
    : status === 'UNKNOWN' ? 'An admitted fact applies but a needed workflow value is missing, so compatibility stays unknown.'
      : 'Result: no recognized change found for the declared target.';
  return ro({ declared, status, migrationTested: false as const, findings: ro(findings.sort((left, right) => cmp(left.featureId, right.featureId) || cmp(left.code, right.code) || cmp(left.subject, right.subject))), notes: ro([`${conclusion} Target ${declared}; ${caveat} on it.`, 'Absence of a recognized conflict is not migration success.']) });
}

/** Builds the offline readiness report; the input workflow is never mutated and nothing is executed. */
export function buildPreflightReadinessReport(options: PreflightReadinessOptionsV1): PreflightReadinessReportV1 {
  if (!isDict(options)) throw new TypeError('options must be an object');
  const { nodes, malformed, prerequisites, inventoryTruncated, environmentIncomplete } = collectPreflightInventory(options.workflow);
  const reasons = completenessReasons(options, { malformed, nodes, subworkflows: prerequisites.subworkflows, inventoryTruncated, environmentIncomplete });
  const status: PreflightCompletenessV1 = reasons.length === 0 ? 'COMPLETE' : reasons.some((reason) => reason.code === 'ANALYSIS_NOT_REPORTED') ? 'INDETERMINATE' : 'DEGRADED';
  const items = normalizeFindings(options.findings);
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const item of items) bySeverity[item.severity] += 1;
  return ro({
    schemaVersion: PREFLIGHT_READINESS_SCHEMA_V1, safetyClearance: 'NOT_PROVIDED' as const, disclaimer: PREFLIGHT_DISCLAIMER_V1,
    completeness: ro({ status, reasons }),
    findings: ro({ total: items.length, bySeverity: ro(bySeverity), highestSeverity: items[0]?.severity ?? null, items }),
    prerequisites,
    target: evaluateTarget(options, nodes),
  });
}
