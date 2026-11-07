import { buildAdvisoryFactsV1 } from '../advisories/advisory-evaluation';
import { rekeyFacts } from './rekey-evidence';
import type { AnalysisDiagnosticV2, CapabilityExecutionV2, FindingV2, SafeFactV2, TraceV2 } from '../../../../contracts/scanner-v2-evidence';
import { validateScannerResultV2, type ScannerResultV2 } from '../../../../contracts/scanner-v2-result';
import type { AdmittedRuleV2, CapabilityCandidateV2 } from '../capabilities/scheduler';
import { canonicalBytesV1 } from './canonical-bytes';
import { redactLabelRefs, sanitizeDisplayLabel } from './display-label';
import { canonicalSubjectIdentity, createFindingId, createTraceId, type IdentityContextV2 } from './identities';
import { admittedFindingRulesV2, findingRuleV2 } from './finding-authority';
import { ruleAuthorityMatchesV2, type RuleAuthorityClaimV2 } from '../rules-v2/rule-authority';
import { sortDiagnostics } from '../diagnostics/identity';
import { corroboratedCapabilityStatus, countLatticeEffect, strongestAnalysisStatus, type CapabilityCountsV2 } from '../capabilities/count-lattice';
import { admitCompositionFactsV1, admitCandidateCompositionFactsV1 } from './field-flow-admission';

type CandidateFinding = CapabilityCandidateV2['findings'][number];
type ResultAssessment = ScannerResultV2['assessment'];
type ResultStats = ScannerResultV2['stats'];
type ResultLimits = ScannerResultV2['limits'];
type ResultRuleset = ScannerResultV2['ruleset'] & Readonly<{ rules?: ReadonlyMap<string, AdmittedRuleV2> }>;
export type ComposeScannerResultV2Input = Readonly<{
  engine: ScannerResultV2['engine']; input: ScannerResultV2['input']; profile: ScannerResultV2['profile'];
  ruleset: ResultRuleset; semantics: ScannerResultV2['semantics']; target: ScannerResultV2['target'];
  limits: ResultLimits; analysis: Readonly<{ status?: ScannerResultV2['analysis']['status']; capabilities?: readonly CapabilityExecutionV2[]; executions?: readonly CapabilityExecutionV2[]; diagnostics?: readonly AnalysisDiagnosticV2[]; candidates?: readonly CapabilityCandidateV2[] }>;
  workflow: ScannerResultV2['workflow']; facts?: readonly SafeFactV2[]; traces?: readonly TraceV2[];
  findings?: readonly (FindingV2 | CandidateFinding)[]; candidates?: readonly CapabilityCandidateV2[];
  assessment: ResultAssessment; stats?: Partial<ResultStats>;
}>;
export type ComposeScannerResultV2Result =
  | Readonly<{ ok: true; result: ScannerResultV2 }>
  | Readonly<{ ok: false; code: 'RESULT_COMPOSITION_FAILED'; errors: readonly string[] }>;

const CAPABILITY_ORDER = ['source-normalization', 'workflow-insights', 'structural-policies', 'expression-security', 'javascript-security', 'python-security', 'graph-semantics', 'taint-confidentiality', 'taint-integrity', 'agentic-control', 'assessment', 'presentation-facts'];
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_FAILURE_ERRORS = 16;
const MAX_FAILURE_ERROR_LENGTH = 256;
const FALLBACK_FAILURE_ERROR = 'invalid scanner result v2 composition';

function failure(errors: readonly unknown[]): ComposeScannerResultV2Result {
  const safeErrors: string[] = [];
  try {
    const length = Math.min(errors.length, MAX_FAILURE_ERRORS);
    for (let index = 0; index < length; index += 1) {
      const error = errors[index];
      if (typeof error !== 'string' || error.length === 0) continue;
      safeErrors.push(error.length > MAX_FAILURE_ERROR_LENGTH ? error.slice(0, MAX_FAILURE_ERROR_LENGTH) : error);
    }
  } catch {
    safeErrors.length = 0;
  }
  if (safeErrors.length === 0) safeErrors.push(FALLBACK_FAILURE_ERROR);
  return Object.freeze({ ok: false as const, code: 'RESULT_COMPOSITION_FAILED' as const, errors: Object.freeze(safeErrors) });
}

