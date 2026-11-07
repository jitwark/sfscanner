import { createTargetContextDigestV3, validateTargetPairsV3 } from './scanner-target-v3';
import { isAdvisoryFactKindV1 } from './scanner-v2-advisory';
import { readAdvisoryFactPropertiesV1 } from './scanner-v2-advisory-validation';
import type { EdgeRefV2, NodeRefV2, SourceMemberRefV2, SubjectV2 } from './scanner-v2-source';
import type { AnalysisDiagnosticV2, CapabilityExecutionV2, FindingV2, SafeFactV2, TraceV2 } from './scanner-v2-evidence';
import { BY_CAPABILITY_DIAGNOSTIC_CODES_V2, DIAGNOSTIC_REGISTRY_V2, type DiagnosticCodeV2 } from './scanner-v2-diagnostics.generated';
import { FIELD_FLOW_PROPERTY_TYPES_V1, isFieldFlowFactKindV1 } from './scanner-v2-field-flow';
import { validateFieldFlowProperties, validateFieldFlowSubject } from './scanner-v2-field-flow-validation';
import { validateFieldFlowCoherenceV1, validateFieldFlowWitnessesV1 } from './scanner-v2-field-flow-coherence';
import {
  ADVISORY_APPLICABILITY_PROPERTIES_V3, ADVISORY_APPLICABILITY_V3,
  ADVISORY_EVALUATION_PROPERTIES_V1, ADVISORY_EVALUATION_V1,
  ADVISORY_PACKAGE_COVERAGE_PROPERTIES_V1, ADVISORY_PACKAGE_COVERAGE_V1, ADVISORY_FACT_KINDS_V1,
} from './scanner-v2-advisory';
import { validateAdvisoryCoherenceV1 } from './scanner-v2-advisory-coherence';

