import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { parseSourceDocument } from '../source/source-parser';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import { betaHardenedRuleCatalog } from '../policy/rule-catalog';
import { BETA_DEFAULT_PROFILE_MANIFEST } from './profile-manifest';
import type { AnalyzerContextV2, CapabilityCandidateV2 } from './scheduler';
import { adaptDiagnostic, unknownRuleDiagnostic } from './adapter-evidence';
import type { AnalysisDiagnostic } from '../policy/policy';
import { createBetaDefaultPolicies } from '../policies/beta-policies';
import { createBetaDefaultCapabilityRegistry, scanCapabilitiesV2 } from './beta-default';
import { RULE_PACK_DIGEST_V2 } from './candidate-validator';

const encoder = new TextEncoder();
const rules = new Map(betaHardenedRuleCatalog.map((entry) => [entry.policyId, {
  ruleId: entry.policyId, revision: '1', capabilityId: entry.policyId.startsWith('N8N_') || entry.policyId.startsWith('RAW_') || entry.policyId === 'UNAPPROVED_DOMAIN' || entry.policyId === 'UNKNOWN_NODE_PACKAGE' || entry.policyId === 'WEBHOOK_EXPOSURE' ? 'structural-policies' : entry.policyId === 'JAVASCRIPT_DYNAMIC_EXECUTION' ? 'javascript-security' : entry.policyId === 'PYTHON_DYNAMIC_EXECUTION' ? 'python-security' : entry.policyId === 'AI_AGENT_UNGATED_TOOL' ? 'agentic-control' : 'taint-integrity', effect: entry.policyEffect === 'REPORT_ONLY' ? 'REPORT_ONLY' as const : 'SCORING' as const, severity: entry.defaultSeverity, confidence: entry.defaultConfidence, evidenceSchemaId: entry.policyId.startsWith('N8N_') ? 'v1.node-type' : entry.policyId === 'RAW_AUTH_HEADER' ? 'v1.auth-header' : entry.policyId === 'RAW_SECRET_INDICATOR' ? 'v1.secret-indicator' : entry.policyId === 'UNAPPROVED_DOMAIN' ? 'v1.domain' : entry.policyId === 'UNKNOWN_NODE_PACKAGE' ? 'v1.node-package' : entry.policyId === 'WEBHOOK_EXPOSURE' ? 'v1.webhook-auth' : entry.policyId.includes('DYNAMIC') ? 'v1.code-indicator' : entry.policyId === 'AI_AGENT_UNGATED_TOOL' ? 'v1.agent-control' : 'v1.taint', remediationId: 'r', cweIds: [...entry.cweIds], owaspAgenticIds: [...(entry.owaspAgenticIds ?? [])], packDigest: RULE_PACK_DIGEST_V2,
}]));

function contextFor(text: string): AnalyzerContextV2 {
  const parsed = parseSourceDocument(encoder.encode(text), DEFAULT_SCANNER_LIMITS_V2);
  if (!parsed.ok) throw new Error('source fixture failed');
  const normalized = normalizeSecurityWorkflow(parsed.document, DEFAULT_SCANNER_LIMITS_V2);
  if (!normalized.ok) throw new Error('workflow fixture failed');
  return {
    source: parsed.document, workflow: normalized.workflow, limits: DEFAULT_SCANNER_LIMITS_V2,
    target: { schemaVersion: 'scanner-target-v3', edition: 'COMMUNITY', deployment: 'SELF_HOSTED', role: 'OWNER', taskRunner: 'NATIVE', communityPackages: [], configuration: [], contextDigest: 'c'.repeat(64) },
    semantics: { id: 'semantics', version: '1', digest: 's'.repeat(64), resolvedNodeSemantics: new Map() },
    rules: { id: 'rules', version: '1', digest: 'r'.repeat(64), rules }, priorOutcomes: new Map(),
  };
}

const candidateShape = (candidate: CapabilityCandidateV2) => ({ findings: candidate.findings, facts: candidate.facts, traces: candidate.traces, diagnostics: candidate.diagnostics });