export function composeScannerResultV2(input: ComposeScannerResultV2Input): ComposeScannerResultV2Result {
  try {
    const value = exactRecord(input, ['engine', 'input', 'profile', 'ruleset', 'semantics', 'target', 'limits', 'analysis', 'workflow', 'facts', 'traces', 'findings', 'candidates', 'assessment', 'stats']);
    if (!Object.prototype.hasOwnProperty.call(value, 'assessment')) throw new TypeError('Assessment is required');
    const context: IdentityContextV2 = { semanticSha256: readDigest(value.input, 'semanticSha256') };
    const target = closedTarget(value.target);
    const candidates: CapabilityCandidateV2[] = [...readArray(value.candidates), ...readArray(readRecord(value.analysis, ['status', 'capabilities', 'executions', 'diagnostics', 'candidates']).candidates)].map((candidate) => { const item = readRecord(candidate, ['findings', 'diagnostics', 'facts', 'traces', 'seen', 'analyzed', 'skipped', 'omitted']); return { ...item, facts: admitCandidateCompositionFactsV1(readArray(item.facts), context) } as unknown as CapabilityCandidateV2; });
    const facts = evidenceFacts(readArray(value.facts), context, candidates.flatMap((candidate) => candidate.facts));
    if (!facts.some((fact) => fact.kind.startsWith('advisory.'))) facts.push(...rekeyFacts(buildAdvisoryFactsV1({ target }), context.semanticSha256));
    facts.sort((a, b) => compareStrings(a.factId, b.factId));
    const traces = evidenceTraces([...readArray(value.traces), ...candidates.flatMap((candidate) => readArray(readRecord(candidate, ['findings', 'diagnostics', 'facts', 'traces', 'seen', 'analyzed', 'skipped', 'omitted']).traces))], context);
    const findings = evidenceFindings([...readArray(value.findings), ...candidates.flatMap((candidate) => readArray(readRecord(candidate, ['findings', 'diagnostics', 'facts', 'traces', 'seen', 'analyzed', 'skipped', 'omitted']).findings))], context, admittedFindingRulesV2(readRecord(value.ruleset, ['id', 'version', 'digest', 'signatureStatus', 'rules']).rules));
    const limits = closedLimits(value.limits);
    const stats = value.stats === undefined ? undefined : exactRecord(value.stats, ['rejectedCandidates', 'collapsedCandidates', 'omittedFindings', 'serializedBytes']);
    const analysis = composeAnalysis(value.analysis, candidates, limits, stats);
    const result: Record<string, unknown> = redactLabelRefs({
      schemaVersion: 'scanner-result-v2', engine: value.engine, input: value.input, profile: value.profile,
      ruleset: closedRuleset(value.ruleset), semantics: value.semantics, target, limits,
      analysis, workflow: value.workflow, facts, traces, findings, assessment: analysis.status === 'INDETERMINATE' ? null : normalizeAssessment(value.assessment, findings),
      stats: { rejectedCandidates: count(stats, 'rejectedCandidates'), collapsedCandidates: count(stats, 'collapsedCandidates'), omittedFindings: count(stats, 'omittedFindings'), serializedBytes: 0 },
    }) as Record<string, unknown>;
    (result.stats as Record<string, number>).serializedBytes = canonicalBytesV1(result).byteLength;
    const validation = validateScannerResultV2(result);
    if (validation.ok) return Object.freeze({ ok: true as const, result: validation.result });
    // D-6: a display label the contract refuses (`Exception`, `Error: boom`) is sanitized at the
    // label seam and the result re-validated, so a node name cannot cost the workflow its verdict.
    // Credential names are removed and credential values redacted; prose and shape-only matches are
    // escaped as before. The contract still decides — a label that is not a name, or a sanitized
    // label that did not clear the refusal, fails exactly as it did before.
    const republished = sanitizeDisplayLabels(result);
    if (republished !== undefined) {
      (republished.stats as Record<string, number>).serializedBytes = canonicalBytesV1(republished).byteLength;
      const retry = validateScannerResultV2(republished);
      if (retry.ok) return Object.freeze({ ok: true as const, result: retry.result });
    }
    return failure(validation.errors);
  } catch { return failure(['invalid scanner result v2 composition']); }
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** D-6: one record's published `name` sanitized, or the same record when nothing matched. */
function sanitizeName(value: unknown): unknown {
  if (!isRecordObject(value) || typeof value.name !== 'string') return value;
  const name = sanitizeDisplayLabel(value.name);
  return name === value.name ? value : { ...value, name };
}

/** The node labels a subject publishes: its own node, or the two ends of its edge. */
function sanitizeSubjectLabels(value: unknown): unknown {
  if (!isRecordObject(value)) return value;
  if (value.kind === 'NODE') {
    const node = sanitizeName(value.node);
    return node === value.node ? value : { ...value, node };
  }
  if (value.kind !== 'EDGE' || !isRecordObject(value.edge)) return value;
  const edge = value.edge;
  const sourceNode = sanitizeName(edge.sourceNode);
  const targetNode = sanitizeName(edge.targetNode);
  if (sourceNode === edge.sourceNode && targetNode === edge.targetNode) return value;
  return { ...value, edge: { ...edge, ...(sourceNode === edge.sourceNode ? {} : { sourceNode }), ...(targetNode === edge.targetNode ? {} : { targetNode }) } };
}

function sanitizeStepLabels(value: unknown): unknown {
  if (!isRecordObject(value)) return value;
  const subject = sanitizeSubjectLabels(value.subject);
  return subject === value.subject ? value : { ...value, subject };
}

function sanitizeTraceSteps(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const steps = value.map(sanitizeStepLabels);
  return steps.some((step, index) => step !== value[index]) ? steps : value;
}

/** A new evidence array with every published label sanitized, or `undefined` when nothing changed. */
function sanitizeEvidenceLabels(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  let changed = false;
  const output = value.map((entry) => {
    if (!isRecordObject(entry)) return entry;
    const subject = sanitizeSubjectLabels(entry.subject);
    const steps = sanitizeTraceSteps(entry.steps);
    if (subject === entry.subject && steps === entry.steps) return entry;
    changed = true;
    return { ...entry, ...(subject === entry.subject ? {} : { subject }), ...(steps === entry.steps ? {} : { steps }) };
  });
  return changed ? output : undefined;
}

/** D-6: the composed result with every published label sanitized, or `undefined` when none needed it. */
function sanitizeDisplayLabels(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const workflow = sanitizeName(result.workflow);
  const facts = sanitizeEvidenceLabels(result.facts);
  const traces = sanitizeEvidenceLabels(result.traces);
  const findings = sanitizeEvidenceLabels(result.findings);
  if (workflow === result.workflow && facts === undefined && traces === undefined && findings === undefined) return undefined;
  return { ...result, ...(workflow === result.workflow ? {} : { workflow }), ...(facts === undefined ? {} : { facts }), ...(traces === undefined ? {} : { traces }), ...(findings === undefined ? {} : { findings }) };
}

function evidenceFacts(values: readonly unknown[], context: IdentityContextV2, candidateFacts: readonly SafeFactV2[]): SafeFactV2[] {
  const byId = new Map<string, SafeFactV2>();
  for (const fact of admitCompositionFactsV1(values, context)) mergeEvidence(byId, fact.factId, fact);
  for (const fact of candidateFacts) mergeEvidence(byId, fact.factId, fact);
  return [...byId.values()].sort((a, b) => compareStrings(a.factId, b.factId));
}

function evidenceTraces(values: readonly unknown[], context: IdentityContextV2): TraceV2[] {
  const byId = new Map<string, TraceV2>();
  for (const raw of values) { const item = exactRecord(raw, ['traceId', 'kind', 'steps']); const trace = normalizeTrace(item as unknown as TraceV2, context); if (item.traceId !== trace.traceId) throw new TypeError('Trace identity mismatch'); mergeEvidence(byId, trace.traceId, trace); }
  return [...byId.values()].sort((a, b) => compareStrings(a.traceId, b.traceId));
}

function evidenceFindings(values: readonly unknown[], context: IdentityContextV2, rules: ReadonlyMap<string, AdmittedRuleV2>): FindingV2[] {
  const byId = new Map<string, FindingV2>();
  for (const raw of values) { const finding = normalizeFinding(raw, context, rules); mergeEvidence(byId, finding.findingId, finding); }
  return [...byId.values()].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || compareStrings(a.ruleId, b.ruleId) || compareStrings(canonicalSubjectIdentity(a.subject, context), canonicalSubjectIdentity(b.subject, context)) || compareStrings(a.findingId, b.findingId));
}

