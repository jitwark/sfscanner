import type { ScannerLimitsV2 } from '@hub/contracts';
import { createDiagnosticId, sortDiagnostics } from '../diagnostics/identity';
import { classifyDiagnostic, type AnalysisDiagnosticV2, type DiagnosticCodeV2 } from '../diagnostics/registry';
import { isScannerAdmissionSnapshotV2 } from '../admission/snapshot';
import { SAFE_FACT_REGISTRY_V2 } from '../facts/safe-fact-registry';
import { isParsedSourceDocument } from '../source/source-document-provenance';
import type { EdgeRefV2, NodeRefV2, SecurityWorkflowV2 } from '../workflow-v2/security-workflow';
import type { ReadonlySourceDocumentV2, SourceMemberRefV2 } from '../source/source-types';
import { validateCapabilityCandidate } from './candidate-validator';
import { corroboratedCapabilityStatus, type CapabilityOutcomeStatusV2 } from './count-lattice';
import { resolveDeclaredRulesV2 } from '../rules-v2/rule-authority';
import { PROFILE_MANIFEST_REGISTRY_V2, validateProfileManifest, type ProfileCapabilityV2, type ProfileManifestV2 } from './profile-manifest';
import { ContextSnapshotLimitV2, contextView, ownNames, snapshotBound, type SnapshotBoundV2 } from './context-view';
type VersionComparatorV2 = Readonly<{ op: 'EQ' | 'LT' | 'LTE' | 'GT' | 'GTE'; version: string }>;
type VersionRangeV2 = Readonly<{ clauses: readonly (readonly VersionComparatorV2[])[] }>;
type SemanticPathV2 = Readonly<{ pointer: string; valueType: 'ANY' | 'STRING' | 'BOOLEAN' | 'NUMBER' | 'OBJECT' | 'ARRAY'; required: boolean }>;
type SemanticEndpointV2 = Readonly<{ path: string; channel: 'DATA' | 'CONTROL' | 'ERROR' | 'MODEL' | 'TOOL' | 'CONTEXT'; direction: 'SOURCE' | 'SINK' | 'SANITIZER'; taint: 'CONFIDENTIALITY' | 'INTEGRITY' | 'BOTH'; scope?: string }>;
type ResolvedNodeSemanticsV2 = Readonly<{ semanticId: string; nodeType: string; versionRange: VersionRangeV2; operation: string | null; entry: 'TRIGGER' | 'MANUAL' | 'SUBWORKFLOW' | 'NONE'; parameterPaths: readonly SemanticPathV2[]; authentication: Readonly<{ path: string; noneValues: readonly string[]; authenticatedValues: readonly string[]; unknownValueEffect: 'UNKNOWN' | 'EXPOSED' }> | null; credentialPaths: readonly string[]; destinationPaths: readonly string[]; effects: readonly ('READ_EXTERNAL' | 'WRITE_EXTERNAL' | 'EXECUTE_CODE' | 'EXECUTE_COMMAND' | 'READ_FILE' | 'WRITE_FILE' | 'DATABASE_READ' | 'DATABASE_WRITE' | 'SEND_MESSAGE' | 'CALL_TOOL' | 'START_SUBWORKFLOW')[]; endpoints: readonly SemanticEndpointV2[]; ports: readonly Readonly<{ type: string; index: number; itemMode: 'EACH' | 'ALL' | 'PAIRWISE' | 'UNKNOWN' }>[]; overwritePaths: readonly string[]; errorMode: 'STOP' | 'CONTINUE' | 'OUTPUT' | 'UNKNOWN'; retryMode: 'NONE' | 'BOUNDED' | 'PLATFORM' | 'UNKNOWN'; disabledMode: 'SKIP' | 'UNKNOWN'; provenance: Readonly<{ sourceUrl: string; sourceDigest: string; reviewedAt: string; reviewer: string }> }>;
export type AdmittedRuleV2 = Readonly<{ ruleId: string; revision: string; capabilityId: string; effect: 'SCORING' | 'REPORT_ONLY'; severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; evidenceSchemaId: string; remediationId: string; cweIds: readonly string[]; owaspAgenticIds: readonly string[]; packDigest: string }>;
export type SemanticCatalogueViewV2 = Readonly<{ id: string; version: string; digest: string; resolvedNodeSemantics: ReadonlyMap<string, ResolvedNodeSemanticsV2> }>;
export type RuleCatalogueViewV2 = Readonly<{ id: string; version: string; digest: string; rules: ReadonlyMap<string, AdmittedRuleV2> }>;
export type SubjectV2 = Readonly<{ kind: 'WORKFLOW' } | { kind: 'NODE'; node: NodeRefV2 } | { kind: 'EDGE'; edge: EdgeRefV2 } | { kind: 'SOURCE'; source: SourceMemberRefV2 }>;
export type FindingCandidateV2 = Readonly<{ ruleId: string; evidenceClass: 'CAPABILITY' | 'CONFIGURATION' | 'SUSPICIOUS_SYNTAX' | 'POTENTIAL_DATAFLOW' | 'VERSION_APPLICABILITY'; conclusion: 'OBSERVED' | 'POTENTIAL' | 'UNKNOWN'; applicability: 'APPLICABLE' | 'NOT_APPLICABLE' | 'UNKNOWN'; subject: SubjectV2; factRefs: readonly string[]; traceRefs: readonly string[]; remediationId: string }>;
type SafeFactScalarV2 = string | number | boolean | null;
type SafeFactValueV2 = SafeFactScalarV2 | readonly SafeFactScalarV2[];
export type SafeFactV2 = Readonly<{ factId: string; kind: string; subject: SubjectV2; properties: Readonly<Record<string, SafeFactValueV2>> }>;
type TraceStepV2 = Readonly<{ ordinal: number; kind: 'SOURCE' | 'PROPAGATION' | 'SANITIZER' | 'SINK'; subject: SubjectV2; factRefs: readonly string[] }>;
export type TraceV2 = Readonly<{ traceId: string; kind: 'CONFIDENTIALITY' | 'INTEGRITY' | 'CONTROL'; steps: readonly TraceStepV2[] }>;
export type CapabilityCandidateV2 = Readonly<{ findings: readonly FindingCandidateV2[]; diagnostics: readonly AnalysisDiagnosticV2[]; facts: readonly SafeFactV2[]; traces: readonly TraceV2[]; seen: number; analyzed: number; skipped: number; omitted: number }>;
export type CapabilityExecutionV2 = Readonly<{ id: string; version: string; required: boolean; status: CapabilityOutcomeStatusV2; seen: number; analyzed: number; skipped: number; omitted: number; diagnosticIds: readonly string[] }>;
export type TargetContextV3 = Readonly<{ schemaVersion: 'scanner-target-v3'; n8nVersion?: string; edition: 'COMMUNITY' | 'ENTERPRISE' | 'CLOUD' | 'UNKNOWN'; deployment: 'SELF_HOSTED' | 'CLOUD' | 'UNKNOWN'; role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'UNKNOWN'; taskRunner: 'LEGACY' | 'NATIVE' | 'UNKNOWN'; communityPackages: readonly Readonly<{ name: string; version?: string }>[]; configuration: readonly Readonly<{ key: string; state: 'ENABLED' | 'DISABLED' | 'UNKNOWN' }>[]; contextDigest: string }>;
export type AnalyzerContextV2 = Readonly<{ source: ReadonlySourceDocumentV2; workflow: SecurityWorkflowV2; target: TargetContextV3; limits: ScannerLimitsV2; semantics: SemanticCatalogueViewV2; rules: RuleCatalogueViewV2; priorOutcomes: ReadonlyMap<string, CapabilityExecutionV2> }>;
export type CapabilitySpecV2 = Readonly<ProfileCapabilityV2 & { run(context: AnalyzerContextV2): CapabilityCandidateV2 }>;
export type CapabilityRegistryV2 = ReadonlyMap<string, CapabilitySpecV2>;
export type CapabilityScheduleV2 = Readonly<{ executions: readonly CapabilityExecutionV2[]; candidates: readonly CapabilityCandidateV2[]; diagnostics: readonly AnalysisDiagnosticV2[] }>;
const SPEC_KEYS = ['id', 'version', 'required', 'dependsOn', 'ruleIds', 'run'] as const;
type CounterValues = Readonly<{ seen: number; analyzed: number; skipped: number; omitted: number }>;
type MutableExecution = { id: string; version: string; required: boolean; status: CapabilityExecutionV2['status']; seen: number; analyzed: number; skipped: number; omitted: number; diagnosticIds: string[] };
type EligibilityUnitScopeV2 = 'SOURCE_DOCUMENT' | 'WORKFLOW' | 'NODE';
// Keep this parser-owned work contract aligned with the admitted capability registry. Source
// normalization has one parsed-document unit, node-scoped analyzers inspect the normalized node
// list, and other workflow-level stages have one unit even when the workflow contains no nodes.
const CAPABILITY_ELIGIBILITY_SCOPE_V2: Readonly<Record<string, EligibilityUnitScopeV2>> = Object.freeze({
  'source-normalization': 'SOURCE_DOCUMENT', 'workflow-insights': 'WORKFLOW', 'structural-policies': 'NODE',
  'expression-security': 'NODE', 'javascript-security': 'NODE', 'python-security': 'NODE',
  'graph-semantics': 'NODE', 'taint-confidentiality': 'NODE', 'taint-integrity': 'NODE',
  'agentic-control': 'NODE', assessment: 'WORKFLOW', 'presentation-facts': 'WORKFLOW',
});

