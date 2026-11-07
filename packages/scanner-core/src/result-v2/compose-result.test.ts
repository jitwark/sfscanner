import { describe, expect, it } from 'vitest';
import type { AnalysisDiagnosticV2, SafeFactV2, SafeFactValueV2 } from '../../../../contracts/scanner-v2-evidence';
import type { ScannerResultV2 } from '../../../../contracts/scanner-v2-result';
import { canonicalBytesV1 } from './canonical-bytes';
import { composeScannerResultV2, type ComposeScannerResultV2Input } from './compose-result';
import { createDiagnosticId } from '../diagnostics/identity';
import { classifyDiagnostic } from '../diagnostics/registry';
import { createFactId, createFindingId } from './identities';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { createCapabilityCandidateAdmissionSnapshotV2 } from '../admission/snapshot';
import { SAFE_FACT_EVIDENCE_MAPPINGS_V2 } from '../facts/safe-fact-registry';
import { betaHardenedRuleCatalog } from '../policy/rule-catalog';
import { parseSourceDocument } from '../source/source-parser';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import { BETA_DEFAULT_PROFILE_MANIFEST } from '../capabilities/profile-manifest';
import { scheduleCapabilities, type AnalyzerContextV2, type CapabilityCandidateV2 } from '../capabilities/scheduler';
import { RULE_PACK_DIGEST_V2 } from '../capabilities/candidate-validator';
import { createAdmittedRuleView } from '../v2/admitted-registry';
import { validateTargetContextV3 } from '../semantics/target-context';
import fieldFlowVectors from '../../../../docs/superpowers/plans/2026-10-21-scanner-deepseek/Q04-FIELD-FACT-VECTORS.json';

const digest = (letter: string): string => letter.repeat(64);
const source = { pointer: '', occurrencePath: [], astNodeId: digest('a'), span: null } as const;
const base = (): ComposeScannerResultV2Input => ({
  engine: { id: 'secureflow-scanner', version: '2.0.0', buildDigest: digest('a') },
  input: { rawSha256: digest('b'), semanticSha256: digest('c'), ambiguitySha256: digest('d'), ambiguityCount: 0, utf8Bytes: 1 },
  profile: { id: 'beta-default', version: '2.0.0' },
  ruleset: { id: 'rules', version: '2.0.0', digest: digest('e'), signatureStatus: 'VERIFIED' },
  semantics: { id: 'semantics', version: '2.0.0', digest: digest('f') },
  target: validateTargetContextV3({ schemaVersion: 'scanner-target-v3' }),
  limits: { schemaVersion: 'scanner-limits-v2', digest: digest('1'), usage: [] },
  analysis: { status: 'COMPLETE', capabilities: [], diagnostics: [] },
  workflow: { name: null, nodeCount: 0, rawNodeCount: 0, annotationNodeCount: 0, triggerCount: 0, actionCount: 0, integrationCount: 0, edgeCount: 0, resolvedEdgeCount: 0, payloadBytes: 0, complexity: 'LOW', isSubWorkflow: false },
  facts: [], traces: [], findings: [], assessment: { score: 0, grade: 'LOW', scoringPolicyVersion: 'secureflow-risk-v2@2.0.0', basisFindingIds: [], excludedReportOnlyFindingIds: [], excludedUncertainFindingIds: [], excludedNotApplicableFindingIds: [], unknownEvidenceCount: 0 },
});

function result(input: ComposeScannerResultV2Input): ScannerResultV2 {
  const composed = composeScannerResultV2(input);
  if (!composed.ok) throw new Error(composed.code);
  return composed.result;
}

function diagnostic(code: AnalysisDiagnosticV2['code'], category: AnalysisDiagnosticV2['category'], pointer: string, astNode: string, omitted?: number): AnalysisDiagnosticV2 {
  const location = { pointer, occurrencePath: [], astNodeId: digest(astNode), span: null };
  const identity = { code, category, capabilityId: 'source-normalization', aggregateEffect: 'DEGRADED' as const, assessmentEligible: true, location, ...(omitted === undefined ? {} : { omitted }) };
  return { id: createDiagnosticId(identity), ...identity };
}