function normalizeTrace(value: TraceV2, context: IdentityContextV2): TraceV2 {
  const record = exactRecord(value, ['traceId', 'kind', 'steps']); const steps = readArray(record.steps).map((raw) => { const step = exactRecord(raw, ['ordinal', 'kind', 'subject', 'factRefs']); return { ordinal: step.ordinal, kind: step.kind, subject: step.subject, factRefs: references(step.factRefs) }; });
  const trace = { traceId: createTraceId({ kind: record.kind as TraceV2['kind'], steps }, context), kind: record.kind as TraceV2['kind'], steps };
  return trace;
}

function normalizeFinding(raw: unknown, context: IdentityContextV2, rules: ReadonlyMap<string, AdmittedRuleV2>): FindingV2 {
  const item = exactRecord(raw, ['findingId', 'ruleId', 'ruleRevision', 'effect', 'severity', 'confidence', 'evidenceClass', 'conclusion', 'applicability', 'subject', 'factRefs', 'traceRefs', 'remediationId']);
  const rule = findingRuleV2(rules, item.ruleId);
  if (!ruleAuthorityMatchesV2(rule, item as RuleAuthorityClaimV2)) throw new TypeError('Finding authority mismatch');
  if (item.factRefs === undefined || item.traceRefs === undefined) throw new TypeError('Missing finding references');
  const factRefs = references(item.factRefs); const traceRefs = references(item.traceRefs);
  const body: Omit<FindingV2, 'findingId'> = { ruleId: rule.ruleId, ruleRevision: rule.revision, effect: rule.effect, severity: rule.severity, confidence: rule.confidence, evidenceClass: item.evidenceClass, conclusion: item.conclusion, applicability: item.applicability, subject: item.subject, factRefs, traceRefs, remediationId: rule.remediationId };
  const findingId = createFindingId(body, context);
  if (item.findingId !== undefined && item.findingId !== findingId) throw new TypeError('Finding identity mismatch');
  return { ...body, findingId };
}