export function scheduleCapabilities(context: AnalyzerContextV2, manifest: ProfileManifestV2, registry: CapabilityRegistryV2): CapabilityScheduleV2 {
  const executions: MutableExecution[] = []; const candidates: CapabilityCandidateV2[] = []; const rawDiagnostics: AnalysisDiagnosticV2[] = []; const byId = new Map<string, MutableExecution>();
  const admission = validateProfileManifest(manifest, registry); if (!admission.ok) return closedSchedule(manifest); manifest = admission.manifest;
  const selectedSpecs = snapshotSpecs(manifest, registry);
  // One frozen view serves every capability: the view is deeply frozen and immutable, so a second
  // copy would only repeat the walk. On the D-1 fixtures the copy measured 20.6–27.5% of the
  // pipeline across seven shapes (D1-FIX-REVIEW.md), and the beta-default profile runs five
  // capabilities (twelve under beta-hardened) over the same context, so without the cache every
  // capability would pay that share again. It is still built inside the capability loop, so a
  // context the walk refuses fails that capability closed instead of escaping the scheduler.
  let cachedView: AnalyzerContextV2 | undefined;
  for (const capability of manifest.capabilities) {
    const unavailable = capability.dependsOn.find((dependency) => byId.get(dependency)?.status !== 'COMPLETED');
    if (unavailable !== undefined) {
      const execution = failedExecution(capability, 'SKIPPED', { seen: 0, analyzed: 0, skipped: 1, omitted: 0 }, 1);
      executions.push(execution); byId.set(capability.id, execution); rawDiagnostics.push(schedulerDiagnostic('DEPENDENCY_UNAVAILABLE', capability)); continue;
    }
    try {
      const declared = resolveDeclaredRulesV2(capability.ruleIds, context.rules.rules, capability);
      if (!declared.ok) {
        // A declared rule id the catalogue does not admit is refused, never silently filtered out
        // of the registry this capability would run with. The consequence follows the case the
        // authority resolved: a scoring unknown fails the run closed (FAILED, and the registry row
        // is INDETERMINATE/ineligible so no assessment can be published), while a report-only
        // unknown degrades its owner and lets everything else still score.
        const refused = failedExecution(capability, declared.case === 'SCORING' ? 'FAILED' : 'DEGRADED', { seen: 0, analyzed: 0, skipped: 0, omitted: 0 }, 1);
        executions.push(refused); byId.set(capability.id, refused);
        rawDiagnostics.push(schedulerDiagnostic(declared.diagnosticCode, capability));
        continue;
      }
      const spec = selectedSpecs.get(capability.id); if (!spec) throw new TypeError();
      const runnerContext = cachedView ?? contextView(context);
      cachedView = runnerContext;
      const eligibleUnits = capabilityEligibleUnits(capability.id, runnerContext);
      const output: unknown = spec.run(runnerContext);
      if (!isScannerAdmissionSnapshotV2<CapabilityCandidateV2>(output)) throw new TypeError();
      const validation = validateCapabilityCandidate(output, spec, { facts: SAFE_FACT_REGISTRY_V2, rules: declared.rules }, context.limits, eligibleUnits);
      if (!validation.ok) {
        const status = capability.required ? 'FAILED' : 'DEGRADED';
        const execution = failedExecution(capability, status, validation.counters, 1);
        executions.push(execution); byId.set(capability.id, execution);
        const bound = validation.limit === undefined ? undefined : snapshotBound(validation.limit.observed, validation.limit.maximum);
        rawDiagnostics.push(capabilityFailureDiagnostic(capability, bound === undefined ? { limit: validation.reason === 'LIMIT_EXCEEDED' } : { limit: true, bound }));
        continue;
      }
      candidates.push(validation.candidate); const execution = completedExecution(capability, validation.candidate);
      for (const diagnostic of validation.candidate.diagnostics) {
        if (diagnostic.capabilityId === capability.id && !rawDiagnostics.some(({ id }) => id === diagnostic.id)) rawDiagnostics.push(diagnostic);
      }
      executions.push(execution); byId.set(capability.id, execution);
    } catch (error) {
      const status = capability.required ? 'FAILED' : 'DEGRADED';
      const execution = failedExecution(capability, status, { seen: 0, analyzed: 0, skipped: 0, omitted: 0 }, 1);
      executions.push(execution); byId.set(capability.id, execution);
      const bound = error instanceof ContextSnapshotLimitV2 ? snapshotBound(error.observed, error.maximum) : undefined;
      rawDiagnostics.push(capabilityFailureDiagnostic(capability, bound === undefined ? { limit: false } : { limit: true, bound }));
    }
  }
  return finalizeSchedule(executions, candidates, rawDiagnostics, manifest.capabilities.map(({ id }) => id));
}