function unknownRuleDiagnostic(code: 'UNKNOWN_SCORING_RULE' | 'UNKNOWN_REPORT_ONLY_RULE', capabilityId: string, required: boolean): AnalysisDiagnosticV2 {
  const classification = classifyDiagnostic(code, required);
  const identity = { code, capabilityId, ...classification };
  return { id: createDiagnosticId(identity), ...identity };
}

function admittedRule() {
  const rule = createAdmittedRuleView().rules.get('JAVASCRIPT_DYNAMIC_EXECUTION');
  if (rule === undefined) throw new Error('fixture rule authority is incomplete');
  return rule;
}

function composedFieldFacts(patches: Readonly<Record<string, Readonly<Record<string, SafeFactValueV2>>>> = {}): SafeFactV2[] {
  const records: SafeFactV2[] = JSON.parse(JSON.stringify(fieldFlowVectors.facts));
  return records.map((record) => {
    const value = { ...record, properties: { ...record.properties, ...patches[record.kind] } };
    return { ...value, factId: createFactId(value, { semanticSha256: digest('c') }) };
  });
}
function fieldCandidate(facts: readonly SafeFactV2[]): CapabilityCandidateV2 {
  return { facts, findings: [], diagnostics: [], traces: [], seen: 0, analyzed: 0, skipped: 0, omitted: 0 };
}