describe('beta-default capability adapter', () => {
  it('owns all v1 rules once and emits closed structural candidates', () => {
    const result = scanCapabilitiesV2(contextFor('{"name":"demo","nodes":[{"id":"exec","name":"Exec","type":"n8n-nodes-base.executeCommand","parameters":{}}],"connections":{}}'));
    expect(result.executions.map(({ id, status }) => ({ id, status }))).toEqual(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map(({ id }) => ({ id, status: 'COMPLETED' })));
    expect(result.candidates).toHaveLength(5);
    const structural = result.candidates[2];
    expect(structural.findings.map(({ ruleId }) => ruleId)).toEqual(['N8N_EXECUTE_COMMAND']);
    expect(structural.facts.some(({ kind }) => kind === 'node.capability.v2')).toBe(true);
    expect(Object.isFrozen(structural)).toBe(true);
    expect(Object.isFrozen(structural.findings)).toBe(true);
    expect(JSON.stringify(candidateShape(structural))).not.toContain('secret');
  });

  it('isolates a throwing policy and retains a safe prior candidate', () => {
    const policies = [{ id: 'N8N_EXECUTE_COMMAND', name: 'throw', description: 'throw', evaluate: () => { throw new Error('policy-secret'); } }];
    const result = scanCapabilitiesV2(contextFor('{"nodes":[],"connections":{}}'), BETA_DEFAULT_PROFILE_MANIFEST, createBetaDefaultCapabilityRegistry({ policies }));
    const structural = result.executions.find(({ id }) => id === 'structural-policies');
    // The policy failed, so the capability recorded an omission and publishes the degraded outcome
    // its own counters corroborate rather than a completed one.
    expect(structural).toMatchObject({ status: 'DEGRADED', omitted: 1 });
    expect(JSON.stringify(result)).not.toContain('policy-secret');
  });

  it('never reports a complete scan when an analyzer cap is omitted', () => {
    const result = scanCapabilitiesV2(contextFor('{"nodes":[{"id":"exec","name":"Exec","type":"n8n-nodes-base.executeCommand","parameters":{}}],"connections":{}}'), BETA_DEFAULT_PROFILE_MANIFEST, createBetaDefaultCapabilityRegistry({ maxFindings: 0 }));
    expect(result.candidates[2]?.diagnostics).toHaveLength(1);
    expect(result.candidates[2]?.omitted).toBe(1);
    // The cap the analyzer recorded is the outcome its own counts corroborate.
    expect(result.executions[2]).toMatchObject({ id: 'structural-policies', status: 'DEGRADED', seen: 1, analyzed: 1, skipped: 0, omitted: 1 });
  });

  it('reports the count row of every capability in the admitted v2 manifest', () => {
    const result = scanCapabilitiesV2(
      contextFor('{"name":"demo","nodes":[{"id":"code","name":"Code","type":"n8n-nodes-base.code","parameters":{"jsCode":"eval(input)"}}],"connections":{}}'),
      BETA_DEFAULT_PROFILE_MANIFEST, createBetaDefaultCapabilityRegistry(),
    );
    expect(result.executions.map(({ id, status, seen, analyzed, skipped, omitted }) => ({ id, status, seen, analyzed, skipped, omitted }))).toEqual([
      { id: 'source-normalization', status: 'COMPLETED', seen: 1, analyzed: 1, skipped: 0, omitted: 0 },
      { id: 'workflow-insights', status: 'COMPLETED', seen: 1, analyzed: 1, skipped: 0, omitted: 0 },
      { id: 'structural-policies', status: 'COMPLETED', seen: 1, analyzed: 1, skipped: 0, omitted: 0 },
      { id: 'assessment', status: 'COMPLETED', seen: 1, analyzed: 1, skipped: 0, omitted: 0 },
      { id: 'presentation-facts', status: 'COMPLETED', seen: 1, analyzed: 1, skipped: 0, omitted: 0 },
    ]);
    // Every published row is the capability's own count record, not a copy of its neighbour's.
    expect(result.candidates).toHaveLength(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.length);
    for (const [index, capability] of BETA_DEFAULT_PROFILE_MANIFEST.capabilities.entries()) {
      const row = result.executions[index]!;
      const candidate = result.candidates[index]!;
      expect([row.seen, row.analyzed, row.skipped, row.omitted], capability.id)
        .toEqual([candidate.seen, candidate.analyzed, candidate.skipped, candidate.omitted]);
    }
  });

  it('is byte-identical across repeated and permuted registry runs', () => {
    const context = contextFor('{"nodes":[{"id":"code","name":"Code","type":"n8n-nodes-base.code","parameters":{"jsCode":"eval(input)"}}],"connections":{}}');
    const registry = createBetaDefaultCapabilityRegistry();
    const first = JSON.stringify(scanCapabilitiesV2(context, BETA_DEFAULT_PROFILE_MANIFEST, registry));
    const permuted = new Map([...registry.entries()].reverse());
    expect(first).toBe(JSON.stringify(scanCapabilitiesV2(context, BETA_DEFAULT_PROFILE_MANIFEST, permuted)));
  });
  it('adapts every structural policy into admitted evidence', () => {
    const text = JSON.stringify({
      nodes: [
        { id: 'command', name: 'Command', type: 'n8n-nodes-base.executeCommand', parameters: {} },
        { id: 'code', name: 'Code', type: 'n8n-nodes-base.code', parameters: {} },
        { id: 'auth', name: 'Auth', type: 'n8n-nodes-base.httpRequest', parameters: { headers: { Authorization: 'Bearer literal' } } },
        { id: 'secret', name: 'Secret', type: 'n8n-nodes-base.set', parameters: { password: 'plain-value' } },
        { id: 'request', name: 'Request', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://blocked.example.test/v1' } },
        { id: 'community', name: 'Community', type: 'community.nodes.custom', parameters: {} },
        { id: 'webhook', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
      ],
      connections: {},
    });
    const policies = createBetaDefaultPolicies({ approvedDomains: ['approved.example.test'] });
    const context = contextFor(text);
    const result = scanCapabilitiesV2(context, BETA_DEFAULT_PROFILE_MANIFEST, createBetaDefaultCapabilityRegistry({ policies }));
    const structural = result.candidates[2];
    expect(result.executions[2]).toMatchObject({ id: 'structural-policies', status: 'COMPLETED', omitted: 0 });
    expect(structural.findings.map(({ ruleId }) => ruleId)).toEqual(expect.arrayContaining([
      'N8N_EXECUTE_COMMAND', 'N8N_CODE_NODE', 'RAW_AUTH_HEADER', 'RAW_SECRET_INDICATOR',
      'UNAPPROVED_DOMAIN', 'UNKNOWN_NODE_PACKAGE', 'WEBHOOK_EXPOSURE',
    ]));
    expect(structural.facts.map(({ kind }) => kind)).toEqual(expect.arrayContaining([
      'node.capability.v2', 'node.configuration.v2', 'destination.v2', 'ingress.v2',
    ]));
    const authFact = structural.facts.find(({ kind, properties }) => kind === 'node.configuration.v2' && properties.observation === 'AUTH_HEADER');
    expect(authFact).toMatchObject({
      subject: { kind: 'SOURCE', source: context.workflow.nodes[2]!.ref.source },
      properties: { observation: 'AUTH_HEADER', header: 'Authorization', literalValue: true },
    });
  });
  it('surfaces an UNKNOWN destination as a policy completeness diagnostic', () => {
    const policies = createBetaDefaultPolicies({ approvedDomains: ['approved.example'] });
    const context = contextFor('{"nodes":[{"id":"http","name":"HTTP","type":"n8n-nodes-base.httpRequest","parameters":{"url":"={{ $json.url }}"}}],"connections":{}}');
    const result = scanCapabilitiesV2(context, BETA_DEFAULT_PROFILE_MANIFEST, createBetaDefaultCapabilityRegistry({ policies }));
    expect(result.candidates[2]?.diagnostics.map(({ code }) => code)).toContain('POLICY_EXECUTION_FAILED');
    expect(result.candidates[2]?.diagnostics[0]).toMatchObject({ code: 'POLICY_EXECUTION_FAILED', aggregateEffect: 'INDETERMINATE' });
  });

  it('publishes the structural summary fact from the canonical workflow', () => {
    const result = scanCapabilitiesV2(contextFor('{"nodes":[{"id":"a","name":"A","type":"n8n-nodes-base.set","parameters":{}}],"connections":{}}'), BETA_DEFAULT_PROFILE_MANIFEST, createBetaDefaultCapabilityRegistry());
    const fact = result.candidates[2]?.facts.find(({ kind }) => kind === 'workflow.structure.v1');
    expect(fact?.properties).toMatchObject({ total: 1, executable: 1, vertices: 1, weakComponents: 1, structuralCycleRank: 0 });
    expect(result.candidates[2]?.facts.find(({ kind }) => kind === 'workflow.dependencies.v1')).toBeDefined();
    expect(result.candidates[2]?.facts.find(({ kind }) => kind === 'workflow.effects.v1')).toBeDefined();
  });

  it('adopts an unapproved-domain fallback source when no URL occurrence matches', () => {
    const basePolicies = createBetaDefaultPolicies({ approvedDomains: ['approved.example.test'] });
    const domainPolicy = basePolicies.find(({ id }) => id === 'UNAPPROVED_DOMAIN');
    expect(domainPolicy).toBeDefined();
    if (!domainPolicy) return;
    const policies = basePolicies.map((policy) => policy.id === domainPolicy.id ? {
      ...policy,
      evaluate: (workflow: Parameters<typeof domainPolicy.evaluate>[0]) => domainPolicy.evaluate(workflow).map((finding) => ({
        ...finding,
        evidence: { ...finding.evidence, domain: 'different.example.test' },
      })),
    } : policy);
    const context = contextFor('{"nodes":[{"id":"request","name":"Request","type":"n8n-nodes-base.httpRequest","parameters":{"url":"https://blocked.example.test/v1"}}],"connections":{}}');
    const result = scanCapabilitiesV2(context, BETA_DEFAULT_PROFILE_MANIFEST, createBetaDefaultCapabilityRegistry({ policies }));
    const structural = result.candidates[2];
    expect(result.executions[2]).toMatchObject({ id: 'structural-policies', status: 'COMPLETED', omitted: 0 });
    expect(structural.facts.find(({ kind }) => kind === 'destination.v2')).toMatchObject({
      properties: { parameterPath: '', scheme: 'UNKNOWN', hostname: 'different.example.test', authorityState: 'KNOWN', valueMode: 'UNKNOWN' },
    });
  });

  it('maps unknown rules to required indeterminate or optional report-only diagnostics', () => {
    const required = unknownRuleDiagnostic(BETA_DEFAULT_PROFILE_MANIFEST.capabilities[2]!);
    const optional = unknownRuleDiagnostic({ id: 'optional-capability', version: '2.0.0', required: false, dependsOn: [], ruleIds: [] });
    expect(required).toMatchObject({ code: 'UNKNOWN_SCORING_RULE', aggregateEffect: 'INDETERMINATE', assessmentEligible: false });
    expect(optional).toMatchObject({ code: 'UNKNOWN_REPORT_ONLY_RULE', aggregateEffect: 'DEGRADED', assessmentEligible: true });
  });

  it('adapts analyzer limits with the required counter triplet', () => {
    const input: AnalysisDiagnostic = { code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' };
    const requiredCapability = BETA_DEFAULT_PROFILE_MANIFEST.capabilities[2]!;
    const required = adaptDiagnostic(input, contextFor('{"nodes":[],"connections":{}}'), requiredCapability);
    const optional = adaptDiagnostic(input, contextFor('{"nodes":[],"connections":{}}'), { ...requiredCapability, id: 'optional-capability', required: false });
    expect(required).toMatchObject({ code: 'REQUIRED_LIMIT_EXCEEDED', observed: 1, maximum: 0, omitted: 1, aggregateEffect: 'INDETERMINATE', assessmentEligible: false });
    expect(optional).toMatchObject({ code: 'OPTIONAL_LIMIT_EXCEEDED', observed: 1, maximum: 0, omitted: 1, aggregateEffect: 'DEGRADED', assessmentEligible: true });
  });

  it('uses UNKNOWN for scoring findings on indeterminate nodes', () => {
    const result = scanCapabilitiesV2(contextFor('{"nodes":[{"id":"exec","name":"Exec","name":"Exec","type":"n8n-nodes-base.executeCommand","parameters":{}}],"connections":{}}'));
    const finding = result.candidates[2]?.findings.find(({ ruleId }) => ruleId === 'N8N_EXECUTE_COMMAND');
    expect(result.executions[2]).toMatchObject({ id: 'structural-policies', status: 'COMPLETED' });
    expect(finding?.conclusion).toBe('UNKNOWN');
  });

  it('does not associate a finding with a node when both selectors are absent', () => {
    const base = createBetaDefaultPolicies()[0]!;
    const policy = {
      ...base,
      evaluate: (workflow: Parameters<typeof base.evaluate>[0]) => base.evaluate(workflow).map((finding) => ({
        ...finding,
        location: { path: '/nodes/0' },
      })),
    };
    const context = contextFor('{"nodes":[{"id":"exec","name":"Exec","type":"n8n-nodes-base.executeCommand","parameters":{}}],"connections":{}}');
    const result = scanCapabilitiesV2(context, BETA_DEFAULT_PROFILE_MANIFEST, createBetaDefaultCapabilityRegistry({ policies: [policy] }));
    expect(result.candidates[2]?.findings).toHaveLength(0);
    expect(result.candidates[2]?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNKNOWN_SCORING_RULE' }),
    ]));
  });
});