export type TargetContextV3 = { schemaVersion: 'scanner-target-v3'; n8nVersion?: string; edition: 'COMMUNITY' | 'ENTERPRISE' | 'CLOUD' | 'UNKNOWN'; deployment: 'SELF_HOSTED' | 'CLOUD' | 'UNKNOWN'; role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'UNKNOWN'; taskRunner: 'LEGACY' | 'NATIVE' | 'UNKNOWN'; communityPackages: readonly { name: string; version?: string }[]; configuration: readonly { key: string; state: 'ENABLED' | 'DISABLED' | 'UNKNOWN' }[]; contextDigest: string };
export type LimitUsageV2 = { id: string; maximum: number; examined: number; omitted: number; exhausted: boolean };
export type ScannerResultV2 = {
  schemaVersion: 'scanner-result-v2';
  engine: { id: 'secureflow-scanner'; version: string; buildDigest: string };
  input: { rawSha256: string; semanticSha256: string; ambiguitySha256: string; ambiguityCount: number; utf8Bytes: number };
  profile: { id: string; version: string };
  ruleset: { id: string; version: string; digest: string; signatureStatus: 'VERIFIED' | 'UNVERIFIED' };
  semantics: { id: string; version: string; digest: string };
  target: TargetContextV3;
  limits: { schemaVersion: 'scanner-limits-v2'; digest: string; usage: LimitUsageV2[] };
  analysis: { status: 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE'; capabilities: CapabilityExecutionV2[]; diagnostics: AnalysisDiagnosticV2[] };
  workflow: { name: string | null; nodeCount: number; rawNodeCount: number; annotationNodeCount: number; triggerCount: number; actionCount: number; integrationCount: number; edgeCount: number; resolvedEdgeCount: number; payloadBytes: number; complexity: 'LOW' | 'MEDIUM' | 'HIGH'; isSubWorkflow: boolean };
  facts: SafeFactV2[]; traces: TraceV2[]; findings: FindingV2[];
  assessment: null | { score: number; grade: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; scoringPolicyVersion: string; basisFindingIds: string[]; excludedReportOnlyFindingIds: string[]; excludedUncertainFindingIds: string[]; excludedNotApplicableFindingIds: string[]; unknownEvidenceCount: number };
  stats: { rejectedCandidates: number; collapsedCandidates: number; omittedFindings: number; serializedBytes: number };
};
export type ScannerResultV2Validation = { ok: true; result: ScannerResultV2 } | { ok: false; errors: string[] };

const TOP = ['schemaVersion', 'engine', 'input', 'profile', 'ruleset', 'semantics', 'target', 'limits', 'analysis', 'workflow', 'facts', 'traces', 'findings', 'assessment', 'stats'] as const;
const DIGEST = /^[0-9a-f]{64}$/;
const POINTER = /^(?:|(?:\/(?:[^~/]|~0|~1)*)+)$/;
const SECRET = /(?:api[ _-]*key|password|secret|credential|authorization|cookie|bearer|token)\s*[:=]|\b(?:sk[-_][\w-]+|AKIA[0-9A-Z]{16}|eyJ[\w-]{12,}\.[\w-]{8,})\b/i;
const UNSAFE = /(?:https?|ftp):\/\/|(?:^|[/\\])\.\.(?:[/\\]|$)|(?:^[/\\]|^[A-Za-z]:[/\\])|\b(?:exception|stack trace|traceback|error:| at [A-Za-z]:[/\\])/i;
const FACT_KINDS = new Set(['workflow.summary.v1', 'workflow.structure.v1', 'workflow.dependencies.v1', 'workflow.effects.v1', 'workflow.function.v1', 'workflow.risk-summary.v1', 'workflow.fingerprint.v1', 'integration.v1', 'node.capability.v2', 'node.configuration.v2', 'code.indicator.v2', 'dataflow.summary.v2', 'destination.v2', 'destination.v3', 'destination.coverage.v1', 'ingress.v2', ...ADVISORY_FACT_KINDS_V1, ...Object.keys(FIELD_FLOW_PROPERTY_TYPES_V1)]);
const FACT_PROPERTIES: Record<string, readonly string[]> = { ...Object.fromEntries(Object.entries(FIELD_FLOW_PROPERTY_TYPES_V1).map(([kind, properties]) => [kind, Object.keys(properties)])), 'workflow.summary.v1': ['connectionCount'], 'workflow.structure.v1': ['total', 'executable', 'disabled', 'inert', 'unresolved', 'vertices', 'edges', 'unresolvedEdges', 'parallelEdgeCount', 'weakComponents', 'structuralCycleRank'], 'workflow.dependencies.v1': ['totalNodes', 'reviewedNodes', 'assumedNodes', 'unknownNodes', 'credentialReferences', 'requiredCredentialSlots', 'configuredCredentialSlots', 'missingCredentialSlots', 'unknownCredentialSlots', 'environmentReferences', 'redactedIdentifiers', 'omittedIdentifiers'], 'workflow.effects.v1': ['totalNodes', 'reviewedNodes', 'assumedNodes', 'unknownNodes', 'effectCounts', 'disabledEffectNodes'], 'workflow.function.v1': ['basicPurpose', 'triggerDescription', 'dataFlowSummary', 'businessCategory', 'confidence'], 'workflow.risk-summary.v1': ['topRisks', 'dataExposure', 'complexityDrivers'], 'workflow.fingerprint.v1': ['value'], 'integration.v1': ['service', 'usage', 'nodeTypes', 'nodeCount', 'riskNotes'], 'node.capability.v2': ['nodeType', 'nodePackage', 'namespaceClass', 'capabilities', 'toolCount', 'contextCount'], 'node.configuration.v2': ['observation', 'header', 'literalValue', 'parameterPath', 'secretKind', 'indicator', 'hasLiteralValue'], 'code.indicator.v2': ['language', 'indicator', 'member', 'start', 'end', 'parseState'], 'dataflow.summary.v2': ['flowKind', 'sink', 'parameterPath', 'referenceRoot', 'propertyPath', 'propertyPathComplete', 'sourceNodeId', 'sourceNodeName', 'humanGatePresent', 'humanGateDominates', 'taintLabels'], 'destination.v2': ['parameterPath', 'scheme', 'hostname', 'authorityState', 'valueMode'], 'destination.v3': ['parameterPath', 'scheme', 'hostname', 'authorityState', 'valueMode', 'reason', 'omitted', 'inventoryStatus'], 'destination.coverage.v1': ['inventoryStatus', 'nodesExamined', 'pathsConfigured', 'recordsEmitted', 'errors', 'omitted', 'errorCodes'], 'ingress.v2': ['authentication', 'authenticationState', 'legacyAuthenticated'], [ADVISORY_EVALUATION_V1]: ADVISORY_EVALUATION_PROPERTIES_V1, [ADVISORY_PACKAGE_COVERAGE_V1]: ADVISORY_PACKAGE_COVERAGE_PROPERTIES_V1, [ADVISORY_APPLICABILITY_V3]: ADVISORY_APPLICABILITY_PROPERTIES_V3 };
// The published schema requires every registered property for the destination inventory kinds: a row
// that omits one publishes coverage its own record does not carry. Property names stay
// FACT_PROPERTIES' single authority; legacy destination.v2 keeps its permissive bag, and the
// field-flow kinds keep their existing required-property checks.
const FACT_EXACT_PROPERTY_KINDS: Readonly<Record<string, true>> = { 'destination.v3': true, 'destination.coverage.v1': true, [ADVISORY_EVALUATION_V1]: true, [ADVISORY_PACKAGE_COVERAGE_V1]: true, [ADVISORY_APPLICABILITY_V3]: true };
const CAPABILITY_ORDER = ['source-normalization', 'workflow-insights', 'structural-policies', 'expression-security', 'javascript-security', 'python-security', 'graph-semantics', 'taint-confidentiality', 'taint-integrity', 'agentic-control', 'assessment', 'presentation-facts'] as const;

type PlainRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is PlainRecord => { try { return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; } catch { return false; } };
function object(v: unknown, keys: readonly string[], required: readonly string[], errors: string[], path: string): PlainRecord | undefined {
  if (!isRecord(v)) { errors.push(`${path} must be an object`); return undefined; }
  try { if (Object.getOwnPropertySymbols(v).length) { errors.push(`${path} has symbols`); return undefined; } const names = Object.getOwnPropertyNames(v); const out = Object.create(Object.prototype) as PlainRecord;
    for (const name of names) { const d = Object.getOwnPropertyDescriptor(v, name); if (!d || !('value' in d)) { errors.push(`${path}.${name} must be data`); return undefined; } if (!keys.includes(name)) errors.push(`${path}.${name} is unknown`); Object.defineProperty(out, name, { value: d.value, writable: true, enumerable: true, configurable: true }); }
    for (const name of required) if (!names.includes(name)) errors.push(`${path}.${name} is missing`); return out;
  } catch { errors.push(`${path} cannot be inspected`); return undefined; }
}
function array(v: unknown, errors: string[], path: string, max = 100_000): unknown[] {
  if (!Array.isArray(v)) { errors.push(`${path} must be an array`); return []; }
  try { const length = v.length; if (!Number.isSafeInteger(length) || length < 0 || length > max) { errors.push(`${path} has an unsafe shape`); return []; } if (Object.getPrototypeOf(v) !== Array.prototype) { errors.push(`${path} must be an array`); return []; }
    const names = Object.getOwnPropertyNames(v); if (Object.getOwnPropertySymbols(v).length || names.length !== length + 1) { errors.push(`${path} has an unsafe shape`); return []; } const out = new Array<unknown>(length);
    for (const name of names) { if (name === 'length') continue; if (!/^(?:0|[1-9]\d*)$/.test(name) || Number(name) >= length) { errors.push(`${path} is sparse`); return []; } const d = Object.getOwnPropertyDescriptor(v, name); if (!d || !('value' in d)) { errors.push(`${path}[${name}] must be data`); return []; } out[Number(name)] = d.value; } return out;
  } catch { errors.push(`${path} cannot be inspected`); return []; }
}
function text(v: unknown, errors: string[], path: string, unsafe = true, max = 4096): v is string { if (typeof v !== 'string' || v.length > max || v.includes('\0') || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) || /[\ud800-\udfff]/.test(v) && !/^[\u0000-\ud7ff\ue000-\uffff]*(?:[\ud800-\udbff][\udc00-\udfff][\u0000-\ud7ff\ue000-\uffff]*)*$/.test(v) || unsafe && (SECRET.test(v) || UNSAFE.test(v))) { errors.push(`${path} has unsafe text`); return false; } return true; }
function digest(v: unknown, errors: string[], path: string): v is string { if (typeof v !== 'string' || !DIGEST.test(v)) { errors.push(`${path} must be lowercase sha256`); return false; } return true; }
function integer(v: unknown, errors: string[], path: string, min = 0): v is number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) { errors.push(`${path} must be a safe integer`); return false; } return true; }
function en(v: unknown, values: readonly string[], errors: string[], path: string): boolean { if (typeof v !== 'string' || !values.includes(v)) { errors.push(`${path} has an invalid enum`); return false; } return true; }
function refs(v: unknown, errors: string[], path: string): string[] { const out = array(v, errors, path); const seen = new Set<string>(); const result: string[] = []; for (const [i, item] of out.entries()) { if (digest(item, errors, `${path}[${i}]`) && seen.has(item)) errors.push(`${path} has a duplicate reference`); if (typeof item === 'string') { seen.add(item); result.push(item); } } return result; }
function position(v: unknown, errors: string[], path: string): PlainRecord | undefined { const o = object(v, ['line', 'column', 'utf16Offset', 'utf8ByteOffset'], ['line', 'column', 'utf16Offset', 'utf8ByteOffset'], errors, path); if (!o) return; integer(o.line, errors, `${path}.line`, 1); integer(o.column, errors, `${path}.column`, 1); integer(o.utf16Offset, errors, `${path}.utf16Offset`); integer(o.utf8ByteOffset, errors, `${path}.utf8ByteOffset`); return o; }
function source(v: unknown, errors: string[], path: string): void { const o = object(v, ['pointer', 'occurrencePath', 'astNodeId', 'span'], ['pointer', 'occurrencePath', 'astNodeId', 'span'], errors, path); if (!o) return; if (text(o.pointer, errors, `${path}.pointer`, false, 2048) && !POINTER.test(o.pointer as string)) errors.push(`${path}.pointer is not RFC6901`); const p = array(o.occurrencePath, errors, `${path}.occurrencePath`); p.forEach((x, i) => integer(x, errors, `${path}.occurrencePath[${i}]`)); digest(o.astNodeId, errors, `${path}.astNodeId`); if (o.span !== null) { const s = object(o.span, ['start', 'end'], ['start', 'end'], errors, `${path}.span`); if (s) { const a = position(s.start, errors, `${path}.span.start`); const b = position(s.end, errors, `${path}.span.end`); if (a && b && typeof a.utf16Offset === 'number' && typeof b.utf16Offset === 'number' && typeof a.utf8ByteOffset === 'number' && typeof b.utf8ByteOffset === 'number' && typeof a.line === 'number' && typeof b.line === 'number' && typeof a.column === 'number' && typeof b.column === 'number' && (b.utf16Offset <= a.utf16Offset || b.utf8ByteOffset <= a.utf8ByteOffset || b.line < a.line || b.line === a.line && b.column <= a.column)) errors.push(`${path}.span is empty or reversed`); } } }
function node(v: unknown, errors: string[], path: string): void { const o = object(v, ['ordinal', 'source', 'explicitId', 'name', 'identityDigest'], ['ordinal', 'source', 'identityDigest'], errors, path); if (!o) return; integer(o.ordinal, errors, `${path}.ordinal`); source(o.source, errors, `${path}.source`); if ('explicitId' in o) text(o.explicitId, errors, `${path}.explicitId`); if ('name' in o) text(o.name, errors, `${path}.name`); digest(o.identityDigest, errors, `${path}.identityDigest`); }
function edge(v: unknown, errors: string[], path: string): void { const o = object(v, ['ordinal', 'sourceNode', 'targetNode', 'sourceLabel', 'targetLabel', 'connectionType', 'sourcePort', 'targetPort', 'source', 'resolution'], ['ordinal', 'sourceLabel', 'connectionType', 'sourcePort', 'targetPort', 'source', 'resolution'], errors, path); if (!o) return; integer(o.ordinal, errors, `${path}.ordinal`); if ('sourceNode' in o) node(o.sourceNode, errors, `${path}.sourceNode`); if ('targetNode' in o) node(o.targetNode, errors, `${path}.targetNode`); text(o.sourceLabel, errors, `${path}.sourceLabel`); if ('targetLabel' in o) text(o.targetLabel, errors, `${path}.targetLabel`); text(o.connectionType, errors, `${path}.connectionType`); integer(o.sourcePort, errors, `${path}.sourcePort`); integer(o.targetPort, errors, `${path}.targetPort`); source(o.source, errors, `${path}.source`); en(o.resolution, ['RESOLVED', 'AMBIGUOUS', 'UNRESOLVED'], errors, `${path}.resolution`); }
function subject(v: unknown, errors: string[], path: string): void { const o = object(v, ['kind', 'node', 'edge', 'source'], ['kind'], errors, path); if (!o) return; if (o.kind === 'WORKFLOW') { if (Object.getOwnPropertyNames(o).length !== 1) errors.push(`${path} has unknown subject fields`); } else if (o.kind === 'NODE') { const n = object(o, ['kind', 'node'], ['kind', 'node'], errors, path); if (n) node(n.node, errors, `${path}.node`); } else if (o.kind === 'EDGE') { const e = object(o, ['kind', 'edge'], ['kind', 'edge'], errors, path); if (e) edge(e.edge, errors, `${path}.edge`); } else if (o.kind === 'SOURCE') { const s = object(o, ['kind', 'source'], ['kind', 'source'], errors, path); if (s) source(s.source, errors, `${path}.source`); } else errors.push(`${path}.kind has an invalid enum`); }
function propertyObject(v: unknown, errors: string[], path: string): PlainRecord | undefined { if (!isRecord(v)) { errors.push(`${path} must be an object`); return undefined; } try { if (Object.getOwnPropertySymbols(v).length) { errors.push(`${path} has symbols`); return undefined; } const out = Object.create(Object.prototype) as PlainRecord; for (const key of Object.getOwnPropertyNames(v)) { const d = Object.getOwnPropertyDescriptor(v, key); if (!d || !('value' in d)) { errors.push(`${path}.${key} must be data`); return undefined; } Object.defineProperty(out, key, { value: d.value, writable: true, enumerable: true, configurable: true }); } return out; } catch { errors.push(`${path} cannot be inspected`); return undefined; } }
function propertyText(value: unknown, key: string, errors: string[], path: string): value is string {
  const pointerProperty = key === 'parameterPath' || key === 'propertyPath';
  if (!text(value, errors, path, !pointerProperty)) return false;
  if (pointerProperty && !POINTER.test(value)) { errors.push(`${path} is not RFC6901`); return false; }
  return true;
}
function fact(v: unknown, errors: string[], path: string): string | undefined {
  const o = object(v, ['factId', 'kind', 'subject', 'properties'], ['factId', 'kind', 'subject', 'properties'], errors, path);
  if (!o) return;
  digest(o.factId, errors, `${path}.factId`);
  if (typeof o.kind !== 'string' || !FACT_KINDS.has(o.kind)) errors.push(`${path}.kind is not registered`);
  else text(o.kind, errors, `${path}.kind`, false);
  subject(o.subject, errors, `${path}.subject`);
  const p = propertyObject(o.properties, errors, `${path}.properties`);
  if (!p) return typeof o.factId === 'string' ? o.factId : undefined;
  if (isAdvisoryFactKindV1(o.kind)) {
    if (typeof o.kind !== 'string' || readAdvisoryFactPropertiesV1(o.kind, p) === undefined
      || !o.subject || (o.subject as PlainRecord).kind !== 'WORKFLOW') errors.push(`${path} has invalid advisory evidence`);
    return typeof o.factId === 'string' ? o.factId : undefined;
  }
  if (isFieldFlowFactKindV1(o.kind)) {
    const allowed = FACT_PROPERTIES[o.kind];
    if (!allowed || Object.getOwnPropertyNames(p).some((key) => !allowed.includes(key))
      || !validateFieldFlowProperties(o.kind, p) || !validateFieldFlowSubject(o.kind, o.subject, p)) errors.push(`${path} has invalid field-flow evidence`);
    return typeof o.factId === 'string' ? o.factId : undefined;
  }
  for (const key of Object.getOwnPropertyNames(p)) { if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key)) errors.push(`${path}.properties.${key} is invalid`); if (typeof o.kind === 'string' && FACT_PROPERTIES[o.kind] && !FACT_PROPERTIES[o.kind].includes(key)) errors.push(`${path}.properties.${key} is not registered`); const value = p[key]; if (Array.isArray(value)) { const a = array(value, errors, `${path}.properties.${key}`, 1000); a.forEach((x, i) => { if (!(x === null || typeof x === 'boolean' || typeof x === 'number' && Number.isFinite(x) && Number.isSafeInteger(x) || typeof x === 'string' && text(x, errors, `${path}.properties.${key}[${i}]`))) errors.push(`${path}.properties.${key}[${i}] is unsafe`); }); } else if (!(value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value) || typeof value === 'string' && propertyText(value, key, errors, `${path}.properties.${key}`))) errors.push(`${path}.properties.${key} is unsafe`); }
  const exact = typeof o.kind === 'string' && Object.hasOwn(FACT_EXACT_PROPERTY_KINDS, o.kind) ? FACT_PROPERTIES[o.kind] : undefined;
  if (exact) for (const key of exact) if (!Object.hasOwn(p, key)) errors.push(`${path}.properties.${key} is required`);
  return typeof o.factId === 'string' ? o.factId : undefined;
}
function trace(v: unknown, facts: Set<string>, errors: string[], path: string): string | undefined { const o = object(v, ['traceId', 'kind', 'steps'], ['traceId', 'kind', 'steps'], errors, path); if (!o) return; digest(o.traceId, errors, `${path}.traceId`); en(o.kind, ['CONFIDENTIALITY', 'INTEGRITY', 'CONTROL'], errors, `${path}.kind`); const steps = array(o.steps, errors, `${path}.steps`, 10000); const ordinals = new Set<number>(); steps.forEach((item, i) => { const s = object(item, ['ordinal', 'kind', 'subject', 'factRefs'], ['ordinal', 'kind', 'subject', 'factRefs'], errors, `${path}.steps[${i}]`); if (!s) return; integer(s.ordinal, errors, `${path}.steps[${i}].ordinal`); if (typeof s.ordinal === 'number' && ordinals.has(s.ordinal)) errors.push(`${path}.steps has duplicate ordinal`); if (typeof s.ordinal === 'number') ordinals.add(s.ordinal); en(s.kind, ['SOURCE', 'PROPAGATION', 'SANITIZER', 'SINK'], errors, `${path}.steps[${i}].kind`); subject(s.subject, errors, `${path}.steps[${i}].subject`); for (const ref of refs(s.factRefs, errors, `${path}.steps[${i}].factRefs`)) if (!facts.has(ref)) errors.push(`${path}.steps[${i}] has dangling fact reference`); }); return typeof o.traceId === 'string' ? o.traceId : undefined; }
function finding(v: unknown, facts: Set<string>, traces: Set<string>, errors: string[], path: string): string | undefined { const o = object(v, ['findingId', 'ruleId', 'ruleRevision', 'effect', 'severity', 'confidence', 'evidenceClass', 'conclusion', 'applicability', 'subject', 'factRefs', 'traceRefs', 'remediationId'], ['findingId', 'ruleId', 'ruleRevision', 'effect', 'severity', 'confidence', 'evidenceClass', 'conclusion', 'applicability', 'subject', 'factRefs', 'traceRefs', 'remediationId'], errors, path); if (!o) return; digest(o.findingId, errors, `${path}.findingId`); for (const k of ['ruleId', 'ruleRevision', 'remediationId']) text(o[k], errors, `${path}.${k}`); en(o.effect, ['SCORING', 'REPORT_ONLY'], errors, `${path}.effect`); en(o.severity, ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'], errors, `${path}.severity`); en(o.confidence, ['HIGH', 'MEDIUM', 'LOW'], errors, `${path}.confidence`); en(o.evidenceClass, ['CAPABILITY', 'CONFIGURATION', 'SUSPICIOUS_SYNTAX', 'POTENTIAL_DATAFLOW', 'VERSION_APPLICABILITY'], errors, `${path}.evidenceClass`); en(o.conclusion, ['OBSERVED', 'POTENTIAL', 'UNKNOWN'], errors, `${path}.conclusion`); en(o.applicability, ['APPLICABLE', 'NOT_APPLICABLE', 'UNKNOWN'], errors, `${path}.applicability`); subject(o.subject, errors, `${path}.subject`); for (const ref of refs(o.factRefs, errors, `${path}.factRefs`)) if (!facts.has(ref)) errors.push(`${path} has dangling fact reference`); for (const ref of refs(o.traceRefs, errors, `${path}.traceRefs`)) if (!traces.has(ref)) errors.push(`${path} has dangling trace reference`); return typeof o.findingId === 'string' ? o.findingId : undefined; }
type DiagnosticInfo = { id?: string; capabilityId?: string; aggregateEffect?: string; omitted?: number };
function diagnostic(v: unknown, capabilities: Set<string>, errors: string[], path: string): DiagnosticInfo { const o = object(v, ['id', 'code', 'category', 'capabilityId', 'aggregateEffect', 'assessmentEligible', 'location', 'observed', 'maximum', 'omitted'], ['id', 'code', 'category', 'capabilityId', 'aggregateEffect', 'assessmentEligible'], errors, path); if (!o) return {}; digest(o.id, errors, `${path}.id`); if (!en(o.code, Object.keys(DIAGNOSTIC_REGISTRY_V2), errors, `${path}.code`)) return {}; const expected = DIAGNOSTIC_REGISTRY_V2[o.code as DiagnosticCodeV2]; en(o.category, ['LIMIT', 'SOURCE', 'PARSER', 'POLICY', 'GRAPH', 'CATALOGUE', 'COMPATIBILITY'], errors, `${path}.category`); text(o.capabilityId, errors, `${path}.capabilityId`); if (typeof o.capabilityId !== 'string' || !capabilities.has(o.capabilityId)) errors.push(`${path}.capabilityId is dangling`); en(o.aggregateEffect, ['NONE', 'DEGRADED', 'INDETERMINATE'], errors, `${path}.aggregateEffect`); if (typeof o.assessmentEligible !== 'boolean') errors.push(`${path}.assessmentEligible must be boolean`); if (BY_CAPABILITY_DIAGNOSTIC_CODES_V2[o.code as DiagnosticCodeV2] === true) { if (o.category !== expected[0] || !['DEGRADED', 'INDETERMINATE'].includes(String(o.aggregateEffect)) || o.assessmentEligible !== (o.aggregateEffect === 'DEGRADED')) errors.push(`${path} has invalid registry effect`); } else if (o.category !== expected[0] || o.aggregateEffect !== expected[1] || o.assessmentEligible !== expected[2]) errors.push(`${path} disagrees with diagnostic registry`); if ('location' in o) source(o.location, errors, `${path}.location`); for (const k of ['observed', 'maximum', 'omitted']) if (k in o) integer(o[k], errors, `${path}.${k}`); return { id: typeof o.id === 'string' ? o.id : undefined, capabilityId: typeof o.capabilityId === 'string' ? o.capabilityId : undefined, aggregateEffect: typeof o.aggregateEffect === 'string' ? o.aggregateEffect : undefined, omitted: typeof o.omitted === 'number' ? o.omitted : undefined }; }
type CapabilityInfo = { id?: string; required?: boolean; status?: string; skipped?: number; omitted?: number; diagnosticIds: string[] };
/** Exact `total > sum(parts)`, subtracting one part at a time so no intermediate can round past 2^53. */
function exceeds(total: number, parts: readonly [number, number, number]): boolean { let remaining = total; for (const part of parts) { if (remaining <= part) return false; remaining -= part; } return true; }
/**
 * The count arithmetic of the completeness lattice, restated because `contracts/` cannot import the
 * scanner core; `count-lattice-contract-pin.test.ts` pins this restatement to the producer over every
 * count set. A row cannot analyze units it never accounted for (`UNSEEN_ANALYSIS`) and cannot leave
 * observed units unaccounted for (`UNACCOUNTED_SEEN`): either way a `COMPLETED` row publishes a
 * completeness its own record does not support. The counters are deliberately not required to
 * partition `seen`, because analyzers count in their own units, so only these two directions - which
 * no run can produce - are refused.
 */
function countConsistency(counts: readonly (number | undefined)[], path: string, errors: string[]): void {
  const [seen, analyzed, skipped, omitted] = counts;
  if (seen === undefined || analyzed === undefined || skipped === undefined || omitted === undefined) return;
  if (exceeds(analyzed, [seen, skipped, omitted])) errors.push(`${path} counters record UNSEEN_ANALYSIS: analyzed exceeds seen + skipped + omitted`);
  else if (exceeds(seen, [analyzed, skipped, omitted])) errors.push(`${path} counters record UNACCOUNTED_SEEN: seen exceeds analyzed + skipped + omitted`);
}
function capability(v: unknown, errors: string[], path: string): CapabilityInfo { const o = object(v, ['id', 'version', 'required', 'status', 'seen', 'analyzed', 'skipped', 'omitted', 'diagnosticIds'], ['id', 'version', 'required', 'status', 'seen', 'analyzed', 'skipped', 'omitted', 'diagnosticIds'], errors, path); if (!o) return { diagnosticIds: [] }; text(o.id, errors, `${path}.id`); text(o.version, errors, `${path}.version`); if (typeof o.required !== 'boolean') errors.push(`${path}.required must be boolean`); en(o.status, ['COMPLETED', 'SKIPPED', 'DEGRADED', 'FAILED'], errors, `${path}.status`); const counts: Array<number | undefined> = []; for (const k of ['seen', 'analyzed', 'skipped', 'omitted']) { const value = o[k]; counts.push(integer(value, errors, `${path}.${k}`) ? value : undefined); } countConsistency(counts, path, errors); const diagnosticIds = refs(o.diagnosticIds, errors, `${path}.diagnosticIds`); return { id: typeof o.id === 'string' ? o.id : undefined, required: typeof o.required === 'boolean' ? o.required : undefined, status: typeof o.status === 'string' ? o.status : undefined, skipped: typeof o.skipped === 'number' ? o.skipped : undefined, omitted: typeof o.omitted === 'number' ? o.omitted : undefined, diagnosticIds }; }
function target(v: unknown, errors: string[]): void { const o = object(v, ['schemaVersion', 'n8nVersion', 'edition', 'deployment', 'role', 'taskRunner', 'communityPackages', 'configuration', 'contextDigest'], ['schemaVersion', 'edition', 'deployment', 'role', 'taskRunner', 'communityPackages', 'configuration', 'contextDigest'], errors, 'target'); if (!o) return; if (o.schemaVersion !== 'scanner-target-v3') errors.push('target.schemaVersion is unsupported'); if ('n8nVersion' in o) text(o.n8nVersion, errors, 'target.n8nVersion'); en(o.edition, ['COMMUNITY', 'ENTERPRISE', 'CLOUD', 'UNKNOWN'], errors, 'target.edition'); en(o.deployment, ['SELF_HOSTED', 'CLOUD', 'UNKNOWN'], errors, 'target.deployment'); en(o.role, ['OWNER', 'ADMIN', 'MEMBER', 'UNKNOWN'], errors, 'target.role'); en(o.taskRunner, ['LEGACY', 'NATIVE', 'UNKNOWN'], errors, 'target.taskRunner'); digest(o.contextDigest, errors, 'target.contextDigest'); const packs = array(o.communityPackages, errors, 'target.communityPackages'); const pairs = new Set<string>(); packs.forEach((v, i) => { const p = object(v, ['name', 'version'], ['name'], errors, `target.communityPackages[${i}]`); if (p) { text(p.name, errors, `target.communityPackages[${i}].name`); if ('version' in p) text(p.version, errors, `target.communityPackages[${i}].version`); const key = typeof p.name === 'string' ? `${p.name}\u0000${typeof p.version === 'string' ? p.version : ''}` : undefined; if (key !== undefined && pairs.has(key)) errors.push('target.communityPackages has duplicates'); if (key !== undefined) pairs.add(key); } }); const cfg = array(o.configuration, errors, 'target.configuration'); const configKeys = new Set<string>(); cfg.forEach((v, i) => { const p = object(v, ['key', 'state'], ['key', 'state'], errors, `target.configuration[${i}]`); if (p) { text(p.key, errors, `target.configuration[${i}].key`); en(p.state, ['ENABLED', 'DISABLED', 'UNKNOWN'], errors, `target.configuration[${i}].state`); if (typeof p.key === 'string' && configKeys.has(p.key)) errors.push('target.configuration has duplicates'); if (typeof p.key === 'string') configKeys.add(p.key); } }); }
function assessment(v: unknown, findings: Set<string>, errors: string[]): void { if (v === null) return; const o = object(v, ['score', 'grade', 'scoringPolicyVersion', 'basisFindingIds', 'excludedReportOnlyFindingIds', 'excludedUncertainFindingIds', 'excludedNotApplicableFindingIds', 'unknownEvidenceCount'], ['score', 'grade', 'scoringPolicyVersion', 'basisFindingIds', 'excludedReportOnlyFindingIds', 'excludedUncertainFindingIds', 'excludedNotApplicableFindingIds', 'unknownEvidenceCount'], errors, 'assessment'); if (!o) return; integer(o.score, errors, 'assessment.score'); if (typeof o.score === 'number' && o.score > 100) errors.push('assessment.score must be at most 100'); if (typeof o.score === 'number') { const grade = o.score >= 80 ? 'CRITICAL' : o.score >= 55 ? 'HIGH' : o.score >= 25 ? 'MEDIUM' : 'LOW'; if (o.grade !== grade) errors.push('assessment.grade disagrees with score'); } en(o.grade, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], errors, 'assessment.grade'); text(o.scoringPolicyVersion, errors, 'assessment.scoringPolicyVersion'); const all = new Set<string>(); let uncertainCount = 0; for (const k of ['basisFindingIds', 'excludedReportOnlyFindingIds', 'excludedUncertainFindingIds', 'excludedNotApplicableFindingIds']) { const ids = refs(o[k], errors, `assessment.${k}`); if (k === 'excludedUncertainFindingIds') uncertainCount = ids.length; for (const id of ids) { if (!findings.has(id)) errors.push(`assessment.${k} has dangling finding reference`); if (all.has(id)) errors.push('assessment finding classes overlap'); all.add(id); } } integer(o.unknownEvidenceCount, errors, 'assessment.unknownEvidenceCount'); if (typeof o.unknownEvidenceCount === 'number' && o.unknownEvidenceCount !== uncertainCount) errors.push('assessment.unknownEvidenceCount is inconsistent'); if (all.size !== findings.size) errors.push('assessment does not classify every finding'); }
/**
 * A capability row may claim `COMPLETED` only when its counters record no unperformed units, and the
 * published analysis status must be the strongest effect those rows and the diagnostics impose:
 * a required row that dropped omitted units, failed, or was skipped makes the result indeterminate,
 * while any other recorded skip or omission degrades it.
 */
function analysisStatus(status: unknown, capabilities: readonly CapabilityInfo[], diagnostics: readonly DiagnosticInfo[], resultOmitted: boolean, errors: string[]): void {
  let expected: 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE' = 'COMPLETE';
  capabilities.forEach((item, index) => {
    // `skipped` and `omitted` are the units the row recorded but did not perform.
    const unperformed = (item.skipped ?? 0) > 0 || (item.omitted ?? 0) > 0;
    const unsafeTruncation = item.required === true && (item.omitted ?? 0) > 0;
    if (item.status === 'COMPLETED' && unperformed) errors.push(`analysis.capabilities[${index}] claims COMPLETED while recording skipped or omitted units`);
    if (item.required === true && (item.status === 'FAILED' || item.status === 'SKIPPED')) expected = 'INDETERMINATE';
    else if (unsafeTruncation) expected = 'INDETERMINATE';
    else if (expected === 'COMPLETE' && (item.status !== 'COMPLETED' || unperformed)) expected = 'DEGRADED';
  });
  for (const item of diagnostics) { if (item.aggregateEffect === 'INDETERMINATE') expected = 'INDETERMINATE'; else if (expected === 'COMPLETE' && item.aggregateEffect === 'DEGRADED') expected = 'DEGRADED'; }
  if (resultOmitted && expected === 'COMPLETE') expected = 'DEGRADED';
  if (status !== expected) errors.push('analysis.status disagrees with capability/diagnostic effects');
}
function resultOmitted(limitsOmitted: boolean, stats: PlainRecord | undefined, diagnostics: readonly DiagnosticInfo[]): boolean { if (limitsOmitted || typeof stats?.omittedFindings === 'number' && stats.omittedFindings > 0) return true; return diagnostics.some((item) => typeof item.omitted === 'number' && item.omitted > 0); }
const MAX_CLONE_DEPTH = 128;
const MAX_CLONE_NODES = 1_000_000;
const MAX_CLONE_PROPERTIES = 5_000_000;
function cloneGraph(root: unknown): unknown {
  const active = new Set<object>(); const copies = new Map<object, PlainRecord | unknown[]>();
  let nodes = 0; let properties = 0;
  const clone = (value: unknown, depth: number): unknown => {
    if (value === null) return null;
    if (typeof value !== 'object') {
      if (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') return value;
      throw new Error('unsafe scalar');
    }
    if (depth > MAX_CLONE_DEPTH) throw new Error('clone depth exceeded');
    if (copies.has(value)) {
      if (active.has(value)) throw new Error('cyclic graph');
      return copies.get(value);
    }
    if (++nodes > MAX_CLONE_NODES) throw new Error('clone node limit exceeded');
    active.add(value);
    try {
      const isArray = Array.isArray(value);
      if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype)) throw new Error('unsafe prototype');
      if (Object.getOwnPropertySymbols(value).length) throw new Error('symbols are not supported');
      const names = Object.getOwnPropertyNames(value); properties += names.length;
      if (properties > MAX_CLONE_PROPERTIES) throw new Error('clone property limit exceeded');
      if (isArray) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
        if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 100_000 || names.length !== lengthDescriptor.value + 1) throw new Error('unsafe array shape');
        const out = new Array<unknown>(lengthDescriptor.value); copies.set(value, out);
        for (const name of names) {
          if (name === 'length') continue;
          if (!/^(?:0|[1-9]\d*)$/.test(name) || Number(name) >= lengthDescriptor.value) throw new Error('unsafe array index');
          const descriptor = Object.getOwnPropertyDescriptor(value, name);
          if (!descriptor || !('value' in descriptor)) throw new Error('accessor is not supported');
          Object.defineProperty(out, name, { value: clone(descriptor.value, depth + 1), writable: true, enumerable: true, configurable: true });
        }
        return Object.freeze(out);
      }
      const out = Object.create(Object.prototype) as PlainRecord; copies.set(value, out);
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || !('value' in descriptor)) throw new Error('accessor is not supported');
        Object.defineProperty(out, name, { value: clone(descriptor.value, depth + 1), writable: true, enumerable: true, configurable: true });
      }
      return Object.freeze(out);
    } finally { active.delete(value); }
  };
  return clone(root, 0);
}
export function validateScannerResultV2(candidate: unknown): ScannerResultV2Validation {
  const errors: string[] = []; let snapshot: unknown; try { snapshot = cloneGraph(candidate); } catch { return { ok: false, errors: ['result cannot be safely copied'] }; } const root = object(snapshot, TOP, TOP, errors, 'result'); if (!root) return { ok: false, errors };
  if (root.schemaVersion !== 'scanner-result-v2') errors.push('result.schemaVersion is unsupported');
  const e = object(root.engine, ['id', 'version', 'buildDigest'], ['id', 'version', 'buildDigest'], errors, 'engine'); if (e) { if (e.id !== 'secureflow-scanner') errors.push('engine.id is unsupported'); text(e.version, errors, 'engine.version'); digest(e.buildDigest, errors, 'engine.buildDigest'); }
  const input = object(root.input, ['rawSha256', 'semanticSha256', 'ambiguitySha256', 'ambiguityCount', 'utf8Bytes'], ['rawSha256', 'semanticSha256', 'ambiguitySha256', 'ambiguityCount', 'utf8Bytes'], errors, 'input'); if (input) { digest(input.rawSha256, errors, 'input.rawSha256'); digest(input.semanticSha256, errors, 'input.semanticSha256'); digest(input.ambiguitySha256, errors, 'input.ambiguitySha256'); integer(input.ambiguityCount, errors, 'input.ambiguityCount'); integer(input.utf8Bytes, errors, 'input.utf8Bytes'); }
  for (const k of ['profile', 'ruleset', 'semantics'] as const) { const o = object(root[k], k === 'profile' ? ['id', 'version'] : ['id', 'version', 'digest', ...(k === 'ruleset' ? ['signatureStatus'] : [])], ['id', 'version', ...(k === 'profile' ? [] : ['digest']), ...(k === 'ruleset' ? ['signatureStatus'] : [])], errors, k); if (o) { text(o.id, errors, `${k}.id`); text(o.version, errors, `${k}.version`); if (k !== 'profile') digest(o.digest, errors, `${k}.digest`); if (k === 'ruleset') en(o.signatureStatus, ['VERIFIED', 'UNVERIFIED'], errors, 'ruleset.signatureStatus'); } }
  target(root.target, errors);
  if (errors.length === 0 && !validateTargetPairsV3(root.target as TargetContextV3)) errors.push('target has invalid package pairs or versions');
  if (errors.length === 0 && createTargetContextDigestV3(root.target as TargetContextV3) !== (root.target as TargetContextV3).contextDigest) errors.push('target.contextDigest does not match target contents');
  const lim = object(root.limits, ['schemaVersion', 'digest', 'usage'], ['schemaVersion', 'digest', 'usage'], errors, 'limits'); let limitsOmitted = false; if (lim) { if (lim.schemaVersion !== 'scanner-limits-v2') errors.push('limits.schemaVersion is unsupported'); digest(lim.digest, errors, 'limits.digest'); const ids = new Set<string>(); array(lim.usage, errors, 'limits.usage').forEach((v, i) => { const u = object(v, ['id', 'maximum', 'examined', 'omitted', 'exhausted'], ['id', 'maximum', 'examined', 'omitted', 'exhausted'], errors, `limits.usage[${i}]`); if (u) { text(u.id, errors, `limits.usage[${i}].id`); integer(u.maximum, errors, `limits.usage[${i}].maximum`); integer(u.examined, errors, `limits.usage[${i}].examined`); integer(u.omitted, errors, `limits.usage[${i}].omitted`); if (typeof u.omitted === 'number' && u.omitted > 0) limitsOmitted = true; if (typeof u.maximum === 'number' && typeof u.examined === 'number' && u.examined < u.maximum && u.exhausted === true) errors.push('limits.usage exhausted before maximum'); if (typeof u.id === 'string' && ids.has(u.id)) errors.push('limits.usage has duplicate id'); if (typeof u.id === 'string') ids.add(u.id); if (typeof u.exhausted !== 'boolean') errors.push(`limits.usage[${i}].exhausted must be boolean`); } }); }
  const stats = object(root.stats, ['rejectedCandidates', 'collapsedCandidates', 'omittedFindings', 'serializedBytes'], ['rejectedCandidates', 'collapsedCandidates', 'omittedFindings', 'serializedBytes'], errors, 'stats'); if (stats) for (const k of ['rejectedCandidates', 'collapsedCandidates', 'omittedFindings', 'serializedBytes']) integer(stats[k], errors, `stats.${k}`);
  const facts = new Set<string>(); const factIds = new Set<string>(); array(root.facts, errors, 'facts').forEach((v, i) => { const id = fact(v, errors, `facts[${i}]`); if (id && factIds.has(id)) errors.push('facts has duplicate factId'); if (id) { factIds.add(id); facts.add(id); } });
  const traces = new Set<string>(); const traceIds = new Set<string>(); array(root.traces, errors, 'traces').forEach((v, i) => { const id = trace(v, facts, errors, `traces[${i}]`); if (id && traceIds.has(id)) errors.push('traces has duplicate traceId'); if (id) { traceIds.add(id); traces.add(id); } });
  const findings = new Set<string>(); const findingIds = new Set<string>(); array(root.findings, errors, 'findings').forEach((v, i) => { const id = finding(v, facts, traces, errors, `findings[${i}]`); if (id && findingIds.has(id)) errors.push('findings has duplicate findingId'); if (id) { findingIds.add(id); findings.add(id); } });
  const analysis = object(root.analysis, ['status', 'capabilities', 'diagnostics'], ['status', 'capabilities', 'diagnostics'], errors, 'analysis');
  if (analysis) {
    en(analysis.status, ['COMPLETE', 'DEGRADED', 'INDETERMINATE'], errors, 'analysis.status'); const caps = array(analysis.capabilities, errors, 'analysis.capabilities'); const capIds = new Set<string>(); let lastOrder = -1; const capInfos: CapabilityInfo[] = []; const ownership = new Map<string, string[]>();
    caps.forEach((v, i) => { const x = capability(v, errors, `analysis.capabilities[${i}]`); capInfos.push(x); if (x.id) { if (capIds.has(x.id)) errors.push('analysis.capabilities has duplicate id'); const order = CAPABILITY_ORDER.indexOf(x.id as typeof CAPABILITY_ORDER[number]); if (order < 0) errors.push(`analysis.capabilities[${i}].id is not registered`); else if (order <= lastOrder) errors.push('analysis.capabilities are out of registry order'); else lastOrder = order; capIds.add(x.id); for (const id of x.diagnosticIds) ownership.set(id, [...(ownership.get(id) ?? []), x.id]); } });
    const ds = array(analysis.diagnostics, errors, 'analysis.diagnostics'); const diagInfos: DiagnosticInfo[] = []; const diagIds = new Set<string>(); const diagOwners = new Map<string, string>(); ds.forEach((v, i) => { const info = diagnostic(v, capIds, errors, `analysis.diagnostics[${i}]`); diagInfos.push(info); if (info.id && diagIds.has(info.id)) errors.push('analysis.diagnostics has duplicate id'); if (info.id) { diagIds.add(info.id); if (info.capabilityId) diagOwners.set(info.id, info.capabilityId); } });
    for (const [id, owners] of ownership) { if (!diagIds.has(id)) errors.push('capability diagnostic reference is dangling'); if (owners.length !== 1) errors.push('diagnostic has multiple capability owners'); else if (diagOwners.get(id) !== owners[0]) errors.push('diagnostic ownership disagrees with capabilityId'); }
    for (const id of diagIds) if (!ownership.has(id)) errors.push('diagnostic is unreferenced by capabilities');
    /**
     * A diagnostic that names the units it omitted is the capability's own record of unperformed work, so
     * the row that owns it has to record the same loss. Counters claiming nothing was omitted while their
     * diagnostic records truncation is the reachable form of silent truncation, and it is the one
     * counter/diagnostic pairing no run can produce.
     */
    const omittedByCapability = new Map<string, number>();
    for (const info of capInfos) if (info.id !== undefined && info.omitted !== undefined) omittedByCapability.set(info.id, info.omitted);
    diagInfos.forEach((info, index) => { if (info.capabilityId !== undefined && (info.omitted ?? 0) > 0 && omittedByCapability.get(info.capabilityId) === 0) errors.push(`analysis.diagnostics[${index}] counters record UNRECORDED_OMISSION: omitted exceeds the owning capability omitted count`); });
    analysisStatus(analysis.status, capInfos, diagInfos, resultOmitted(limitsOmitted, stats, diagInfos), errors); if (analysis.status === 'INDETERMINATE' && root.assessment !== null) errors.push('indeterminate analysis must have null assessment'); if (analysis.status === 'COMPLETE' && root.assessment === null) errors.push('complete analysis requires assessment');
  }
  const workflow = object(root.workflow, ['name', 'nodeCount', 'rawNodeCount', 'annotationNodeCount', 'triggerCount', 'actionCount', 'integrationCount', 'edgeCount', 'resolvedEdgeCount', 'payloadBytes', 'complexity', 'isSubWorkflow'], ['name', 'nodeCount', 'rawNodeCount', 'annotationNodeCount', 'triggerCount', 'actionCount', 'integrationCount', 'edgeCount', 'resolvedEdgeCount', 'payloadBytes', 'complexity', 'isSubWorkflow'], errors, 'workflow'); if (workflow) { if (workflow.name !== null) text(workflow.name, errors, 'workflow.name'); for (const k of ['nodeCount', 'rawNodeCount', 'annotationNodeCount', 'triggerCount', 'actionCount', 'integrationCount', 'edgeCount', 'resolvedEdgeCount', 'payloadBytes']) integer(workflow[k], errors, `workflow.${k}`); en(workflow.complexity, ['LOW', 'MEDIUM', 'HIGH'], errors, 'workflow.complexity'); if (typeof workflow.isSubWorkflow !== 'boolean') errors.push('workflow.isSubWorkflow must be boolean'); }
  assessment(root.assessment, findings, errors);
  if (errors.length === 0 && !validateFieldFlowCoherenceV1(root.facts as SafeFactV2[])) errors.push('facts have incoherent field-flow references');
  if (errors.length === 0) errors.push(...validateAdvisoryCoherenceV1(root.target as TargetContextV3, root.facts as SafeFactV2[]));
  if (errors.length === 0 && !validateFieldFlowWitnessesV1(root.facts as SafeFactV2[], root.findings as FindingV2[], root.traces as TraceV2[])) errors.push('findings have incoherent field-flow witnesses');
  if (errors.length) return { ok: false, errors }; return { ok: true, result: snapshot as ScannerResultV2 };
}
export type { AnalysisDiagnosticV2, CapabilityExecutionV2, EdgeRefV2, FindingV2, NodeRefV2, SafeFactV2, SourceMemberRefV2, SubjectV2 };