function closedSchedule(manifest: ProfileManifestV2): CapabilityScheduleV2 { const capabilities = safeFailureCapabilities(manifest); const executions = capabilities.map((capability) => failedExecution(capability, capability.required ? 'FAILED' : 'DEGRADED', { seen: 0, analyzed: 0, skipped: 0, omitted: 0 }, 1)); return finalizeSchedule(executions, [], capabilities.map((capability) => schedulerDiagnostic(capability.required ? 'REQUIRED_CAPABILITY_FAILED' : 'POLICY_EXECUTION_FAILED', capability)), capabilities.map(({ id }) => id)); }
function capabilityEligibleUnits(capabilityId: string, context: AnalyzerContextV2): number {
  const scope = CAPABILITY_ELIGIBILITY_SCOPE_V2[capabilityId];
  if (scope === undefined || !isParsedSourceDocument(context.source) || !Array.isArray(context.workflow?.nodes)) throw new TypeError();
  return scope === 'NODE' ? context.workflow.nodes.length : 1;
}
function safeFailureCapabilities(input: unknown): readonly ProfileCapabilityV2[] { try { if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(); const id = safeManifestString(input, 'id'); const version = safeManifestString(input, 'version'); if (id === undefined || version === undefined) return []; return PROFILE_MANIFEST_REGISTRY_V2.find((profile) => profile.id === id && profile.version === version)?.capabilities ?? []; } catch { return []; } }
function safeManifestString(input: object, key: 'id' | 'version'): string | undefined { const descriptor = Object.getOwnPropertyDescriptor(input, key); return descriptor && 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : undefined; }
function finalizeSchedule(executions: readonly MutableExecution[], candidates: readonly CapabilityCandidateV2[], rawDiagnostics: readonly AnalysisDiagnosticV2[], capabilityOrder: readonly string[]): CapabilityScheduleV2 { const diagnostics = sortDiagnostics(rawDiagnostics, capabilityOrder); const idsByCapability = new Map<string, string[]>(); for (const diagnostic of diagnostics) (idsByCapability.get(diagnostic.capabilityId) ?? (idsByCapability.set(diagnostic.capabilityId, []), idsByCapability.get(diagnostic.capabilityId)!)).push(diagnostic.id); const frozenExecutions = Object.freeze(executions.map((execution) => Object.freeze({ ...execution, diagnosticIds: Object.freeze(idsByCapability.get(execution.id) ?? []) }))); return Object.freeze({ executions: frozenExecutions, candidates: Object.freeze(candidates), diagnostics: Object.freeze(diagnostics) }); }