describe('composeScannerResultV2', () => {
  it('retains zero-flow coverage and safe unreferenced provenance during composition', () => {
    const [origin, , coverage] = composedFieldFacts({ 'dataflow.coverage.v1': { emittedFlows: 0, positiveFields: 0 } });
    const output = result({ ...base(), candidates: [fieldCandidate([origin, coverage])] });
    expect(output.facts.find((fact) => fact.kind === 'dataflow.coverage.v1')?.properties.emittedFlows).toBe(0);
    expect(output.facts.find((fact) => fact.kind === 'dataflow.provenance.v1')?.properties.sourceFieldPath).toEqual(['body', 'cmd']);
  });

  it('validates per-candidate flow totals before shared facts collapse across capabilities', () => {
    const first = composedFieldFacts();
    const second = composedFieldFacts({ 'dataflow.coverage.v1': { capabilityId: 'taint-integrity' } });
    const input = { ...base(), candidates: [fieldCandidate(first), fieldCandidate(second)] };
    const output = result(input);
    expect(output.facts.filter((fact) => fact.kind === 'dataflow.summary.v3')).toHaveLength(1);
    expect(output.facts.filter((fact) => fact.kind === 'dataflow.coverage.v1').map((fact) => fact.properties.capabilityId).sort()).toEqual(['taint-confidentiality', 'taint-integrity']);
    const incorrect = composedFieldFacts({ 'dataflow.coverage.v1': { capabilityId: 'taint-integrity', emittedFlows: 2 } });
    expect(composeScannerResultV2({ ...input, candidates: [fieldCandidate(first), fieldCandidate(incorrect)] }).ok).toBe(false);
  });

  it('refuses canonical fact IDs with unresolved or mismatched embedded provenance', () => {
    const missingOrigin = composedFieldFacts().slice(1);
    expect(composeScannerResultV2({ ...base(), candidates: [fieldCandidate(missingOrigin)] }).ok).toBe(false);
    const mismatched = composedFieldFacts({ 'dataflow.summary.v3': { sourceFieldPath: ['different'] } });
    expect(composeScannerResultV2({ ...base(), candidates: [fieldCandidate(mismatched)] }).ok).toBe(false);
  });

  it('stamps finding metadata from the admitted catalogue when the caller states none', () => {
    const first = base();
    const rule = admittedRule();
    const fact = { kind: 'workflow.summary.v1', subject: { kind: 'SOURCE' as const, source }, properties: { connectionCount: 1 } };
    const factId = createFactId(fact, { semanticSha256: first.input.semanticSha256 });
    const findingInput = { ruleId: rule.ruleId, evidenceClass: 'SUSPICIOUS_SYNTAX' as const, conclusion: 'OBSERVED' as const, applicability: 'APPLICABLE' as const, subject: fact.subject, factRefs: [factId], traceRefs: [], remediationId: rule.remediationId };
    // The candidate shape carries none of revision/effect/severity/confidence: the catalogue supplies them.
    const findingBody = { ...findingInput, ruleRevision: rule.revision, effect: rule.effect, severity: rule.severity, confidence: rule.confidence };
    const input = { ...first, facts: [{ ...fact, factId }], findings: [findingInput], assessment: { ...first.assessment!, excludedReportOnlyFindingIds: [createFindingId(findingBody, { semanticSha256: first.input.semanticSha256 })] } };
    const composed = result(input);
    expect(composed.facts.find((item) => item.kind === fact.kind)?.factId).toBe(factId);
    expect(composed.findings).toHaveLength(1);
    expect(composed.findings[0]).toMatchObject({
      ruleId: rule.ruleId, ruleRevision: rule.revision, effect: rule.effect,
      severity: rule.severity, confidence: rule.confidence, remediationId: rule.remediationId,
    });
    expect(composed.findings[0].findingId).toBe(createFindingId(composed.findings[0], { semanticSha256: first.input.semanticSha256 }));
    expect(composed.stats.serializedBytes).toBe(canonicalBytesV1({ ...composed, stats: { ...composed.stats, serializedBytes: 0 } }).byteLength);
    expect(Object.isFrozen(composed)).toBe(true);
  });

  it('is deterministic across candidate construction order and leaves inputs unchanged', () => {
    const input = base();
    const before = JSON.stringify(input);
    const output = result(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(output.analysis.status).toBe('COMPLETE');
  });


  it('rejects inconsistent identities instead of returning unsafe evidence', () => {
    const input = { ...base(), facts: [{ factId: digest('f'), kind: 'workflow.summary.v1', subject: { kind: 'WORKFLOW' as const }, properties: { connectionCount: 1 } }] };
    const composed = composeScannerResultV2(input);
    expect(composed.ok).toBe(false);
    if (!composed.ok) expect(composed.code).toBe('RESULT_COMPOSITION_FAILED');
  });
  it('preserves explicit null assessment for indeterminate analysis', () => {
    const capability = { id: 'source-normalization', version: '2.0.0', required: true, status: 'FAILED' as const, seen: 0, analyzed: 0, skipped: 0, omitted: 1, diagnosticIds: [] };
    const input = { ...base(), analysis: { status: 'INDETERMINATE' as const, capabilities: [capability], diagnostics: [] }, assessment: null };
    expect(result(input).assessment).toBeNull();
  });
  it('sorts diagnostics by registry and source location and aligns capability references', () => {
    const registry = diagnostic('SOURCE_SPAN_UNAVAILABLE', 'SOURCE', '/z', 'a');
    const locationA = diagnostic('OPTIONAL_LIMIT_EXCEEDED', 'LIMIT', '/a', 'b');
    const locationB = diagnostic('OPTIONAL_LIMIT_EXCEEDED', 'LIMIT', '/b', 'c');
    const capability = { id: 'source-normalization', version: '2.0.0', required: false, status: 'COMPLETED' as const, seen: 1, analyzed: 1, skipped: 0, omitted: 0, diagnosticIds: [locationA.id, registry.id, locationB.id] };
    const input = { ...base(), analysis: { status: 'DEGRADED' as const, capabilities: [capability], diagnostics: [locationB, registry, locationA] } };
    const composed = result(input);
    expect(composed.analysis.diagnostics.map((item) => item.code)).toEqual(['SOURCE_SPAN_UNAVAILABLE', 'OPTIONAL_LIMIT_EXCEEDED', 'OPTIONAL_LIMIT_EXCEEDED']);
    expect(composed.analysis.diagnostics.map((item) => item.location?.pointer)).toEqual(['/z', '/a', '/b']);
    expect(composed.analysis.capabilities[0].diagnosticIds).toEqual(composed.analysis.diagnostics.map((item) => item.id));
  });

  it('rejects a finding whose rule the admitted catalogue does not carry', () => {
    const first = base();
    const rule = admittedRule();
    const findingInput = { ruleId: 'NOT_AN_ADMITTED_RULE', evidenceClass: 'SUSPICIOUS_SYNTAX' as const, conclusion: 'OBSERVED' as const, applicability: 'APPLICABLE' as const, subject: { kind: 'WORKFLOW' as const }, factRefs: [], traceRefs: [], ruleRevision: rule.revision, effect: rule.effect, severity: rule.severity, confidence: rule.confidence, remediationId: rule.remediationId };
    const findingId = createFindingId(findingInput, { semanticSha256: first.input.semanticSha256 });
    const input = { ...first, findings: [{ ...findingInput, findingId }], assessment: { ...first.assessment!, excludedReportOnlyFindingIds: [findingId] } };
    const composed = composeScannerResultV2(input);
    expect(composed.ok).toBe(false);
    if (!composed.ok) expect(composed.code).toBe('RESULT_COMPOSITION_FAILED');
  });

  it('rejects a finding whose metadata claim disagrees with the admitted catalogue', () => {
    const first = base();
    const rule = admittedRule();
    const downgraded = { ruleId: rule.ruleId, evidenceClass: 'SUSPICIOUS_SYNTAX' as const, conclusion: 'OBSERVED' as const, applicability: 'APPLICABLE' as const, subject: { kind: 'WORKFLOW' as const }, factRefs: [], traceRefs: [], ruleRevision: rule.revision, effect: 'SCORING' as const, severity: 'INFO' as const, confidence: rule.confidence, remediationId: rule.remediationId };
    const findingId = createFindingId(downgraded, { semanticSha256: first.input.semanticSha256 });
    const input = { ...first, ruleset: { ...first.ruleset, rules: new Map([[rule.ruleId, rule]]) }, findings: [{ ...downgraded, findingId }], assessment: { ...first.assessment!, basisFindingIds: [findingId] } };
    expect(composeScannerResultV2(input).ok).toBe(false);
  });

  it('rejects a supplied ruleset that restates an admitted rule', () => {
    const first = base();
    const rule = admittedRule();
    const restated = { ...rule, severity: 'INFO' as const, effect: 'SCORING' as const };
    const findingInput = { ruleId: rule.ruleId, evidenceClass: 'SUSPICIOUS_SYNTAX' as const, conclusion: 'OBSERVED' as const, applicability: 'APPLICABLE' as const, subject: { kind: 'WORKFLOW' as const }, factRefs: [], traceRefs: [], ruleRevision: restated.revision, effect: restated.effect, severity: restated.severity, confidence: restated.confidence, remediationId: restated.remediationId };
    const findingId = createFindingId(findingInput, { semanticSha256: first.input.semanticSha256 });
    const input = { ...first, ruleset: { ...first.ruleset, rules: new Map([[rule.ruleId, restated]]) }, findings: [{ ...findingInput, findingId }], assessment: { ...first.assessment!, basisFindingIds: [findingId] } };
    expect(composeScannerResultV2(input).ok).toBe(false);
  });

  it('publishes an admitted-rule finding when the caller supplies the admitted catalogue itself', () => {
    const first = base();
    const rule = admittedRule();
    const findingInput = { ruleId: rule.ruleId, evidenceClass: 'SUSPICIOUS_SYNTAX' as const, conclusion: 'OBSERVED' as const, applicability: 'APPLICABLE' as const, subject: { kind: 'WORKFLOW' as const }, factRefs: [], traceRefs: [], remediationId: rule.remediationId };
    const findingBody = { ...findingInput, ruleRevision: rule.revision, effect: rule.effect, severity: rule.severity, confidence: rule.confidence };
    const findingId = createFindingId(findingBody, { semanticSha256: first.input.semanticSha256 });
    const composed = result({ ...first, ruleset: { ...first.ruleset, rules: createAdmittedRuleView().rules }, findings: [findingInput], assessment: { ...first.assessment!, excludedReportOnlyFindingIds: [findingId] } });
    expect(composed.findings).toEqual([expect.objectContaining({ ruleId: rule.ruleId, severity: rule.severity, effect: rule.effect })]);
  });

  it('keeps the assessment for a report-only unknown rule but not for a scoring one', () => {
    const first = base();
    const capabilityRow = (id: string, required: boolean, diagnosticId: string) => ({ id, version: '2.0.0', required, status: 'DEGRADED' as const, seen: 1, analyzed: 1, skipped: 0, omitted: 0, diagnosticIds: [diagnosticId] });
    const scoring = unknownRuleDiagnostic('UNKNOWN_SCORING_RULE', 'structural-policies', true);
    const reportOnly = unknownRuleDiagnostic('UNKNOWN_REPORT_ONLY_RULE', 'agentic-control', false);

    const refused = result({ ...first, analysis: { capabilities: [capabilityRow('structural-policies', true, scoring.id)], diagnostics: [scoring] } });
    expect(refused.analysis.status).toBe('INDETERMINATE');
    expect(refused.assessment).toBeNull();

    const degraded = result({ ...first, analysis: { capabilities: [capabilityRow('agentic-control', false, reportOnly.id)], diagnostics: [reportOnly] } });
    expect(degraded.analysis.status).toBe('DEGRADED');
    expect(degraded.assessment).not.toBeNull();
  });

  it('clears non-null assessment when derived status is indeterminate', () => {
    const first = base();
    const capability = { id: 'source-normalization', version: '2.0.0', required: true, status: 'FAILED' as const, seen: 0, analyzed: 0, skipped: 0, omitted: 1, diagnosticIds: [] };
    const composed = composeScannerResultV2({ ...first, analysis: { capabilities: [capability], diagnostics: [] } });
    expect(composed.ok).toBe(true);
    if (composed.ok) expect(composed.result.assessment).toBeNull();
  });

  it('derives degraded status from a diagnostic rather than from the row counters', () => {
    const first = base();
    // The row performed all of its work, so the diagnostic is the only source of the degraded outcome.
    const span = diagnostic('SOURCE_SPAN_UNAVAILABLE', 'SOURCE', '/omitted', 'd');
    const capability = { id: 'source-normalization', version: '2.0.0', required: false, status: 'COMPLETED' as const, seen: 1, analyzed: 1, skipped: 0, omitted: 0, diagnosticIds: [span.id] };
    const composed = composeScannerResultV2({ ...first, analysis: { capabilities: [capability], diagnostics: [span] } });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.result.analysis.capabilities[0], 'the row is clean, so it cannot be the cause').toMatchObject({ status: 'COMPLETED', skipped: 0, omitted: 0 });
    expect(composed.result.analysis.status).toBe('DEGRADED');
  });

  it('derives degraded status from an omission the owning row corroborates', () => {
    const first = base();
    const omission = diagnostic('SOURCE_SPAN_UNAVAILABLE', 'SOURCE', '/omitted', 'd', 1);
    // The reachable form of a diagnostic that records omitted units: its owner records the same loss.
    const capability = { id: 'source-normalization', version: '2.0.0', required: false, status: 'DEGRADED' as const, seen: 1, analyzed: 1, skipped: 0, omitted: 1, diagnosticIds: [omission.id] };
    const composed = composeScannerResultV2({ ...first, analysis: { capabilities: [capability], diagnostics: [omission] } });
    expect(composed.ok).toBe(true);
    if (composed.ok) expect(composed.result.analysis.status).toBe('DEGRADED');
  });

  it('refuses a diagnostic recording an omission the owning row counters deny', () => {
    const first = base();
    const omission = diagnostic('SOURCE_SPAN_UNAVAILABLE', 'SOURCE', '/omitted', 'd', 1);
    const capability = { id: 'source-normalization', version: '2.0.0', required: false, status: 'COMPLETED' as const, seen: 1, analyzed: 1, skipped: 0, omitted: 0, diagnosticIds: [omission.id] };
    const composed = composeScannerResultV2({ ...first, analysis: { capabilities: [capability], diagnostics: [omission] } });
    expect(composed.ok).toBe(false);
    if (composed.ok) return;
    expect(composed.code).toBe('RESULT_COMPOSITION_FAILED');
    expect(composed.errors.some((error) => error.includes('UNRECORDED_OMISSION'))).toBe(true);
  });

  it('composes a parser-eligible zero-work rejection as indeterminate', () => {
    const text = '{"nodes":[{"name":"A","type":"n8n-nodes-base.set","parameters":{}}],"connections":{}}';
    const bytes = new TextEncoder().encode(text);
    const parsed = parseSourceDocument(bytes, DEFAULT_SCANNER_LIMITS_V2);
    if (!parsed.ok) throw new Error('test workflow must parse');
    const normalized = normalizeSecurityWorkflow(parsed.document, DEFAULT_SCANNER_LIMITS_V2);
    if (!normalized.ok) throw new Error('test workflow must normalize');
    const rules = new Map(SAFE_FACT_EVIDENCE_MAPPINGS_V2.map((mapping) => {
      const catalog = betaHardenedRuleCatalog.find((entry) => entry.policyId === mapping.ruleId)!;
      return [mapping.ruleId, {
        ruleId: mapping.ruleId, revision: '1', capabilityId: mapping.ownerCapabilityId,
        effect: mapping.ownerCapabilityId === 'structural-policies' ? 'SCORING' as const : 'REPORT_ONLY' as const,
        severity: catalog.defaultSeverity, confidence: catalog.defaultConfidence, evidenceSchemaId: mapping.evidenceSchemaId,
        remediationId: 'r', cweIds: [...catalog.cweIds], owaspAgenticIds: [...(catalog.owaspAgenticIds ?? [])], packDigest: RULE_PACK_DIGEST_V2,
      }] as const;
    }));
    const context = { source: parsed.document, workflow: normalized.workflow, limits: DEFAULT_SCANNER_LIMITS_V2, rules: { rules } } as unknown as AnalyzerContextV2;
    const candidate = (seen: number): CapabilityCandidateV2 => createCapabilityCandidateAdmissionSnapshotV2({ findings: [], diagnostics: [], facts: [], traces: [], seen, analyzed: seen, skipped: 0, omitted: 0 });
    const registry = new Map(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map((capability) => [capability.id, {
      ...capability,
      run: () => candidate(capability.id === 'structural-policies' ? 0 : 1),
    }]));
    const schedule = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registry);
    const first = base();
    const composed = result({ ...first, input: { ...first.input, utf8Bytes: bytes.length }, analysis: { executions: schedule.executions, diagnostics: schedule.diagnostics, candidates: schedule.candidates } });

    expect(schedule.executions.find(({ id }) => id === 'structural-policies')?.status).toBe('FAILED');
    expect(composed.analysis.status).toBe('INDETERMINATE');
    expect(composed.assessment).toBeNull();
  });

  it('does not publish a complete result over a capability whose counts record skipped work', () => {
    const first = base();
    const skipped = { id: 'source-normalization', version: '2.0.0', required: true, status: 'COMPLETED' as const, seen: 3, analyzed: 1, skipped: 2, omitted: 0, diagnosticIds: [] };
    const composed = result({ ...first, analysis: { status: 'COMPLETE', capabilities: [skipped], diagnostics: [] } });
    expect(composed.analysis.status).toBe('DEGRADED');
    expect(composed.analysis.capabilities[0]).toMatchObject({ id: 'source-normalization', status: 'DEGRADED', seen: 3, analyzed: 1, skipped: 2, omitted: 0 });
    expect(composed.assessment).not.toBeNull();
  });

  it('degrades but does not suppress an optional capability that records an omission', () => {
    const first = base();
    const omitted = { id: 'agentic-control', version: '2.0.0', required: false, status: 'COMPLETED' as const, seen: 2, analyzed: 2, skipped: 0, omitted: 1, diagnosticIds: [] };
    const composed = result({ ...first, analysis: { capabilities: [omitted], diagnostics: [] } });
    expect(composed.analysis.status).toBe('DEGRADED');
    expect(composed.analysis.capabilities[0]).toMatchObject({ status: 'DEGRADED', omitted: 1 });
    expect(composed.assessment).not.toBeNull();
  });
});
