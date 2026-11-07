import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import fieldFlowVectors from '../../../../docs/superpowers/plans/2026-10-21-scanner-deepseek/Q04-FIELD-FACT-VECTORS.json';
import type { SafeFactV2, SafeFactValueV2 } from '../../../../contracts/scanner-v2-evidence';
import { canonicalSafeFactSubjectIdentity } from '../facts/safe-fact-validator';
import { canonicalizeJson } from '../canonical-json';
import { createDiagnosticId } from '../diagnostics/identity';
import { createCandidateTraceId } from '../result-v2/identities';
import { classifyDiagnostic, type AnalysisDiagnosticV2 } from '../diagnostics/registry';
import type { SourceMemberRefV2 } from '../source/source-types';
import { createEdgeIdentityDigest, createNodeIdentityDigest, encodeIdentityTuple } from '../workflow-v2/node-edge-identity';
import { SAFE_FACT_EVIDENCE_MAPPINGS_V2, SAFE_FACT_REGISTRY_V2 } from '../facts/safe-fact-registry';
import { betaHardenedRuleCatalog } from '../policy/rule-catalog';
import { RULE_PACK_DIGEST_V2, validateCapabilityCandidate as validateAdmittedCapabilityCandidate } from './candidate-validator';
import { BETA_DEFAULT_PROFILE_MANIFEST, BETA_HARDENED_PROFILE_MANIFEST } from './profile-manifest';
import type { CapabilityCandidateV2 } from './scheduler';
import { createCapabilityCandidateAdmissionSnapshotV2, isScannerAdmissionSnapshotV2 } from '../admission/snapshot';

const digest = (letter = 'a') => letter.repeat(64);
const workflow = { kind: 'WORKFLOW' as const };
const rule = { ruleId: 'N8N_EXECUTE_COMMAND', revision: '1', capabilityId: 'structural-policies', effect: 'SCORING' as const, severity: 'CRITICAL' as const, confidence: 'HIGH' as const, evidenceSchemaId: 'v1.node-type', remediationId: 'r', cweIds: ['CWE-78'], owaspAgenticIds: [], packDigest: RULE_PACK_DIGEST_V2 };
const exactStructuralMetadata = BETA_DEFAULT_PROFILE_MANIFEST.capabilities.find((item) => item.id === 'structural-policies')!;
const capability = { ...exactStructuralMetadata, run: () => ({ findings: [], diagnostics: [], facts: [], traces: [], seen: 0, analyzed: 0, skipped: 0, omitted: 0 }) };
const facts = { schemaVersion: 'scanner-safe-facts-v2' as const, version: SAFE_FACT_REGISTRY_V2.version, schemas: SAFE_FACT_REGISTRY_V2.schemas, digest: SAFE_FACT_REGISTRY_V2.digest };
const nodeSource: SourceMemberRefV2 = { pointer: '', occurrencePath: [], astNodeId: digest('b'), span: null };
const nodeSubject = { kind: 'NODE' as const, node: { ordinal: 0, source: nodeSource, identityDigest: createNodeIdentityDigest(0, nodeSource) } };
const edgeSubject = { kind: 'EDGE' as const, edge: { ordinal: 0, sourceNode: nodeSubject.node, sourceLabel: 'main', targetNode: nodeSubject.node, targetLabel: 'main', connectionType: 'main', sourcePort: 0, targetPort: 0, source: nodeSource, resolution: 'RESOLVED' as const } };
const sourceSubject = { kind: 'SOURCE' as const, source: nodeSource };
const id = (parts: readonly string[]) => bytesToHex(sha256(new TextEncoder().encode(encodeIdentityTuple(parts))));
const fact = (idOverride?: string, kind = 'node.capability.v2', properties: Record<string, unknown> = { nodeType: 'n8n-nodes-base.executeCommand', nodePackage: 'n8n-nodes-base', namespaceClass: 'OFFICIAL_BASE', capabilities: ['EXECUTE_COMMAND'], toolCount: 0, contextCount: 0 }, overrides: Record<string, unknown> = {}) => {
  const merged = { ...properties, ...overrides };
  const subject = ['code.indicator.v2', 'node.configuration.v2'].includes(kind) ? sourceSubject : nodeSubject;
  const subjectIdentity = subject.kind === 'SOURCE' ? `SOURCE${subject.source.astNodeId}` : `NODE${subject.node.identityDigest}`;
  return { factId: idOverride ?? id(['secureflow-fact-id-v2', kind, subjectIdentity, canonicalizeJson(merged)]), kind, subject, properties: merged };
};
const empty = (): CapabilityCandidateV2 => ({ findings: [], diagnostics: [], facts: [], traces: [], seen: 0, analyzed: 0, skipped: 0, omitted: 0 });
const evidenceShape = (candidate: CapabilityCandidateV2) => ({ findings: candidate.findings, diagnostics: candidate.diagnostics, facts: candidate.facts, traces: candidate.traces });
const finding = (ruleId = rule.ruleId, factRefs: string[] = []) => ({ ruleId, evidenceClass: (ruleId.startsWith('TAINTED_') ? 'POTENTIAL_DATAFLOW' : ruleId === 'JAVASCRIPT_DYNAMIC_EXECUTION' || ruleId === 'PYTHON_DYNAMIC_EXECUTION' ? 'SUSPICIOUS_SYNTAX' : 'CAPABILITY') as 'CAPABILITY' | 'POTENTIAL_DATAFLOW' | 'SUSPICIOUS_SYNTAX', conclusion: 'OBSERVED' as const, applicability: 'APPLICABLE' as const, subject: { kind: 'WORKFLOW' as const }, factRefs, traceRefs: [], remediationId: 'r' });
const canonicalRules = new Map(SAFE_FACT_EVIDENCE_MAPPINGS_V2.map((mapping) => {
  const catalog = betaHardenedRuleCatalog.find((entry) => entry.policyId === mapping.ruleId);
  if (!catalog) throw new Error(`missing catalog entry for ${mapping.ruleId}`);
  return [mapping.ruleId, { ruleId: mapping.ruleId, revision: '1', capabilityId: mapping.ownerCapabilityId, effect: mapping.ownerCapabilityId === 'structural-policies' ? 'SCORING' as const : 'REPORT_ONLY' as const, severity: catalog.defaultSeverity, confidence: catalog.defaultConfidence, evidenceSchemaId: mapping.evidenceSchemaId, remediationId: 'r', cweIds: [...catalog.cweIds], owaspAgenticIds: [...(catalog.owaspAgenticIds ?? [])], packDigest: RULE_PACK_DIGEST_V2 }];
}));
const exactStructural = capability;
const exactStructuralRules = new Map(exactStructural.ruleIds.map((ruleId) => [ruleId, canonicalRules.get(ruleId)!]));
const registries = { facts, rules: exactStructuralRules };
const admit = (candidate: CapabilityCandidateV2) => createCapabilityCandidateAdmissionSnapshotV2(candidate);
const validateCapabilityCandidate = (candidate: unknown, capabilityValue: typeof capability, registryValue = registries, limits = DEFAULT_SCANNER_LIMITS_V2) => {
  const admitted = isScannerAdmissionSnapshotV2(candidate) ? candidate : admit(candidate as CapabilityCandidateV2);
  return validateAdmittedCapabilityCandidate(admitted, capabilityValue, registryValue, limits, 0);
};
const validateRawCandidate = (candidate: unknown, capabilityValue: typeof capability, registryValue = registries, limits = DEFAULT_SCANNER_LIMITS_V2, eligibleUnits = 0) =>
  validateAdmittedCapabilityCandidate(candidate, capabilityValue, registryValue, limits, eligibleUnits);