function composeAnalysis(raw: unknown, candidates: readonly CapabilityCandidateV2[], limits: ResultLimits, stats: Record<string, unknown> | undefined): ScannerResultV2['analysis'] {
  const input = exactRecord(raw, ['status', 'capabilities', 'executions', 'diagnostics', 'candidates']);
  const capabilities = readCapabilities(input.capabilities ?? input.executions);
  const diagnostics = [...readArray(input.diagnostics), ...candidates.flatMap((candidate) => readArray(readRecord(candidate, ['findings', 'diagnostics', 'facts', 'traces', 'seen', 'analyzed', 'skipped', 'omitted']).diagnostics))] as AnalysisDiagnosticV2[];
  const orderedDiagnostics = [...sortDiagnostics(diagnostics, CAPABILITY_ORDER)];
  const diagnosticOrder = new Map(orderedDiagnostics.map((item, index) => [item.id, index]));
  const normalizedCapabilities = capabilities.map((item) => ({ ...item, diagnosticIds: [...item.diagnosticIds].sort((left, right) => (diagnosticOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (diagnosticOrder.get(right) ?? Number.MAX_SAFE_INTEGER) || compareStrings(left, right)) }));
  const status = strongestAnalysisStatus(input.status, derivedStatus(normalizedCapabilities, orderedDiagnostics, limits, stats));
  return { status, capabilities: normalizedCapabilities, diagnostics: orderedDiagnostics };
}

function readCapabilities(value: unknown): CapabilityExecutionV2[] {
  const capabilities = readArray(value).map((raw) => {
    const item = exactRecord(raw, ['id', 'version', 'required', 'status', 'seen', 'analyzed', 'skipped', 'omitted', 'diagnosticIds']);
    const counts: CapabilityCountsV2 = { seen: item.seen, analyzed: item.analyzed, skipped: item.skipped, omitted: item.omitted };
    return { id: item.id, version: item.version, required: item.required, ...counts, status: corroboratedCapabilityStatus(item.status, counts), diagnosticIds: references(item.diagnosticIds, false) } as CapabilityExecutionV2;
  });
  return capabilities.sort((a, b) => CAPABILITY_ORDER.indexOf(a.id) - CAPABILITY_ORDER.indexOf(b.id));
}

function normalizeAssessment(value: unknown, findings: readonly FindingV2[]): ResultAssessment {
  if (value === null) return null; const item = exactRecord(value, ['score', 'grade', 'scoringPolicyVersion', 'basisFindingIds', 'excludedReportOnlyFindingIds', 'excludedUncertainFindingIds', 'excludedNotApplicableFindingIds', 'unknownEvidenceCount']); const order = new Map(findings.map((finding, index) => [finding.findingId, index])); const ids = (key: string) => references(item[key]).sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER)); return { score: item.score, grade: item.grade, scoringPolicyVersion: item.scoringPolicyVersion, basisFindingIds: ids('basisFindingIds'), excludedReportOnlyFindingIds: ids('excludedReportOnlyFindingIds'), excludedUncertainFindingIds: ids('excludedUncertainFindingIds'), excludedNotApplicableFindingIds: ids('excludedNotApplicableFindingIds'), unknownEvidenceCount: item.unknownEvidenceCount } as ResultAssessment;
}