function snapshotSpecs(manifest: ProfileManifestV2, registry: CapabilityRegistryV2): ReadonlyMap<string, CapabilitySpecV2 | undefined> {
  const snapshots = new Map<string, CapabilitySpecV2 | undefined>();
  for (const capability of manifest.capabilities) {
    try {
      const entry = registryEntry(registry, capability.id);
      snapshots.set(capability.id, entry === undefined ? undefined : snapshotSpec(entry, capability));
    } catch { snapshots.set(capability.id, undefined); }
  }
  return snapshots;
}
function snapshotSpec(input: unknown, capability: ProfileCapabilityV2): CapabilitySpecV2 {
  const value = record(input, SPEC_KEYS, true);
  if (value.id !== capability.id || value.version !== capability.version || value.required !== capability.required
    || !sameList(value.dependsOn, capability.dependsOn) || !sameList(value.ruleIds, capability.ruleIds) || typeof value.run !== 'function') throw new TypeError();
  return Object.freeze({ ...capability, dependsOn: Object.freeze([...capability.dependsOn]), ruleIds: Object.freeze([...capability.ruleIds]), run: value.run as CapabilitySpecV2['run'] });
}

function registryEntry(registry: CapabilityRegistryV2, id: string): CapabilitySpecV2 | undefined {
  if (!(registry instanceof Map) || Object.getPrototypeOf(registry) !== Map.prototype) throw new TypeError();
  ownNames(registry, 0, 0);
  return Map.prototype.get.call(registry, id) as CapabilitySpecV2 | undefined;
}
function completedExecution(capability: ProfileCapabilityV2, candidate: CapabilityCandidateV2): MutableExecution {
  return { id: capability.id, version: capability.version, required: capability.required, status: corroboratedCapabilityStatus('COMPLETED', candidate), seen: candidate.seen, analyzed: candidate.analyzed, skipped: candidate.skipped, omitted: candidate.omitted, diagnosticIds: [] };
}
function failedExecution(capability: ProfileCapabilityV2, status: 'SKIPPED' | 'DEGRADED' | 'FAILED', counters: CounterValues, omission: number): MutableExecution {
  return { id: capability.id, version: capability.version, required: capability.required, status, seen: counters.seen, analyzed: counters.analyzed, skipped: counters.skipped, omitted: safeAdd(counters.omitted, omission), diagnosticIds: [] };
}
function schedulerDiagnostic(code: DiagnosticCodeV2, capability: ProfileCapabilityV2, bound?: SnapshotBoundV2): AnalysisDiagnosticV2 {
  const classification = classifyDiagnostic(code, capability.required);
  const identity = { code, capabilityId: capability.id, ...classification, ...(bound === undefined ? {} : { observed: bound.observed, maximum: bound.maximum, omitted: bound.omitted }) };
  return Object.freeze({ ...identity, id: createDiagnosticId(identity) });
}
/**
 * The diagnostic of a capability that could not publish its result. D-1: both failure branches used
 * to publish `REQUIRED_CAPABILITY_FAILED`/`POLICY_EXECUTION_FAILED` whatever the cause, so an
 * operator could not tell a candidate the validator refused for exceeding a limit from a capability
 * that broke, and a context view the scheduler refused for size from either. The cause now selects
 * the code: a limit refusal is published as the registry's limit code (LIMIT category) and carries
 * the bound's numbers (`observed`/`maximum`/`omitted`), whether the refusal came from the context
 * walk or from `validateCapabilityCandidate` — the validator requires exactly those numbers of
 * capability-emitted LIMIT diagnostics (`candidate-validator.ts`), so its own refusals report them
 * too. The remaining vocabulary is unchanged, because the diagnostic record is a closed shape pinned by
 * `contracts/scanner-v2-result.ts`: no free-form reason can be added to it without a contract and
 * diagnostic-registry change.
 */