type FieldFlowPatches = Readonly<Record<string, Readonly<Record<string, SafeFactValueV2>>>>;
function fieldFlowFacts(patches: FieldFlowPatches = {}): SafeFactV2[] {
  const records: SafeFactV2[] = JSON.parse(JSON.stringify(fieldFlowVectors.facts));
  return records.map((record) => {
    const properties = { ...record.properties, ...patches[record.kind] };
    return { ...record, properties, factId: id(['secureflow-fact-id-v2', record.kind, canonicalSafeFactSubjectIdentity(record.subject), canonicalizeJson(properties)]) };
  });
}
const fieldFlowSpec = { ...BETA_HARDENED_PROFILE_MANIFEST.capabilities.find((item) => item.id === 'taint-confidentiality')!, run: capability.run };
const fieldFlowRegistries = { facts, rules: new Map(fieldFlowSpec.ruleIds.map((ruleId) => [ruleId, canonicalRules.get(ruleId)!])) };

describe('capability candidate admission', () => {
  it('admits one origin shared by known and unknown sink summaries', () => {
    const [origin, known, coverage] = fieldFlowFacts({ 'dataflow.coverage.v1': { emittedFlows: 2 } });
    const unknown = fieldFlowFacts({ 'dataflow.summary.v3': { knowledge: 'UNKNOWN', unknownReasons: ['DYNAMIC_FIELD'], sinkFieldPath: ['other'] } })[1];
    expect(validateCapabilityCandidate({ ...empty(), facts: [origin, known, unknown, coverage] }, fieldFlowSpec, fieldFlowRegistries)).toMatchObject({ ok: true });
  });

  it('refuses individually valid facts whose embedded origin or candidate coverage disagrees', () => {
    const original = fieldFlowFacts();
    expect(validateCapabilityCandidate({ ...empty(), facts: original.slice(1) }, fieldFlowSpec, fieldFlowRegistries)).toMatchObject({ ok: false });
    const changes: FieldFlowPatches[] = [
      { 'dataflow.summary.v3': { sourceFieldPath: ['different'] } },
      { 'dataflow.summary.v3': { taintChannel: 'INTEGRITY', taintLabels: ['INBOUND_MESSAGE'] } },
      { 'dataflow.coverage.v1': { emittedFlows: 0 } },
    ];
    for (const patches of changes) expect(validateCapabilityCandidate({ ...empty(), facts: fieldFlowFacts(patches) }, fieldFlowSpec, fieldFlowRegistries)).toMatchObject({ ok: false });
    const duplicateCoverage = fieldFlowFacts({ 'dataflow.coverage.v1': { coverageStatus: 'LIMITED', witnessUnavailable: 1 } })[2];
    expect(validateCapabilityCandidate({ ...empty(), facts: [...original, duplicateCoverage] }, fieldFlowSpec, fieldFlowRegistries)).toMatchObject({ ok: false });
  });

  it('retains zero-flow coverage and unreferenced safe provenance for an attempted capability', () => {
    const [origin, , coverage] = fieldFlowFacts({ 'dataflow.coverage.v1': { emittedFlows: 0, positiveFields: 0 } });
    expect(validateCapabilityCandidate({ ...empty(), facts: [origin, coverage] }, fieldFlowSpec, fieldFlowRegistries)).toMatchObject({ ok: true });
    expect(validateCapabilityCandidate(empty(), fieldFlowSpec, fieldFlowRegistries)).toMatchObject({ ok: false });
  });

  it('rejects analyzer-claimed zero work when the parser contract says work was eligible', () => {
    const candidate = admit(empty());
    expect(validateRawCandidate(candidate, capability, registries, DEFAULT_SCANNER_LIMITS_V2, 1)).toMatchObject({ ok: false, reason: 'INVALID_COUNTER' });
    expect(validateRawCandidate(candidate, capability, registries, DEFAULT_SCANNER_LIMITS_V2, 0)).toMatchObject({ ok: true });
  });

  it('admits zero counters and valid owned facts as a frozen snapshot', () => {
    const result = validateCapabilityCandidate({ ...empty(), facts: [fact()] }, capability, registries, DEFAULT_SCANNER_LIMITS_V2);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.candidate.facts[0])).toBe(true);
      expect(Object.isFrozen(result.candidate.facts)).toBe(true);
    }
  });
  it('rejects duplicates, dangling references, unknown rules, unowned rules, and invalid counters', () => {
    const duplicate = validateCapabilityCandidate({ ...empty(), facts: [fact(), fact()] }, capability, registries, DEFAULT_SCANNER_LIMITS_V2);
    expect(duplicate).toMatchObject({ ok: false, reason: 'DUPLICATE_ID' });
    const dangling = validateCapabilityCandidate({ ...empty(), findings: [{ ruleId: rule.ruleId, evidenceClass: 'CAPABILITY', conclusion: 'OBSERVED', applicability: 'APPLICABLE', subject: workflow, factRefs: [digest('e')], traceRefs: [], remediationId: 'r' }] }, capability, registries, DEFAULT_SCANNER_LIMITS_V2);
    expect(dangling).toMatchObject({ ok: false, reason: 'DANGLING_REFERENCE' });
    expect(validateCapabilityCandidate({ ...empty(), findings: [{ ruleId: 'MISSING', evidenceClass: 'CAPABILITY', conclusion: 'OBSERVED', applicability: 'APPLICABLE', subject: workflow, factRefs: [], traceRefs: [], remediationId: 'r' }] }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNKNOWN_RULE' });
    expect(validateCapabilityCandidate({ ...empty(), seen: -1 }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'INVALID_COUNTER' });
  });
  it('rejects cap-plus-one findings, accessors, symbols, and candidate content without echoing it', () => {
    const limited = { ...DEFAULT_SCANNER_LIMITS_V2, maxFindings: 0 };
    expect(validateCapabilityCandidate(admit({ ...empty(), findings: [finding()] }), capability, registries, limited)).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' });
    let invoked = false;
    const hostile = { ...empty(), findings: [] } as Record<string, unknown>;
    Object.defineProperty(hostile, 'findings', { get: () => { invoked = true; throw new Error('candidate-secret'); } });
    Object.defineProperty(hostile, Symbol('secret'), { value: 'candidate-secret' });
    const result = validateRawCandidate(hostile, capability, registries, DEFAULT_SCANNER_LIMITS_V2);
    expect(result.ok).toBe(false);
    expect(invoked).toBe(false);
    expect(JSON.stringify(result)).not.toContain('candidate-secret'); const rawFact = fact(); let nestedInvoked = false; const nestedTarget = ['EXECUTE_COMMAND']; Object.defineProperty(nestedTarget, '0', { get: () => { nestedInvoked = true; throw new Error('nested-secret'); } }); const proxyList = new Proxy(nestedTarget, { get: () => { nestedInvoked = true; throw new Error('nested-secret'); } }); expect(validateRawCandidate({ ...empty(), facts: [{ ...rawFact, properties: { ...rawFact.properties, capabilities: proxyList } }] }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false }); expect(nestedInvoked).toBe(false);
  });

  it('admits producer-owned JS facts for a dependent capability through the closed projection', () => {
    const jsRule = { ...rule, ruleId: 'JAVASCRIPT_DYNAMIC_EXECUTION', capabilityId: 'javascript-security', effect: 'REPORT_ONLY' as const, severity: 'HIGH' as const, evidenceSchemaId: 'v1.code-indicator', cweIds: ['CWE-95'] };
    const readonlyRules = new Map([[jsRule.ruleId, jsRule]]); expect(validateCapabilityCandidate(empty(), { ...capability, id: 'javascript-security', required: false, dependsOn: [], ruleIds: [jsRule.ruleId] }, { facts, rules: readonlyRules }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
    const codeProperties = { language: 'JAVASCRIPT', indicator: 'EVAL', start: 0, end: 1, parseState: 'VERIFIED' };
    const codeFact = fact(undefined, 'code.indicator.v2', codeProperties);
    expect(validateCapabilityCandidate({ ...empty(), facts: [codeFact], findings: [finding(jsRule.ruleId, [codeFact.factId])] }, { ...capability, id: 'javascript-security', required: false, dependsOn: [], ruleIds: [jsRule.ruleId] }, { facts, rules: readonlyRules }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
    const result = validateCapabilityCandidate({ ...empty(), facts: [codeFact], findings: [finding(jsRule.ruleId, [codeFact.factId])] }, { ...capability, id: 'javascript-security', required: false, dependsOn: ['source-normalization'], ruleIds: [jsRule.ruleId] }, { facts, rules: readonlyRules }, DEFAULT_SCANNER_LIMITS_V2);
    expect(result).toMatchObject({ ok: true });
  });

  it('keeps finding and fact cardinalities independent', () => {
    const codeProperties = { language: 'JAVASCRIPT', indicator: 'EVAL', start: 0, end: 1, parseState: 'VERIFIED' };
    const codeFact = fact(undefined, 'code.indicator.v2', codeProperties);
    const jsRule = { ...rule, ruleId: 'JAVASCRIPT_DYNAMIC_EXECUTION', capabilityId: 'javascript-security', effect: 'REPORT_ONLY' as const, severity: 'HIGH' as const, evidenceSchemaId: 'v1.code-indicator', cweIds: ['CWE-95'] };
    const rules = new Map([[jsRule.ruleId, jsRule]]);
    const result = validateCapabilityCandidate({ ...empty(), facts: [codeFact], findings: [finding(jsRule.ruleId, [codeFact.factId])] }, { ...capability, id: 'javascript-security', required: false, dependsOn: ['source-normalization'], ruleIds: [jsRule.ruleId] }, { facts, rules }, { ...DEFAULT_SCANNER_LIMITS_V2, maxFindings: 1 });
    expect(result).toMatchObject({ ok: true });
  });

  it('rejects forged trace ids and canonicalizes collection order', () => {
    const trace = { traceId: digest('z'), kind: 'CONTROL' as const, steps: [{ ordinal: 0, kind: 'SOURCE' as const, subject: nodeSubject, factRefs: [] }] };
    const result = validateCapabilityCandidate({ ...empty(), traces: [trace] }, capability, registries, DEFAULT_SCANNER_LIMITS_V2);
    expect(result).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
  });

  it('counts structural, numeric, boolean, and null evidence bytes exactly', () => {
    const evidence = new TextEncoder().encode(canonicalizeJson(evidenceShape(empty()))).length;
    const candidate = admit(empty());
    expect(validateCapabilityCandidate(candidate, capability, registries, { ...DEFAULT_SCANNER_LIMITS_V2, maxEvidenceBytes: evidence - 1 })).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' });
    expect(validateCapabilityCandidate(candidate, capability, registries, { ...DEFAULT_SCANNER_LIMITS_V2, maxEvidenceBytes: evidence })).toMatchObject({ ok: true });
    expect(validateCapabilityCandidate(candidate, capability, registries, { ...DEFAULT_SCANNER_LIMITS_V2, maxEvidenceBytes: evidence + 1 })).toMatchObject({ ok: true });
    let ownKeysCalls = 0;
    const hostileFacts = new Proxy([], { ownKeys: () => { ownKeysCalls += 1; return Array.from({ length: 100_000 }, (_, index) => `k${index}`); }, getOwnPropertyDescriptor: () => undefined });
    expect(validateRawCandidate({ ...empty(), facts: hostileFacts }, capability, registries, { ...DEFAULT_SCANNER_LIMITS_V2, maxEvidenceBytes: evidence + 1 })).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
    expect(ownKeysCalls).toBe(0);
  });
  it('preflights tiny evidence budgets before materializing large fact bytes', () => {
    const evidence = new TextEncoder().encode(canonicalizeJson(evidenceShape(empty()))).length;
    expect(validateCapabilityCandidate(empty(), capability, registries, { ...DEFAULT_SCANNER_LIMITS_V2, maxEvidenceBytes: 0 })).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' });
    const marker = 'x'.repeat(256);
    const largeFact = fact(undefined, 'node.capability.v2', { nodeType: `n8n-nodes-base.${marker}.Node`, nodePackage: 'n8n-nodes-base', namespaceClass: 'OFFICIAL_BASE', capabilities: ['EXECUTE_COMMAND'], toolCount: 0, contextCount: 0 });
    const originalEncode = TextEncoder.prototype.encode;
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: InstanceType<typeof TextEncoder>, input = '') { if (input.includes(marker)) throw new Error('large evidence materialized'); return originalEncode.call(this, input); });
    try { expect(validateCapabilityCandidate({ ...empty(), facts: [largeFact] }, capability, registries, { ...DEFAULT_SCANNER_LIMITS_V2, maxEvidenceBytes: evidence + 16 })).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' }); } finally { encode.mockRestore(); }
  });

  it('refuses legacy taint facts even alongside complete canonical field evidence', () => {
    const taintRule = { ...rule, ruleId: 'TAINTED_SQL_QUERY', capabilityId: 'taint-integrity', effect: 'REPORT_ONLY' as const, severity: 'HIGH' as const, confidence: 'MEDIUM' as const, evidenceSchemaId: 'v1.taint', cweIds: ['CWE-89'] };
    const taintDataflowProperties = { flowKind: 'TAINT_SINK', sink: 'SQL', parameterPath: '/query', referenceRoot: '$json', propertyPathComplete: true, humanGatePresent: false, humanGateDominates: false, taintLabels: ['WEBHOOK_BODY'], sourceNodeId: 'w', sourceNodeName: 'Webhook' };
    const taintFact = fact(undefined, 'dataflow.summary.v2', taintDataflowProperties);
    const taintMetadata = BETA_HARDENED_PROFILE_MANIFEST.capabilities.find((item) => item.id === 'taint-integrity')!;
    const taintCapability = { ...taintMetadata, run: capability.run };
    const taintRules = new Map(taintCapability.ruleIds.map((ruleId) => [ruleId, ruleId === taintRule.ruleId ? taintRule : canonicalRules.get(ruleId)!]));
    const canonical = fieldFlowFacts({ 'dataflow.coverage.v1': { capabilityId: 'taint-integrity' } });
    expect(validateCapabilityCandidate({ ...empty(), facts: canonical }, taintCapability, { facts, rules: taintRules })).toMatchObject({ ok: true });
    const taintCandidate = validateCapabilityCandidate({ ...empty(), facts: [...canonical, taintFact], findings: [finding(taintRule.ruleId, [taintFact.factId])] }, taintCapability, { facts, rules: taintRules }, DEFAULT_SCANNER_LIMITS_V2);
    expect(taintCandidate).toMatchObject({ ok: false });
  });

  it.each([
    ['TAINTED_CODE_INPUT', 'CODE', 'taint-integrity'],
    ['TAINTED_COMMAND', 'COMMAND', 'taint-integrity'],
    ['TAINTED_SQL_QUERY', 'SQL', 'taint-integrity'],
    ['TAINTED_FILE_PATH', 'PATH', 'taint-integrity'],
    ['TAINTED_REQUEST_HEADER', 'HEADER', 'taint-integrity'],
    ['TAINTED_REQUEST_URL', 'SSRF', 'taint-integrity'],
    ['TAINTED_AI_PROMPT', 'PROMPT', 'taint-integrity'],
  ])('admits %s only with its canonical sink class', (ruleId, sinkClass, owner) => {
    const metadata = BETA_HARDENED_PROFILE_MANIFEST.capabilities.find((item) => item.id === owner)!;
    const taintCapability = { ...metadata, run: capability.run };
    const taintRegistries = { facts, rules: new Map(metadata.ruleIds.map((id) => [id, canonicalRules.get(id)!])) };
    const makeCandidate = (actualSink: string) => {
      const evidence = fieldFlowFacts({
        'dataflow.summary.v3': { sinkClass: actualSink },
        'dataflow.coverage.v1': { capabilityId: owner },
      });
      const summary = evidence.find((value) => value.kind === 'dataflow.summary.v3')!;
      return {
        ...empty(), facts: evidence,
        findings: [{ ...finding(ruleId, [summary.factId]), subject: summary.subject }],
      };
    };
    const admitted = validateCapabilityCandidate(makeCandidate(sinkClass), taintCapability, taintRegistries);
    expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true });
    expect(validateCapabilityCandidate(makeCandidate(sinkClass === 'COMMAND' ? 'SQL' : 'COMMAND'), taintCapability, taintRegistries))
      .toMatchObject({ ok: false, reason: 'DANGLING_REFERENCE' });
  });

  it('preserves the separate v2 agent-control evidence and human-gate requirements', () => {
    const agentRule = { ...rule, ruleId: 'AI_AGENT_UNGATED_TOOL', capabilityId: 'agentic-control', effect: 'REPORT_ONLY' as const, severity: 'MEDIUM' as const, confidence: 'LOW' as const, evidenceSchemaId: 'v1.agent-control', cweIds: ['CWE-269'], owaspAgenticIds: ['Excessive Agency'] };
    const nodeFact = fact(undefined, 'node.capability.v2', undefined, { capabilities: ['AI_AGENT'], toolCount: 1, contextCount: 1 });
    const agentFlow = fact(undefined, 'dataflow.summary.v2', { flowKind: 'AGENT_INFLUENCE', propertyPathComplete: true, humanGatePresent: false, humanGateDominates: false, taintLabels: ['WEBHOOK_BODY'] });
    const agentDependencies = ['graph-semantics', 'taint-confidentiality', 'taint-integrity']; const agentCandidate = validateCapabilityCandidate({ ...empty(), facts: [nodeFact, agentFlow], findings: [finding(agentRule.ruleId, [nodeFact.factId, agentFlow.factId])] }, { ...capability, id: 'agentic-control', required: false, dependsOn: agentDependencies, ruleIds: [agentRule.ruleId] }, { facts, rules: new Map([[agentRule.ruleId, agentRule]]) }, DEFAULT_SCANNER_LIMITS_V2);
    expect(agentCandidate).toMatchObject({ ok: true });

    const gatedAgentFlow = fact(undefined, 'dataflow.summary.v2', { flowKind: 'AGENT_INFLUENCE', propertyPathComplete: true, humanGatePresent: true, humanGateDominates: true, taintLabels: ['WEBHOOK_BODY'] });
    expect(validateCapabilityCandidate({ ...empty(), facts: [nodeFact, gatedAgentFlow] }, { ...capability, id: 'agentic-control', required: false, dependsOn: agentDependencies, ruleIds: [agentRule.ruleId] }, { facts, rules: new Map([[agentRule.ruleId, agentRule]]) }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
  });

  it('verifies canonical trace ids and canonical duplicate finding identity', () => {
    const steps = [{ ordinal: 0, kind: 'SOURCE' as const, subject: nodeSubject, factRefs: [] as string[] }];
    const trace = { traceId: digest('z'), kind: 'CONTROL' as const, steps };
    expect(validateCapabilityCandidate({ ...empty(), traces: [trace] }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
    const codeProperties = { language: 'JAVASCRIPT', indicator: 'EVAL', start: 0, end: 1, parseState: 'VERIFIED' };
    const codeFact = fact(undefined, 'code.indicator.v2', codeProperties);
    const jsRule = { ...rule, ruleId: 'JAVASCRIPT_DYNAMIC_EXECUTION', capabilityId: 'javascript-security', effect: 'REPORT_ONLY' as const, severity: 'HIGH' as const, evidenceSchemaId: 'v1.code-indicator', cweIds: ['CWE-95'] };
    const base = finding(jsRule.ruleId, [codeFact.factId]);
    const duplicate = { ...base, factRefs: [codeFact.factId] };
    const result = validateCapabilityCandidate({ ...empty(), facts: [codeFact], findings: [base, duplicate] }, { ...capability, id: 'javascript-security', required: false, dependsOn: ['source-normalization'], ruleIds: [jsRule.ruleId] }, { facts, rules: new Map([[jsRule.ruleId, jsRule]]) }, DEFAULT_SCANNER_LIMITS_V2);
    expect(result).toMatchObject({ ok: false, reason: 'DUPLICATE_ID' });
  });

  it('rejects evidence refs outside the registered projection and malformed advisory facts', () => {
    const nodeFact = fact(undefined, 'node.capability.v2');
    const jsRule = { ...rule, ruleId: 'JAVASCRIPT_DYNAMIC_EXECUTION', capabilityId: 'javascript-security', effect: 'REPORT_ONLY' as const, severity: 'HIGH' as const, evidenceSchemaId: 'v1.code-indicator', cweIds: ['CWE-95'] };
    const invalid = validateCapabilityCandidate({ ...empty(), facts: [nodeFact], findings: [finding(jsRule.ruleId, [nodeFact.factId])] }, { ...capability, id: 'javascript-security', required: false, dependsOn: ['source-normalization'], ruleIds: [jsRule.ruleId] }, { facts, rules: new Map([[jsRule.ruleId, jsRule]]) }, DEFAULT_SCANNER_LIMITS_V2);
    expect(invalid).toMatchObject({ ok: false, reason: 'DANGLING_REFERENCE' });
    const advisory = fact(undefined, 'advisory.applicability.v3');
    expect(validateCapabilityCandidate({ ...empty(), facts: [advisory] }, { ...capability, id: 'assessment', dependsOn: ['workflow-insights', 'structural-policies'], ruleIds: [] }, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNKNOWN_KEY' });
  });

  it('accepts an immutable cloned registry only when its version and digest match', () => {
    const clonedFacts = Object.freeze({ schemaVersion: facts.schemaVersion, version: facts.version, schemas: Object.freeze([...facts.schemas]), digest: facts.digest });
    expect(validateCapabilityCandidate(empty(), capability, { facts: clonedFacts, rules: registries.rules }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    expect(validateCapabilityCandidate(empty(), capability, { facts: { ...clonedFacts, digest: digest('f') }, rules: registries.rules }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
  });

  it('produces the same ordered snapshot for permuted input collections', () => {
    const first = validateCapabilityCandidate(empty(), capability, registries, DEFAULT_SCANNER_LIMITS_V2);
    const second = validateCapabilityCandidate({ omitted: 0, skipped: 0, analyzed: 0, seen: 0, traces: [], facts: [], diagnostics: [], findings: [] }, capability, registries, DEFAULT_SCANNER_LIMITS_V2);
    expect(first).toEqual(second);
  });

  it('rejects callback rule registries without invoking caller functions', () => {
    let invoked = false;
    const callbackRegistry = { get: () => { invoked = true; }, has: () => { invoked = true; return true; }, size: 1 };
    expect(validateCapabilityCandidate(empty(), capability, { facts, rules: callbackRegistry as never }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
    expect(invoked).toBe(false);
    const mapProxy = new Proxy(registries.rules, { get: () => { invoked = true; throw new Error('map getter'); } }); expect(validateCapabilityCandidate(empty(), capability, { facts, rules: mapProxy }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' }); expect(invoked).toBe(false);
  });

  it('rejects forged rule metadata and unknown candidate keys', () => {
    const forged = new Map([[rule.ruleId, { ...rule, packDigest: digest('f') }]]);
    expect(validateCapabilityCandidate(empty(), capability, { facts, rules: forged }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
    expect(validateRawCandidate({ ...empty(), extra: 'x' }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
  });

  it('rejects field-specific credentials, absolute paths, raw snippets, and lone surrogates', () => {
    const configuration = fact(undefined, 'node.configuration.v2', { observation: 'AUTH_HEADER', header: 'Authorization: secret', literalValue: true });
    expect(validateCapabilityCandidate({ ...empty(), facts: [configuration] }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    const code = fact(undefined, 'code.indicator.v2', { language: 'JAVASCRIPT', indicator: 'EXEC', member: 'require("/etc/passwd")', start: 0, end: 1, parseState: 'VERIFIED' });
    expect(validateCapabilityCandidate({ ...empty(), facts: [code] }, { ...capability, id: 'javascript-security', required: false, dependsOn: ['source-normalization'], ruleIds: ['JAVASCRIPT_DYNAMIC_EXECUTION'] }, { facts, rules: new Map([['JAVASCRIPT_DYNAMIC_EXECUTION', { ...rule, ruleId: 'JAVASCRIPT_DYNAMIC_EXECUTION', capabilityId: 'javascript-security', effect: 'REPORT_ONLY' as const, severity: 'HIGH' as const, evidenceSchemaId: 'v1.code-indicator', cweIds: ['CWE-95'] }]]) }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    expect(validateCapabilityCandidate({ ...empty(), omitted: '\ud800' }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    const tokenMetadata = fact(undefined, 'node.capability.v2', { nodeType: 'n8n-nodes-base.executeCommand', nodePackage: 'sk-live-raw-token', namespaceClass: 'OFFICIAL_BASE', capabilities: ['EXECUTE_COMMAND'], toolCount: 0, contextCount: 0 });
    expect(validateCapabilityCandidate({ ...empty(), facts: [tokenMetadata] }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
  });

  it('orders diagnostics by capability, registry code, location path, null-last, then id', () => {
    const makeDiagnostic = (code: 'SOURCE_SPAN_UNAVAILABLE' | 'DUPLICATE_FINDING_COLLAPSED', location?: SourceMemberRefV2): AnalysisDiagnosticV2 => {
      const classification = classifyDiagnostic(code, true);
      const identity = { code, capabilityId: capability.id, ...classification, ...(location ? { location } : {}) };
      return { ...identity, id: createDiagnosticId(identity) };
    };
    const span = { start: { line: 1, column: 1, utf16Offset: 0, utf8ByteOffset: 0 }, end: { line: 1, column: 2, utf16Offset: 1, utf8ByteOffset: 1 } };
    const diagnostics = [
      makeDiagnostic('SOURCE_SPAN_UNAVAILABLE', { ...nodeSource, pointer: '/x', occurrencePath: [2], span: null, astNodeId: digest('c') }),
      makeDiagnostic('SOURCE_SPAN_UNAVAILABLE'),
      makeDiagnostic('DUPLICATE_FINDING_COLLAPSED', { ...nodeSource, pointer: '/x', occurrencePath: [1], span, astNodeId: digest('d') }),
      makeDiagnostic('SOURCE_SPAN_UNAVAILABLE', { ...nodeSource, pointer: '/x', occurrencePath: [1], span, astNodeId: digest('e') }),
    ];
    const result = validateCapabilityCandidate({ ...empty(), diagnostics }, capability, registries, DEFAULT_SCANNER_LIMITS_V2);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.candidate.diagnostics.map(({ id }) => id)).toEqual([diagnostics[3].id, diagnostics[0].id, diagnostics[1].id, diagnostics[2].id]);
  });

  it('rejects counters that leave seen units unaccounted for', () => {
    // `seen` units that are neither analyzed, skipped, nor omitted are a coverage claim the
    // snapshot cannot support: nothing recorded the loss.
    expect(validateCapabilityCandidate({ ...empty(), seen: 3, analyzed: 1, skipped: 0, omitted: 1 }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'INVALID_COUNTER' });
    expect(validateCapabilityCandidate({ ...empty(), seen: 1, analyzed: 0, skipped: 0, omitted: 0 }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'INVALID_COUNTER' });
  });

  it('admits every counter shape the shipped analyzers produce', () => {
    // Shipped `javascript-security` reports one seen node, one analyzed source, and one
    // recorded omission for it, so the counters are not a partition of `seen` and the
    // validator must not require strict equality between them.
    expect(validateCapabilityCandidate({ ...empty(), seen: 1, analyzed: 1, skipped: 0, omitted: 1 }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    expect(validateCapabilityCandidate({ ...empty(), seen: 3, analyzed: 1, skipped: 1, omitted: 1 }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
  });

  it('rejects a snapshot whose own truncation diagnostic disagrees with its counters', () => {
    const classify = classifyDiagnostic('OPTIONAL_LIMIT_EXCEEDED', false);
    const identity = { code: 'OPTIONAL_LIMIT_EXCEEDED' as const, capabilityId: capability.id, ...classify, observed: 1, maximum: 0, omitted: 1 };
    const diagnosed = { ...identity, id: createDiagnosticId(identity) };
    expect(validateCapabilityCandidate({ ...empty(), diagnostics: [diagnosed] }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'INVALID_COUNTER' });
    // The same truncation with the omission recorded is admissible.
    const admitted = validateCapabilityCandidate({ ...empty(), omitted: 1, diagnostics: [diagnosed] }, capability, registries, DEFAULT_SCANNER_LIMITS_V2);
    expect(admitted).toMatchObject({ ok: true });
  });

  it('refuses an over-cap findings array instead of truncating it and keeping the counters', () => {
    const jsRule = { ...rule, ruleId: 'JAVASCRIPT_DYNAMIC_EXECUTION', capabilityId: 'javascript-security', effect: 'REPORT_ONLY' as const, severity: 'HIGH' as const, evidenceSchemaId: 'v1.code-indicator', cweIds: ['CWE-95'] };
    const jsCapability = { ...capability, id: 'javascript-security', required: false, dependsOn: ['source-normalization'], ruleIds: [jsRule.ruleId] };
    const rules = new Map([[jsRule.ruleId, jsRule]]);
    const properties = (indicator: string, start: number) => ({ language: 'JAVASCRIPT', indicator, start, end: start + 1, parseState: 'VERIFIED' });
    const first = fact(undefined, 'code.indicator.v2', properties('EVAL', 0));
    const second = fact(undefined, 'code.indicator.v2', properties('FUNCTION_CONSTRUCTOR', 5));
    const candidate = { ...empty(), facts: [first, second], findings: [finding(jsRule.ruleId, [first.factId]), finding(jsRule.ruleId, [second.factId])] };
    expect(validateCapabilityCandidate(candidate, jsCapability, { facts, rules }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });

    const overCap = validateCapabilityCandidate(candidate, jsCapability, { facts, rules }, { ...DEFAULT_SCANNER_LIMITS_V2, maxFindings: 1 });
    // There is no truncation path: the snapshot is refused whole, so a caller can never keep a
    // complete-looking `omitted: 0` while the validator quietly drops evidence.
    expect(overCap).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' });
    expect(overCap.ok === false && overCap.counters).toEqual({ seen: 0, analyzed: 0, skipped: 0, omitted: 0 });
  });

  it('rejects capability and rule accessors without invoking them', () => {
    let invoked = false; const badCapability = { ...capability };
    Object.defineProperty(badCapability, 'id', { get: () => { invoked = true; throw new Error('secret'); } });
    expect(validateCapabilityCandidate(empty(), badCapability, registries, DEFAULT_SCANNER_LIMITS_V2).ok).toBe(false);
    const badRule = { ...rule }; Object.defineProperty(badRule, 'revision', { get: () => { invoked = true; throw new Error('secret'); } });
    expect(validateCapabilityCandidate(empty(), capability, { facts, rules: new Map([[rule.ruleId, badRule]]) }, DEFAULT_SCANNER_LIMITS_V2).ok).toBe(false);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    expect(validateCapabilityCandidate(empty(), capability, registries, DEFAULT_SCANNER_LIMITS_V2).ok).toBe(true);
    expect(clone).not.toHaveBeenCalled(); clone.mockRestore();
    expect(invoked).toBe(false);
  });

  it('admits a valid candidate without consulting Reflect.ownKeys', () => {
    const ownKeys = vi.spyOn(Reflect, 'ownKeys').mockImplementation(() => { throw new Error('Reflect.ownKeys must not run'); });
    try { expect(validateCapabilityCandidate(empty(), capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true }); } finally { ownKeys.mockRestore(); }
  });
  it('rejects hostile limits without invoking ownKeys for a branded candidate', () => {
    let ownKeysCalls = 0;
    const hostileLimits = new Proxy({}, {
      ownKeys: () => {
        ownKeysCalls += 1;
        return Array.from({ length: 100_000 }, (_, index) => `k${index}`);
      },
    });
    const result = validateRawCandidate(admit(empty()), capability, registries, hostileLimits as typeof DEFAULT_SCANNER_LIMITS_V2);
    expect(ownKeysCalls).toBe(0);
    expect(result).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
  });
  it('requires maxSourceWork in the closed candidate limits snapshot', () => {
    const limits = { ...DEFAULT_SCANNER_LIMITS_V2 } as Record<string, unknown>;
    delete limits.maxSourceWork;
    expect(validateCapabilityCandidate(admit(empty()), capability, registries, limits as never)).toMatchObject({
      ok: false, reason: 'UNSAFE_INPUT',
    });
    expect(validateCapabilityCandidate(admit(empty()), capability, registries, {
      ...DEFAULT_SCANNER_LIMITS_V2, maxSourceWork: 0,
    })).toMatchObject({ ok: true });
  });
  it('does not materialize unbounded own-name or symbol collections', () => {
    const target = admit(empty()); const getNames = Object.getOwnPropertyNames; const getSymbols = Object.getOwnPropertySymbols;
    const names = vi.spyOn(Object, 'getOwnPropertyNames').mockImplementation((input) => { if (input === target) throw new Error('unbounded names'); return getNames(input); });
    const symbols = vi.spyOn(Object, 'getOwnPropertySymbols').mockImplementation((input) => { if (input === target) throw new Error('unbounded symbols'); return getSymbols(input); });
    try { expect(validateCapabilityCandidate(target, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true }); } finally { names.mockRestore(); symbols.mockRestore(); }
  });
  it('rejects non-enumerable and symbol-keyed extras on capability and registry authority', () => {
    const extraCandidate = { ...empty() } as Record<string | symbol, unknown>;
    Object.defineProperty(extraCandidate, 'hidden', { value: 'candidate-secret' });
    expect(validateRawCandidate(extraCandidate as never, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });

    const symbolCandidate = { ...empty() } as Record<string | symbol, unknown>;
    Object.defineProperty(symbolCandidate, Symbol('hidden'), { value: 'candidate-secret' });
    expect(validateRawCandidate(symbolCandidate as never, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });

    const extraCapability = { ...capability } as Record<string | symbol, unknown>;
    Object.defineProperty(extraCapability, 'hidden', { value: 'candidate-secret' });
    expect(validateCapabilityCandidate(empty(), extraCapability as never, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNKNOWN_KEY' });

    const symbolCapability = { ...capability } as Record<string | symbol, unknown>;
    Object.defineProperty(symbolCapability, Symbol('hidden'), { value: 'candidate-secret' });
    expect(validateCapabilityCandidate(empty(), symbolCapability as never, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });

    const extraRegistries = { ...registries } as Record<string | symbol, unknown>;
    Object.defineProperty(extraRegistries, 'hidden', { value: 'candidate-secret' });
    expect(validateCapabilityCandidate(empty(), capability, extraRegistries as never, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNKNOWN_KEY' });

    const symbolRegistries = { ...registries } as Record<string | symbol, unknown>;
    Object.defineProperty(symbolRegistries, Symbol('hidden'), { value: 'candidate-secret' });
    expect(validateCapabilityCandidate(empty(), capability, symbolRegistries as never, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
  });
  it('rejects hidden and symbol-keyed properties attached to the rule authority map', () => {
    const hiddenRules = new Map(registries.rules);
    Object.defineProperty(hiddenRules, 'hidden', { value: 'candidate-secret' });
    expect(validateCapabilityCandidate(empty(), capability, { facts, rules: hiddenRules }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false });

    const symbolRules = new Map(registries.rules);
    Object.defineProperty(symbolRules, Symbol('hidden'), { value: 'candidate-secret' });
    expect(validateCapabilityCandidate(empty(), capability, { facts, rules: symbolRules }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false });
  });
  it('rejects a non-plain candidate before inspecting nested values', () => {
    let inspected = false;
    const nested = new Proxy([], { getPrototypeOf: () => { inspected = true; throw new Error('nested'); } });
    const candidate = Object.assign(Object.create({ inherited: true }), { ...empty(), facts: nested });
    expect(validateRawCandidate(candidate, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
    expect(inspected).toBe(false);
  });
  it('rejects a forwarding proxy before value or own-key traps', () => {
    let trapCalls = 0;
    const target = empty();
    const forwarding = new Proxy(target, {
      get: () => { trapCalls += 1; throw new Error('value trap'); },
      ownKeys: () => { trapCalls += 1; return Array.from({ length: 100_000 }, (_, index) => `k${index}`); },
    });
    expect(validateRawCandidate(forwarding, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
    expect(trapCalls).toBe(0);
  });
  it('preflights complete evidence payloads before encoding large lists or diagnostics', () => {
    const evidence = new TextEncoder().encode(canonicalizeJson(evidenceShape(empty()))).length;
    const labels = Array.from({ length: 4_096 }, () => 'WEBHOOK_BODY');
    const largeFact = fact(undefined, 'dataflow.summary.v2', { flowKind: 'TAINT_SINK', sink: 'SQL', propertyPathComplete: true, humanGatePresent: false, humanGateDominates: false, taintLabels: labels });
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => { throw new Error('evidence materialized'); });
    try { expect(validateCapabilityCandidate({ ...empty(), facts: [largeFact] }, capability, registries, { ...DEFAULT_SCANNER_LIMITS_V2, maxEvidenceBytes: evidence + 64 })).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' }); } finally { encode.mockRestore(); }
  });
  it('preflights escaped canonical bytes and preserves exact max/max-plus-one admission', () => {
    const escapedSource = { ...nodeSource, pointer: '/"' };
    const escapedSubject = { kind: 'NODE' as const, node: { ...nodeSubject.node, source: escapedSource } };
    const escapedFact = { ...fact(), subject: escapedSubject };
    const candidate = { ...empty(), facts: [escapedFact] } as unknown as CapabilityCandidateV2;
    const evidence = new TextEncoder().encode(canonicalizeJson(evidenceShape(candidate))).length;
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => { throw new Error('evidence materialized'); });
    try { expect(validateCapabilityCandidate(candidate, capability, registries, { ...DEFAULT_SCANNER_LIMITS_V2, maxEvidenceBytes: evidence - 1 })).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' }); } finally { encode.mockRestore(); }
    expect(validateCapabilityCandidate(candidate, capability, registries, { ...DEFAULT_SCANNER_LIMITS_V2, maxEvidenceBytes: evidence })).toMatchObject({ ok: true });
    expect(validateCapabilityCandidate(candidate, capability, registries, { ...DEFAULT_SCANNER_LIMITS_V2, maxEvidenceBytes: evidence + 1 })).toMatchObject({ ok: true });
  });
  it('preflights large scalar lists and complete finding, trace, and diagnostic payloads before canonical materialization', () => {
    const rejectBeforeEncoding = (candidate: CapabilityCandidateV2, maxEvidenceBytes: number) => {
      const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => { throw new Error('evidence materialized'); });
      try { expect(validateCapabilityCandidate(candidate, capability, registries, { ...DEFAULT_SCANNER_LIMITS_V2, maxEvidenceBytes })).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' }); } finally { encode.mockRestore(); }
    };
    const labels = Array.from({ length: 4_096 }, () => 'WEBHOOK_BODY');
    const listCandidate = { ...empty(), facts: [fact(undefined, 'dataflow.summary.v2', { flowKind: 'TAINT_SINK', sink: 'SQL', propertyPathComplete: true, humanGatePresent: false, humanGateDominates: false, taintLabels: labels })] } as unknown as CapabilityCandidateV2;
    rejectBeforeEncoding(listCandidate, new TextEncoder().encode(canonicalizeJson(evidenceShape(listCandidate))).length - 1);
    const nodeFact = fact();
    const findingCandidate = { ...empty(), facts: [nodeFact], findings: [finding(rule.ruleId, [nodeFact.factId])] } as unknown as CapabilityCandidateV2;
    const steps = [{ ordinal: 0, kind: 'SOURCE' as const, subject: nodeSubject, factRefs: [] as string[] }];
    const trace = { traceId: createCandidateTraceId({ kind: 'CONTROL', steps }), kind: 'CONTROL' as const, steps };
    const classification = classifyDiagnostic('OPTIONAL_LIMIT_EXCEEDED', capability.required);
    const diagnosticIdentity = { code: 'OPTIONAL_LIMIT_EXCEEDED' as const, capabilityId: capability.id, ...classification, observed: 1_234_567_890, maximum: 9_876_543_210, omitted: 4_567_890_123 };
    const diagnostic = { ...diagnosticIdentity, id: createDiagnosticId(diagnosticIdentity) };
    const traceCandidate = { ...empty(), traces: [trace] } as unknown as CapabilityCandidateV2;
    const diagnosticCandidate = { ...empty(), diagnostics: [diagnostic] } as unknown as CapabilityCandidateV2;
    const cases: readonly [CapabilityCandidateV2, number][] = [
      [findingCandidate, new TextEncoder().encode(canonicalizeJson(evidenceShape(findingCandidate))).length - 1],
      [traceCandidate, new TextEncoder().encode(canonicalizeJson(evidenceShape(traceCandidate))).length - 1],
      [diagnosticCandidate, new TextEncoder().encode(canonicalizeJson(evidenceShape(diagnosticCandidate))).length - 1],
    ];
    for (const [candidate, maxEvidenceBytes] of cases) rejectBeforeEncoding(candidate, maxEvidenceBytes);
  });
  it('charges nested diagnostic locations before canonical materialization', () => {
    const classification = classifyDiagnostic('SOURCE_SPAN_UNAVAILABLE', capability.required);
    const location = { pointer: '/nested', occurrencePath: [1], astNodeId: digest('c'), span: null };
    const identity = { code: 'SOURCE_SPAN_UNAVAILABLE' as const, capabilityId: capability.id, ...classification, location };
    const diagnostic = { ...identity, id: createDiagnosticId(identity) };
    const candidate = { ...empty(), diagnostics: [diagnostic] } as unknown as CapabilityCandidateV2;
    const exact = new TextEncoder().encode(canonicalizeJson(evidenceShape(candidate))).length;
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => { throw new Error('diagnostic evidence materialized'); });
    try {
      expect(validateCapabilityCandidate(admit(candidate), capability, registries, { ...DEFAULT_SCANNER_LIMITS_V2, maxEvidenceBytes: exact - 1 })).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' });
    } finally {
      encode.mockRestore();
    }
  });
  it('charges nested source and target node evidence before canonical materialization', () => {
    const nodeFact = fact();
    const edgeFinding = { ...finding(rule.ruleId, [nodeFact.factId]), subject: edgeSubject };
    const candidate = { ...empty(), facts: [nodeFact], findings: [edgeFinding] } as unknown as CapabilityCandidateV2;
    const exact = new TextEncoder().encode(canonicalizeJson(evidenceShape(candidate))).length;
    const originalEncode = TextEncoder.prototype.encode;
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: InstanceType<typeof TextEncoder>, input = '') { if (input.includes('findings')) throw new Error('edge evidence materialized'); return originalEncode.call(this, input); });
    try {
      expect(validateCapabilityCandidate(admit(candidate), capability, registries, { ...DEFAULT_SCANNER_LIMITS_V2, maxEvidenceBytes: exact - 1 })).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' });
    } finally {
      encode.mockRestore();
    }
  });
  it('guards structural preflight against cycles, deep nesting, sparse arrays, and cap-plus-one work', () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    const cyclicFact = { factId: digest('f'), kind: 'dataflow.summary.v2', subject: sourceSubject, properties: { flowKind: 'TAINT_SINK', sink: 'SQL', propertyPathComplete: true, humanGatePresent: false, humanGateDominates: false, taintLabels: cycle } };
    expect(validateCapabilityCandidate({ ...empty(), facts: [cyclicFact] }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
    let deep: unknown = 'WEBHOOK_BODY';
    for (let index = 0; index < 10_000; index += 1) deep = [deep];
    const deepFact = { factId: digest('d'), kind: 'dataflow.summary.v2', subject: sourceSubject, properties: { flowKind: 'TAINT_SINK', sink: 'SQL', propertyPathComplete: true, humanGatePresent: false, humanGateDominates: false, taintLabels: deep } };
    expect(validateCapabilityCandidate({ ...empty(), facts: [deepFact] }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
    const sparse = new Array(1);
    expect(validateCapabilityCandidate({ ...empty(), facts: sparse }, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
    const cap = { ...DEFAULT_SCANNER_LIMITS_V2, maxEvidenceBytes: 1 };
    expect(validateCapabilityCandidate({ ...empty(), facts: [fact()] }, capability, registries, cap)).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' });
  });
  it('closes capability metadata and requires exactly its registered rules', () => {
    expect(validateCapabilityCandidate(empty(), { ...capability, id: 'forged-capability' }, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
    expect(validateCapabilityCandidate(empty(), { ...capability, dependsOn: ['source-normalization', 'unknown'] }, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
    expect(validateCapabilityCandidate(empty(), capability, { facts, rules: new Map() }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
    const extra = { ...rule, ruleId: 'N8N_CODE_NODE', capabilityId: 'structural-policies', evidenceSchemaId: 'v1.node-type', cweIds: ['CWE-94'], severity: 'LOW' as const };
    const mixedRules = new Map<string, typeof rule | typeof extra>([[rule.ruleId, rule], [extra.ruleId, extra]]);
    expect(validateCapabilityCandidate(empty(), capability, { facts, rules: mixedRules }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
  });

  it('rejects missing or extra authenticated dependencies', () => {
    expect(validateCapabilityCandidate(empty(), { ...exactStructural, dependsOn: [] }, { facts, rules: exactStructuralRules }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
    expect(validateCapabilityCandidate(empty(), { ...exactStructural, dependsOn: [...exactStructural.dependsOn, 'unknown'] }, { facts, rules: exactStructuralRules }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
  });

  it('rejects unknown capability versions and incomplete declared rule maps', () => {
    expect(validateCapabilityCandidate(empty(), { ...exactStructural, id: 'unknown-capability' }, { facts, rules: exactStructuralRules }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
    expect(validateCapabilityCandidate(empty(), { ...exactStructural, version: '9.9.9' }, { facts, rules: exactStructuralRules }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
    const incompleteRuleIds = [exactStructural.ruleIds[0]];
    const incomplete = new Map([[incompleteRuleIds[0], exactStructuralRules.get(incompleteRuleIds[0])!]]);
    expect(validateCapabilityCandidate(empty(), { ...exactStructural, ruleIds: incompleteRuleIds }, { facts, rules: incomplete }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'MALFORMED_CANDIDATE' });
  });

  it('accepts a capability with exact authenticated metadata and complete rules', () => {
    expect(validateCapabilityCandidate(empty(), exactStructural, { facts, rules: exactStructuralRules }, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
  });
  it('rejects diagnostic cap-plus-one before materializing the collection', () => {
    const make = (code: 'SOURCE_SPAN_UNAVAILABLE' | 'DUPLICATE_FINDING_COLLAPSED') => {
      const identity = { code, capabilityId: capability.id, ...classifyDiagnostic(code, capability.required) };
      return { ...identity, id: createDiagnosticId(identity) };
    };
    const diagnostics = [make('SOURCE_SPAN_UNAVAILABLE'), make('DUPLICATE_FINDING_COLLAPSED')];
    const candidate = admit({ ...empty(), diagnostics });
    expect(validateCapabilityCandidate(candidate, capability, registries, { ...DEFAULT_SCANNER_LIMITS_V2, maxDiagnostics: 1 })).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' });
  });
  it('rejects secret-bearing edge labels and reads hostile limits only through descriptors', () => {
    const nodeFact = fact();
    const secretEdgeSubject = { ...edgeSubject, edge: { ...edgeSubject.edge, sourceLabel: 'password: secret' } };
    const candidate = { ...empty(), facts: [nodeFact], findings: [{ ...finding(rule.ruleId, [nodeFact.factId]), subject: secretEdgeSubject }] };
    expect(validateCapabilityCandidate(candidate, capability, registries, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    let invoked = false;
    const hostileLimits = { ...DEFAULT_SCANNER_LIMITS_V2 };
    Object.defineProperty(hostileLimits, 'maxEvidenceBytes', { get: () => { invoked = true; throw new Error('limit-secret'); } });
    expect(validateCapabilityCandidate(admit(empty()), capability, registries, hostileLimits)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
    expect(invoked).toBe(false);
  });
});