function derivedStatus(caps: readonly CapabilityExecutionV2[], diagnostics: readonly AnalysisDiagnosticV2[], limits: ResultLimits, stats: Record<string, unknown> | undefined): ScannerResultV2['analysis']['status'] { let status: ScannerResultV2['analysis']['status'] = 'COMPLETE'; for (const item of caps) { const effect = countLatticeEffect(item, item.required); if (item.required && (item.status === 'FAILED' || item.status === 'SKIPPED')) status = 'INDETERMINATE'; else if (effect === 'INDETERMINATE') status = 'INDETERMINATE'; else if (status === 'COMPLETE' && (item.status !== 'COMPLETED' || effect === 'DEGRADED')) status = 'DEGRADED'; } for (const item of diagnostics) { if (item.aggregateEffect === 'INDETERMINATE') status = 'INDETERMINATE'; else if (status === 'COMPLETE' && (item.aggregateEffect === 'DEGRADED' || item.omitted !== undefined && item.omitted > 0)) status = 'DEGRADED'; } if (limits.usage.some((usage) => usage.omitted > 0) || (typeof stats?.omittedFindings === 'number' && stats.omittedFindings > 0)) if (status === 'COMPLETE') status = 'DEGRADED'; return status; }

function closedRuleset(value: ResultRuleset): ScannerResultV2['ruleset'] { const item = exactRecord(value, ['id', 'version', 'digest', 'signatureStatus', 'rules']); return { id: item.id, version: item.version, digest: item.digest, signatureStatus: item.signatureStatus }; }
function closedTarget(value: ScannerResultV2['target']): ScannerResultV2['target'] {
  const item = exactRecord(value, ['schemaVersion', 'n8nVersion', 'edition', 'deployment', 'role', 'taskRunner', 'communityPackages', 'configuration', 'contextDigest']);
  const packages = readArray(item.communityPackages).map((raw) => { const packageValue = exactRecord(raw, ['name', 'version']); return packageValue.version === undefined ? { name: packageValue.name } : { name: packageValue.name, version: packageValue.version }; }).sort((a, b) => compareStrings(a.name, b.name) || compareStrings(a.version ?? '', b.version ?? ''));
  const configuration = readArray(item.configuration).map((raw) => exactRecord(raw, ['key', 'state']) as ScannerResultV2['target']['configuration'][number]).sort((a, b) => compareStrings(a.key, b.key));
  return { schemaVersion: item.schemaVersion, ...(item.n8nVersion === undefined ? {} : { n8nVersion: item.n8nVersion }), edition: item.edition, deployment: item.deployment, role: item.role, taskRunner: item.taskRunner, communityPackages: packages, configuration, contextDigest: item.contextDigest } as ScannerResultV2['target'];
}
function closedLimits(value: ResultLimits): ResultLimits { const item = exactRecord(value, ['schemaVersion', 'digest', 'usage']); const usage = readArray(item.usage).map((raw) => exactRecord(raw, ['id', 'maximum', 'examined', 'omitted', 'exhausted']) as ResultLimits['usage'][number]).sort((a, b) => compareStrings(a.id, b.id)); return { schemaVersion: item.schemaVersion, digest: item.digest, usage }; }
function references(value: unknown, sort = true): string[] { const result = readArray(value); if (result.some((item) => typeof item !== 'string' || !DIGEST.test(item))) throw new TypeError('Invalid references'); if (sort) result.sort((a, b) => compareStrings(a as string, b as string)); for (let index = 1; index < result.length; index += 1) if (result[index] === result[index - 1]) throw new TypeError('Duplicate references'); return result as string[]; }
function readArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError('Expected dense array');
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0) throw new TypeError('Unsafe array');
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== length.value + 1 || names.some((name) => name !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= length.value)) throw new TypeError('Unsafe array');
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor || !('value' in descriptor)) throw new TypeError('Sparse array'); result.push(descriptor.value); }
  return result;
}
function compareStrings(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}
function exactRecord(value: unknown, allowed: readonly string[]): Record<string, any> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected record'); const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) throw new TypeError('Unsafe record'); const output: Record<string, any> = {}; for (const key of Object.getOwnPropertyNames(value)) { if (!allowed.includes(key)) throw new TypeError('Unknown property'); const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Accessor property'); output[key] = descriptor.value; } return output; }
function readRecord(value: unknown, allowed: readonly string[]): Record<string, any> { return exactRecord(value, allowed); }
function readDigest(value: unknown, key: string): string { const item = exactRecord(value, ['rawSha256', 'semanticSha256', 'ambiguitySha256', 'ambiguityCount', 'utf8Bytes']); const digest = item[key]; if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new TypeError('Invalid digest'); return digest; }
function count(value: Record<string, any> | undefined, key: keyof ResultStats): number { const count = value?.[key] ?? 0; if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Invalid result count'); return count; }
function severityRank(value: FindingV2['severity']): number { return ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].indexOf(value); }
function text(value: Uint8Array): string { return new TextDecoder().decode(value); }
function mergeEvidence<T>(map: Map<string, T>, id: string, item: T): void { const prior = map.get(id); if (prior === undefined) { map.set(id, item); return; } const priorBytes = text(canonicalBytesV1(prior)); const itemBytes = text(canonicalBytesV1(item)); if (compareStrings(itemBytes, priorBytes) < 0) map.set(id, item); }
