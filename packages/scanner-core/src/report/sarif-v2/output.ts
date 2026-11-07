/**
 * Sole v2 SARIF document authority: this module assembles the log and `helpers.ts` declares
 * its bounds/severity tables. It adapts core's authorities — `report/sarif-tags`,
 * `diagnostics/registry` and `compat/v1-registry` — rather than restating them, and no second
 * document builder may exist (core's unwired `report/sarif-v2.ts` was deleted as that duplicate).
 */
import type { FindingV2, SafeFactV2, TraceV2 } from '@hub/contracts/scanner-v2-evidence';
import type { ScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import { V1_EVIDENCE_PROJECTIONS, V1_RULE_REGISTRY, V1_RULE_TEMPLATES } from '../../compat/v1-registry';
import { DIAGNOSTIC_CODES_V2 } from '../../diagnostics/registry';
import { sarifHelpUriFor, sarifTagsFor } from '../sarif-tags';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import {
  ALLOWED_ERRORS, checkResult, extractItems, FALLBACK, freeze, inputIdentity, inv, LEVELS, physical, prop, readSpan, safeUri,
  sameId, SEV_ORDER, subjectKey, subjectSpan, type BatchId, type Bounds, type NotifItem,
} from './helpers';

export type SarifLog = Readonly<{ version: '2.1.0'; $schema: string; runs: readonly SarifRun[] }>;
export type SarifRun = Readonly<{ tool: { driver: Record<string, unknown> }; results: readonly Record<string, unknown>[]; invocations: readonly Record<string, unknown>[]; taxonomies?: readonly Record<string, unknown>[]; properties?: Readonly<Record<string, unknown>> }>;
export type SarifCoverageOmissionsV2 = Readonly<{
  capabilityOmitted: number; limitOmitted: number; findingOmitted: number; omittedTotal: number;
  coverageAnalyzed: number; coverageSeen: number;
}>;
export type SarifV2Limits = Readonly<{ maxRules?: number; maxResults?: number; maxNotifications?: number; maxTaxonomies?: number; maxTaxa?: number; maxTags?: number; maxFlows?: number; maxTraceSteps?: number }>;
export type BatchSarifEnvelopeV2 = Readonly<{ items?: readonly unknown[]; results?: readonly unknown[]; input?: Readonly<{ label: string; uri?: string }>; result?: ScannerResultV2; repositoryRoot?: string; selectionRoot?: string; limits?: SarifV2Limits }>;
export type BatchSarifInputV2 = BatchSarifEnvelopeV2 | readonly unknown[];

type CollectedFinding = { finding: FindingV2; uri?: string; traces: Map<string, TraceV2>; stepsLimit?: number };
const diagCodes = new Set<string>(DIAGNOSTIC_CODES_V2);
const templates = new Map(V1_RULE_TEMPLATES.map((item) => [item.ruleId, item]));
const registry = new Map(V1_RULE_REGISTRY.map((item) => [item.ruleId, item]));
const configurationRules = new Set(['RAW_AUTH_HEADER', 'RAW_SECRET_INDICATOR', 'UNAPPROVED_DOMAIN', 'UNKNOWN_NODE_PACKAGE', 'WEBHOOK_EXPOSURE']);

function evidenceClass(ruleId: string): FindingV2['evidenceClass'] {
  if (ruleId.startsWith('TAINTED_')) return 'POTENTIAL_DATAFLOW';
  if (ruleId === 'JAVASCRIPT_DYNAMIC_EXECUTION' || ruleId === 'PYTHON_DYNAMIC_EXECUTION') return 'SUSPICIOUS_SYNTAX';
  if (configurationRules.has(ruleId)) return 'CONFIGURATION';
  return 'CAPABILITY';
}
function checkFindingAuthority(finding: FindingV2, facts: ReadonlyMap<string, SafeFactV2>): void {
  const rule = registry.get(finding.ruleId); const template = templates.get(finding.ruleId);
  const projection = V1_EVIDENCE_PROJECTIONS.find((item) => item.ruleId === finding.ruleId);
  if (!rule || !template || !projection) throw new TypeError('Invalid SARIF input');
  if (projection.evidenceSchemaId !== rule.evidenceSchemaId
    || finding.ruleRevision !== rule.revision || finding.effect !== rule.effect || finding.severity !== rule.severity
    || finding.confidence !== rule.confidence || finding.remediationId !== rule.remediationId || finding.evidenceClass !== evidenceClass(finding.ruleId)) inv();
  if (!finding.factRefs.length) return;
  const referenced = finding.factRefs.map((ref) => facts.get(ref));
  if (referenced.some((fact) => !fact || !projection.properties.some((item) => item.factKind === fact.kind))) inv();
  for (const property of projection.properties) {
    const matches = referenced.filter((fact) => fact?.kind === property.factKind && Object.prototype.hasOwnProperty.call(fact.properties, property.factProperty));
    if (matches.length > 1 || property.required && matches.length !== 1) inv();
  }
}
const getLimit = (explicit: number | undefined, aggregate: number, fallback: number, seen: boolean): number => {
  const base = seen ? aggregate : fallback;
  return explicit === undefined ? base : Math.min(explicit, base);
};
/** The single omission formula behind both the table and SARIF projections. Capability omissions are already inside `stats.omittedFindings`, so only limits and findings add up. */
export function coverageOmissionsV2(result: ScannerResultV2): SarifCoverageOmissionsV2 {
  let capabilityOmitted = 0; let coverageAnalyzed = 0; let coverageSeen = 0;
  for (const capability of result.analysis.capabilities) {
    capabilityOmitted += capability.omitted; coverageAnalyzed += capability.analyzed; coverageSeen += capability.seen;
  }
  let limitOmitted = 0; for (const usage of result.limits.usage) limitOmitted += usage.omitted;
  const findingOmitted = result.stats.omittedFindings;
  return Object.freeze({
    capabilityOmitted, limitOmitted, findingOmitted, omittedTotal: limitOmitted + findingOmitted, coverageAnalyzed, coverageSeen,
  });
}
const ANALYSIS_STATUS_ORDER: Readonly<Record<string, number>> = { COMPLETE: 0, DEGRADED: 1, INDETERMINATE: 2 };
const CAPABILITY_STATUS_ORDER: Readonly<Record<string, number>> = { COMPLETED: 0, DEGRADED: 1, SKIPPED: 2, FAILED: 3 };

export function buildBatchSarifV2(input: BatchSarifInputV2): SarifLog {
  const { items, repoRoot, selRoot, limits: inputLimits } = extractItems(input);
  const rawNotifs: NotifItem[] = []; const collected: CollectedFinding[] = []; const unknownRules = new Set<string>();
  let spanLoss = false; let invocationFailed = false; let identity: BatchId | undefined; let limitExceeded = false;
  let findingsBudget = 0; let findingsBudgetSeen = false; let diagnosticsBudget = 0; let diagnosticsBudgetSeen = false;
  let taxaBudget = 0; let taxaBudgetSeen = false; let flowBudget = 0; let flowBudgetSeen = false;
  const counts = { findings: 0, capabilityOmitted: 0, limitOmitted: 0, findingOmitted: 0, omittedTotal: 0, coverageAnalyzed: 0, coverageSeen: 0 };
  let analysisStatus: ScannerResultV2['analysis']['status'] | undefined;
  const capabilityOmissions = new Map<string, { status: string; omitted: number }>();
  const limitOmissions = new Map<string, { examined: number; maximum: number; omitted: number; exhausted: boolean }>();
  for (const item of items) {
    const inputIdentityValue = inputIdentity(item); const label = inputIdentityValue.label; const uri = safeUri(inputIdentityValue.rawUri, repoRoot, selRoot);
    const rawResult = prop(item, 'result'); const resultCandidate = rawResult && typeof rawResult === 'object' && prop(rawResult, 'result') ? prop(rawResult, 'result') : rawResult;
    const completed = prop(item, 'status') === 'COMPLETED' || prop(item, 'ok') === true || (resultCandidate && prop(item, 'status') === undefined && prop(item, 'ok') === undefined);
    if (completed && resultCandidate) {
      const result = checkResult(resultCandidate); const current: BatchId = {
        engineId: result.engine.id, engineVersion: result.engine.version, engineBuildDigest: result.engine.buildDigest,
        profileId: result.profile.id, profileVersion: result.profile.version, rulesetId: result.ruleset.id, rulesetVersion: result.ruleset.version,
        rulesetDigest: result.ruleset.digest, rulesetSig: result.ruleset.signatureStatus, semanticsId: result.semantics.id, semanticsVersion: result.semantics.version,
        semanticsDigest: result.semantics.digest, targetContextDigest: result.target.contextDigest, targetEdition: result.target.edition,
        targetDeployment: result.target.deployment, targetRole: result.target.role, targetTaskRunner: result.target.taskRunner,
        limitsSchemaVersion: result.limits.schemaVersion, limitsDigest: result.limits.digest,
      };
      if (!identity) identity = current; else if (!sameId(identity, current)) inv();
      const facts = new Map<string, SafeFactV2>(result.facts.map((fact) => [fact.factId, fact])); const traces = new Map<string, TraceV2>(result.traces.map((trace) => [trace.traceId, trace])); let stepsLimit: number | undefined;
      const omissions = coverageOmissionsV2(result);
      counts.findings += result.findings.length; counts.capabilityOmitted += omissions.capabilityOmitted; counts.limitOmitted += omissions.limitOmitted;
      counts.findingOmitted += omissions.findingOmitted; counts.omittedTotal += omissions.omittedTotal; counts.coverageAnalyzed += omissions.coverageAnalyzed; counts.coverageSeen += omissions.coverageSeen;
      analysisStatus = analysisStatus === undefined || ANALYSIS_STATUS_ORDER[result.analysis.status]! > ANALYSIS_STATUS_ORDER[analysisStatus]! ? result.analysis.status : analysisStatus;
      for (const capability of result.analysis.capabilities) if (capability.omitted > 0) {
        const current = capabilityOmissions.get(capability.id);
        const status = current === undefined || CAPABILITY_STATUS_ORDER[capability.status]! > CAPABILITY_STATUS_ORDER[current.status]! ? capability.status : current.status;
        capabilityOmissions.set(capability.id, { status, omitted: (current?.omitted ?? 0) + capability.omitted });
      }
      for (const usage of result.limits.usage) if (usage.omitted > 0) {
        const current = limitOmissions.get(usage.id);
        limitOmissions.set(usage.id, {
          examined: (current?.examined ?? 0) + usage.examined, maximum: (current?.maximum ?? 0) + usage.maximum,
          omitted: (current?.omitted ?? 0) + usage.omitted, exhausted: current?.exhausted === true || usage.exhausted,
        });
      }
      for (const usage of result.limits.usage) {
        if (usage.omitted > 0) limitExceeded = true;
        if (usage.id === 'maxFindings') { findingsBudget += usage.maximum; findingsBudgetSeen = true; }
        if (usage.id === 'maxDiagnostics') { diagnosticsBudget += usage.maximum; diagnosticsBudgetSeen = true; }
        if (usage.id === 'maxTaxa') { taxaBudget += usage.maximum; taxaBudgetSeen = true; }
        if (usage.id === 'maxFlows') { flowBudget += usage.maximum; flowBudgetSeen = true; }
        if (usage.id === 'maxTraceStepsPerFinding') stepsLimit = usage.maximum;
      }
      for (const finding of result.findings) {
        if (registry.has(finding.ruleId)) checkFindingAuthority(finding, facts); else unknownRules.add(finding.effect === 'SCORING' ? 'UNKNOWN_SCORING_RULE' : 'UNKNOWN_REPORT_ONLY_RULE');
        collected.push({ finding, uri, traces, stepsLimit });
      }
      for (const diagnostic of result.analysis.diagnostics) {
        if (!diagCodes.has(diagnostic.code)) continue;
        const locationSpan = readSpan(diagnostic.location); const location = uri && locationSpan ? physical(uri, locationSpan) : undefined;
        const key = location ? `${uri}:${locationSpan!.start.line}:${locationSpan!.start.column}:${locationSpan!.end.line}:${locationSpan!.end.column}` : '';
        rawNotifs.push({ code: diagnostic.code, level: diagnostic.aggregateEffect === 'INDETERMINATE' ? 'error' : 'warning', location, locKey: key, id: diagnostic.id, label });
      }
    } else {
      invocationFailed = true;
      const rawCode = prop(prop(item, 'error'), 'code') ?? (prop(item, 'status') === 'TIMEOUT' ? 'SCAN_TIMEOUT' : prop(item, 'status') === 'CANCELLED' ? 'SCAN_CANCELLED' : 'TOOL_INVARIANT_FAILED');
      const code = typeof rawCode === 'string' && ALLOWED_ERRORS.has(rawCode) ? rawCode : 'TOOL_INVARIANT_FAILED';
      rawNotifs.push({ code, level: code === 'SCAN_TIMEOUT' || code === 'SCAN_CANCELLED' ? 'warning' : 'error', location: uri ? { physicalLocation: { artifactLocation: { uri } } } : undefined, locKey: uri ?? '', label });
    }
  }
  for (const code of unknownRules) rawNotifs.push({ code, level: code === 'UNKNOWN_SCORING_RULE' ? 'error' : 'warning', locKey: '' });
  const bounds: Bounds = {
    rules: getLimit(inputLimits?.maxRules, 0, FALLBACK.rules, false), results: getLimit(inputLimits?.maxResults, findingsBudget, FALLBACK.results, findingsBudgetSeen),
    notifications: getLimit(inputLimits?.maxNotifications, diagnosticsBudget, FALLBACK.notifications, diagnosticsBudgetSeen), taxonomies: getLimit(inputLimits?.maxTaxonomies, 0, FALLBACK.taxonomies, false),
    taxa: getLimit(inputLimits?.maxTaxa, taxaBudget, FALLBACK.taxa, taxaBudgetSeen), tags: getLimit(inputLimits?.maxTags, 0, FALLBACK.tags, false),
    flows: getLimit(inputLimits?.maxFlows, flowBudget, FALLBACK.flows, flowBudgetSeen), steps: inputLimits?.maxTraceSteps ?? FALLBACK.steps,
  };
  const sorted = [...collected].sort((a, b) => (SEV_ORDER[a.finding.severity] ?? 9) - (SEV_ORDER[b.finding.severity] ?? 9) || compareCanonicalStrings(a.finding.ruleId, b.finding.ruleId) || compareCanonicalStrings(subjectKey(a.finding.subject), subjectKey(b.finding.subject)) || compareCanonicalStrings(a.finding.findingId, b.finding.findingId) || compareCanonicalStrings(a.uri ?? '', b.uri ?? ''));
  const admitted = sorted.filter((item) => registry.has(item.finding.ruleId)); const selected = admitted.slice(0, bounds.results); if (selected.length < admitted.length) limitExceeded = true;
  const ruleIdsAll = [...new Set(selected.map((item) => item.finding.ruleId))].sort(compareCanonicalStrings); if (ruleIdsAll.length > bounds.rules) limitExceeded = true;
  const ruleIds = ruleIdsAll.slice(0, bounds.rules); const admittedRules = new Set(ruleIds); const active = selected.filter((item) => admittedRules.has(item.finding.ruleId)); if (active.length < selected.length) limitExceeded = true;

  const tagsByRule = new Map<string, readonly string[]>(); const admittedTags = new Set<string>();
  const rules = ruleIds.map((id) => { const template = templates.get(id)!; const allTags = [...new Set(sarifTagsFor(id) ?? [])].filter((tag) => /^external\/cwe\/cwe-\d{3}$/.test(tag) || /^owasp-agentic\/[a-z0-9-]+$/.test(tag)).sort(compareCanonicalStrings); if (allTags.length > bounds.tags) limitExceeded = true; const tags = allTags.slice(0, bounds.tags); tags.forEach((tag) => admittedTags.add(tag)); tagsByRule.set(id, tags); return { id, helpUri: sarifHelpUriFor(id), shortDescription: { text: template.title }, fullDescription: { text: template.explanation }, help: { text: template.remediation }, ...(tags.length ? { properties: { tags } } : {}) }; });
  const taxonomies: Record<string, unknown>[] = []; const taxRefs = new Set<string>(); const cwe = [...admittedTags].filter((tag) => tag.startsWith('external/cwe/')).sort(compareCanonicalStrings); const owasp = [...admittedTags].filter((tag) => tag.startsWith('owasp-agentic/')).sort(compareCanonicalStrings);
  const cweTags = cwe.slice(0, bounds.taxa); const owaspTags = owasp.slice(0, Math.max(0, bounds.taxa - cweTags.length)); if (cweTags.length < cwe.length || owaspTags.length < owasp.length) limitExceeded = true;
  if (cweTags.length && taxonomies.length < bounds.taxonomies) { taxonomies.push({ name: 'CWE', taxa: cweTags.map((id) => ({ id })) }); cweTags.forEach((id) => taxRefs.add(`CWE\0${id}`)); } else if (cweTags.length) limitExceeded = true;
  if (owaspTags.length && taxonomies.length < bounds.taxonomies) { taxonomies.push({ name: 'OWASP Agentic', taxa: owaspTags.map((id) => ({ id })) }); owaspTags.forEach((id) => taxRefs.add(`OWASP Agentic\0${id}`)); } else if (owaspTags.length) limitExceeded = true;
  let flowCount = 0; let taxaCount = 0;
  const results = active.map(({ finding, uri, traces, stepsLimit }) => {
    const span = subjectSpan(finding.subject); const location = uri && span ? physical(uri, span) : undefined; if (!location) spanLoss = true; const flows: Record<string, unknown>[] = [];
    for (const traceId of [...finding.traceRefs].sort(compareCanonicalStrings)) {
      const trace = traces.get(traceId); const steps = trace ? [...trace.steps].sort((a, b) => a.ordinal - b.ordinal) : []; const spans = steps.map((step) => subjectSpan(step.subject));
      const allowedSteps = Math.min(bounds.steps, stepsLimit ?? FALLBACK.steps);
      if (!trace || !steps.length || !uri || spans.some((value) => !value)) { spanLoss = true; continue; }
      if (steps.length > allowedSteps) { spanLoss = true; limitExceeded = true; continue; }
      if (flowCount >= bounds.flows) { limitExceeded = true; continue; }
      flows.push({ threadFlows: [{ locations: spans.map((value) => ({ location: physical(uri, value!) })) }] }); flowCount += 1;
    }
    const template = templates.get(finding.ruleId)!; const available = Math.max(0, bounds.taxa - taxaCount); const allTaxa = (tagsByRule.get(finding.ruleId) ?? []).filter((id) => taxRefs.has(`${id.startsWith('external/cwe/') ? 'CWE' : 'OWASP Agentic'}\0${id}`)); const taxa = allTaxa.slice(0, available).map((id) => ({ toolComponent: { name: id.startsWith('external/cwe/') ? 'CWE' : 'OWASP Agentic' }, id })); if (taxa.length < allTaxa.length) limitExceeded = true; taxaCount += taxa.length;
    return { ruleId: finding.ruleId, level: LEVELS[finding.severity], message: { text: template.message }, partialFingerprints: { secureflowFindingId: finding.findingId }, properties: { severity: finding.severity, confidence: finding.confidence, effect: finding.effect, evidenceClass: finding.evidenceClass, conclusion: finding.conclusion, applicability: finding.applicability, capabilityId: registry.get(finding.ruleId)!.capabilityId }, ...(taxa.length ? { taxa } : {}), ...(location ? { locations: [location] } : {}), ...(flows.length ? { codeFlows: flows } : {}) };
  });
  if (spanLoss) rawNotifs.push({ code: 'SOURCE_SPAN_UNAVAILABLE', level: 'warning', locKey: '' });
  if (rawNotifs.length > bounds.notifications) limitExceeded = true;
  if (limitExceeded && !rawNotifs.some((item) => item.code === 'OPTIONAL_LIMIT_EXCEEDED')) rawNotifs.push({ code: 'OPTIONAL_LIMIT_EXCEEDED', level: 'warning', locKey: '' });
  const orderedNotifs = [...rawNotifs].sort((a, b) => compareCanonicalStrings(a.code, b.code) || (a.level === 'error' && b.level !== 'error' ? -1 : b.level === 'error' && a.level !== 'error' ? 1 : 0) || compareCanonicalStrings(a.locKey, b.locKey) || compareCanonicalStrings(a.id ?? '', b.id ?? '') || compareCanonicalStrings(a.label ?? '', b.label ?? ''));
  let emittedNotifs = orderedNotifs.slice(0, bounds.notifications);
  if (limitExceeded && bounds.notifications > 0 && orderedNotifs.some((item) => item.code === 'OPTIONAL_LIMIT_EXCEEDED') && !emittedNotifs.some((item) => item.code === 'OPTIONAL_LIMIT_EXCEEDED')) emittedNotifs = [...orderedNotifs.filter((item) => item.code !== 'OPTIONAL_LIMIT_EXCEEDED').slice(0, bounds.notifications - 1), orderedNotifs.find((item) => item.code === 'OPTIONAL_LIMIT_EXCEEDED')!].sort((a, b) => compareCanonicalStrings(a.code, b.code) || (a.level === 'error' && b.level !== 'error' ? -1 : b.level === 'error' && a.level !== 'error' ? 1 : 0) || compareCanonicalStrings(a.locKey, b.locKey) || compareCanonicalStrings(a.id ?? '', b.id ?? '') || compareCanonicalStrings(a.label ?? '', b.label ?? ''));
  const notifications = emittedNotifs.map((item) => ({ descriptor: { id: item.code }, level: item.level, message: { text: `Analysis diagnostic ${item.code}.` }, ...(item.location ? { locations: [item.location] } : {}) }));
  const omissions: Record<string, unknown>[] = [
    ...[...capabilityOmissions].sort(([left], [right]) => compareCanonicalStrings(left, right)).map(([capabilityId, row]) => ({ source: 'CAPABILITY', capabilityId, status: row.status, omitted: row.omitted })),
    ...[...limitOmissions].sort(([left], [right]) => compareCanonicalStrings(left, right)).map(([id, row]) => ({ source: 'LIMIT', id, examined: row.examined, maximum: row.maximum, omitted: row.omitted, exhausted: row.exhausted })),
    ...(counts.findingOmitted > 0 ? [{ source: 'FINDINGS', omitted: counts.findingOmitted }] : []),
  ];
  const secureflow = identity !== undefined && analysisStatus !== undefined ? {
    analysisStatus,
    engine: { id: identity.engineId, version: identity.engineVersion, buildDigest: identity.engineBuildDigest },
    profile: { id: identity.profileId, version: identity.profileVersion },
    ruleset: { id: identity.rulesetId, version: identity.rulesetVersion, digest: identity.rulesetDigest, signatureStatus: identity.rulesetSig },
    semantics: { id: identity.semanticsId, version: identity.semanticsVersion, digest: identity.semanticsDigest },
    targetContextDigest: identity.targetContextDigest,
    limits: { schemaVersion: identity.limitsSchemaVersion, digest: identity.limitsDigest },
    counts: { ...counts },
    omissions,
  } : undefined;
  return freeze({ version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [{ tool: { driver: { name: identity?.engineId ?? 'secureflow-scanner', version: identity?.engineVersion ?? '2.0.0', rules } }, ...(taxonomies.length ? { taxonomies } : {}), results, invocations: [{ executionSuccessful: !invocationFailed, toolExecutionNotifications: notifications }], ...(secureflow === undefined ? {} : { properties: { secureflow } }) }] });
}
export function buildSarifV2(input: BatchSarifInputV2): SarifLog { return buildBatchSarifV2(input); }
export function serializeSarifV2(input: BatchSarifInputV2): string { return `${JSON.stringify(buildBatchSarifV2(input), null, 2)}\n`; }