function capabilityFailureDiagnostic(capability: ProfileCapabilityV2, cause: Readonly<{ limit: boolean; bound?: SnapshotBoundV2 }>): AnalysisDiagnosticV2 {
  const code: DiagnosticCodeV2 = cause.limit
    ? capability.required ? 'REQUIRED_LIMIT_EXCEEDED' : 'OPTIONAL_LIMIT_EXCEEDED'
    : capability.required ? 'REQUIRED_CAPABILITY_FAILED' : 'POLICY_EXECUTION_FAILED';
  return schedulerDiagnostic(code, capability, cause.bound);
}
function record(input: unknown, allowed: readonly string[], allowNullPrototype = false): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError();
  const prototype = Object.getPrototypeOf(input); if (prototype !== Object.prototype && (!allowNullPrototype || prototype !== null)) throw new TypeError();
  const names = ownNames(input, allowed.length, 0); const value = Object.create(null) as Record<string, unknown>;
  for (const name of names) { if (!allowed.includes(name)) throw new TypeError(); const descriptor = Object.getOwnPropertyDescriptor(input, name); if (!descriptor || !('value' in descriptor)) throw new TypeError(); value[name] = descriptor.value; }
  for (const name of allowed) if (!Object.prototype.hasOwnProperty.call(value, name)) throw new TypeError(); return value;
}
function safeAdd(left: number, right: number): number { return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right; }
function sameList(left: unknown, right: readonly string[]): boolean {
  if (!Array.isArray(left) || Object.getPrototypeOf(left) !== Array.prototype) return false;
  const length = Object.getOwnPropertyDescriptor(left, 'length');
  if (!length || !('value' in length) || length.value !== right.length) return false;
  const names = ownNames(left, right.length + 1, 0); if (names.length !== right.length + 1) return false;
  for (let index = 0; index < right.length; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(left, String(index)); if (!descriptor || !('value' in descriptor) || descriptor.value !== right[index]) return false; }
  return true;
}
