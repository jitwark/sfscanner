import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { ParserOwnedAdmissionBoundaryV2, createCapabilityCandidateAdmissionSnapshotV2 } from '../admission/snapshot';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from '../semantics/builtin-catalogue';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import { resolveAnalyzerSemanticContext } from './semantic-context';
import { candidateFacts, makeFact } from './adapter-evidence';
import { RULE_PACK_DIGEST_V2, validateCapabilityCandidate } from './candidate-validator';
import { BETA_DEFAULT_PROFILE_MANIFEST } from './profile-manifest';
import { betaHardenedRuleCatalog } from '../policy/rule-catalog';
import { SAFE_FACT_EVIDENCE_MAPPINGS_V2, SAFE_FACT_REGISTRY_V2 } from '../facts/safe-fact-registry';
import type { SafeFactV2 } from './scheduler';
import type { ScanFinding } from '../policy/policy';
import type { SourceMemberRefV2 } from '../source/source-types';

const encoder = new TextEncoder();

function fixture(text: string) {
  const parsed = ParserOwnedAdmissionBoundaryV2.fromBoundedBytes(encoder.encode(text), DEFAULT_SCANNER_LIMITS_V2);
  if (!parsed.ok) throw new Error('fixture parser rejected valid workflow');
  const normalized = normalizeSecurityWorkflow(parsed.snapshot, DEFAULT_SCANNER_LIMITS_V2);
  if (!normalized.ok) throw new Error('fixture normalizer rejected valid workflow');
  return { source: parsed.snapshot, workflow: normalized.workflow };
}

function resolve(text: string, options: Readonly<{ required?: boolean }> = {}) {
  const input = fixture(text);
  return resolveAnalyzerSemanticContext({
    source: input.source, workflow: input.workflow,
    catalogue: BUILTIN_SEMANTIC_CATALOGUE_V2,
    capabilityId: 'structural-policies', required: options.required ?? true,
  });
}

// The five-file allowlist puts the destination-v3/coverage admission-cap proof beside the producer
// that emits those facts: this is the exact candidate-validator path the scheduler calls.
const structuralCapability = Object.freeze({
  ...BETA_DEFAULT_PROFILE_MANIFEST.capabilities.find((item) => item.id === 'structural-policies')!,
  run: () => ({ findings: [], diagnostics: [], facts: [], traces: [], seen: 0, analyzed: 0, skipped: 0, omitted: 0 }),
});
const factRegistry = { schemaVersion: 'scanner-safe-facts-v2' as const, version: SAFE_FACT_REGISTRY_V2.version, schemas: SAFE_FACT_REGISTRY_V2.schemas, digest: SAFE_FACT_REGISTRY_V2.digest };
const ruleRegistry = new Map(structuralCapability.ruleIds.map((ruleId) => {
  const catalogue = betaHardenedRuleCatalog.find((entry) => entry.policyId === ruleId);
  const mapping = SAFE_FACT_EVIDENCE_MAPPINGS_V2.find((entry) => entry.ruleId === ruleId);
  if (!catalogue || !mapping) throw new Error(`incomplete rule authority for ${ruleId}`);
  return [ruleId, { ruleId, revision: '1', capabilityId: 'structural-policies', effect: 'SCORING' as const, severity: catalogue.defaultSeverity, confidence: catalogue.defaultConfidence, evidenceSchemaId: mapping.evidenceSchemaId, remediationId: 'r', cweIds: [...catalogue.cweIds], owaspAgenticIds: [...(catalogue.owaspAgenticIds ?? [])], packDigest: RULE_PACK_DIGEST_V2 }];
}));
function admitFacts(facts: readonly SafeFactV2[], limits = DEFAULT_SCANNER_LIMITS_V2) {
  return validateCapabilityCandidate(
    createCapabilityCandidateAdmissionSnapshotV2({ findings: [], diagnostics: [], facts: [...facts], traces: [], seen: 0, analyzed: 0, skipped: 0, omitted: 0 }),
    structuralCapability, { facts: factRegistry, rules: ruleRegistry }, limits, 0,
  );
}
const destinationV3 = (source: SourceMemberRefV2) => makeFact('destination.v3', { kind: 'SOURCE', source }, {
  parameterPath: '/url', scheme: 'HTTPS', hostname: 'example.test', authorityState: 'KNOWN', valueMode: 'LITERAL',
  reason: 'NONE', omitted: 0, inventoryStatus: 'COMPLETE',
});
const coverageFact = (errors: number) => makeFact('destination.coverage.v1', { kind: 'WORKFLOW' }, {
  inventoryStatus: errors === 0 ? 'COMPLETE' : 'UNKNOWN', nodesExamined: 1, pathsConfigured: 1,
  recordsEmitted: 1, errors, omitted: errors, errorCodes: errors === 0 ? [] : ['MISSING_PATH'],
});

describe('semantic context resolver', () => {
  it('preserves destination parameter paths and source identity', () => {
    const input = fixture('{"nodes":[{"type":"n8n-nodes-base.httpRequest","typeVersion":1,"parameters":{"url":"https://example.test/path"}}],"connections":{}}');
    const context = resolveAnalyzerSemanticContext({
      source: input.source,
      workflow: input.workflow,
      catalogue: BUILTIN_SEMANTIC_CATALOGUE_V2,
      capabilityId: 'structural-policies',
      required: true,
    });
    const destination = context.facts.find((fact) => fact.kind === 'destination.v2');
    const expectedSource = input.workflow.nodes[0]!.parameters.find((field) => field.pointer === '/nodes/0/parameters/url')!.occurrences[0]!;
    expect(destination).toMatchObject({
      kind: 'destination.v2',
      properties: expect.objectContaining({ parameterPath: '/url' }),
      subject: expect.objectContaining({
        kind: 'SOURCE',
        source: expect.objectContaining({ pointer: '/nodes/0/parameters/url' }),
      }),
    });
    expect(destination?.subject).toEqual({ kind: 'SOURCE', source: expectedSource });
  });

  it('emits destination.v3 beside the legacy v2 fact and one coverage fact', () => {
    const context = resolve('{"nodes":[{"type":"n8n-nodes-base.httpRequest","typeVersion":1,"parameters":{"url":"https://example.test/path"}}],"connections":{}}');
    const legacy = context.facts.filter((fact) => fact.kind === 'destination.v2');
    const current = context.facts.filter((fact) => fact.kind === 'destination.v3');
    const coverage = context.facts.filter((fact) => fact.kind === 'destination.coverage.v1');
    expect(legacy).toHaveLength(1);
    expect(current).toHaveLength(1);
    expect(current[0]!.subject).toEqual(legacy[0]!.subject);
    expect(current[0]!.properties).toMatchObject({
      parameterPath: '/url', scheme: 'HTTPS', hostname: 'example.test', authorityState: 'KNOWN', valueMode: 'LITERAL',
      reason: 'NONE', omitted: 0, inventoryStatus: 'COMPLETE',
    });
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.subject).toEqual({ kind: 'WORKFLOW' });
    expect(coverage[0]!.properties).toEqual({ inventoryStatus: 'COMPLETE', nodesExamined: 1, pathsConfigured: 1, recordsEmitted: 1, errors: 0, omitted: 0, errorCodes: [] });
    expect(JSON.stringify(context)).not.toContain('example.test/path');
  });

  it('keeps a dynamic destination UNKNOWN in v3 and never invents a host', () => {
    const context = resolve('{"nodes":[{"type":"n8n-nodes-base.httpRequest","typeVersion":1,"parameters":{"url":"={{$json.target}}"}}],"connections":{}}');
    const current = context.facts.find((fact) => fact.kind === 'destination.v3');
    expect(current?.properties).toMatchObject({ valueMode: 'DYNAMIC', reason: 'DYNAMIC', omitted: 1, authorityState: 'UNKNOWN', hostname: null });
    expect(context.facts.some((fact) => fact.kind === 'destination.v2')).toBe(true);
    const coverage = context.facts.find((fact) => fact.kind === 'destination.coverage.v1');
    expect(coverage?.properties).toMatchObject({ omitted: 1, errors: 0, errorCodes: [] });
  });

  it('reconciles coverage counts with a missing configured path', () => {
    const context = resolve('{"nodes":[{"type":"n8n-nodes-base.httpRequest","typeVersion":1,"parameters":{"method":"GET"}}],"connections":{}}');
    const current = context.facts.find((fact) => fact.kind === 'destination.v3');
    const coverage = context.facts.find((fact) => fact.kind === 'destination.coverage.v1');
    expect(current?.properties).toMatchObject({ parameterPath: '/url', reason: 'MISSING_PATH', omitted: 1, inventoryStatus: 'UNKNOWN' });
    expect(coverage?.properties).toEqual({ inventoryStatus: 'UNKNOWN', nodesExamined: 1, pathsConfigured: 1, recordsEmitted: 1, errors: 1, omitted: 1, errorCodes: ['MISSING_PATH'] });
  });

  it('reports a destination value above the admission cap as explicit unsafe coverage', () => {
    const text = JSON.stringify({ nodes: [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 1, parameters: { url: `https://example.test/${'a'.repeat(16_384)}` } }], connections: {} });
    const context = resolve(text);
    const coverage = context.facts.find((fact) => fact.kind === 'destination.coverage.v1');
    expect(coverage?.properties).toEqual({ inventoryStatus: 'UNSAFE_INPUT', nodesExamined: 0, pathsConfigured: 0, recordsEmitted: 0, errors: 1, omitted: 1, errorCodes: ['UNSAFE_INPUT'] });
    expect(context.facts.some((fact) => fact.kind === 'destination.v3')).toBe(false);
  });

  it('reports a node without semantics as an explicit coverage omission', () => {
    const context = resolve('{"nodes":[{"type":"@example/unknown.node","parameters":"not-an-object"}],"connections":{}}');
    const coverage = context.facts.find((fact) => fact.kind === 'destination.coverage.v1');
    expect(coverage?.properties).toEqual({ inventoryStatus: 'UNKNOWN', nodesExamined: 1, pathsConfigured: 0, recordsEmitted: 0, errors: 1, omitted: 1, errorCodes: ['MISSING_SEMANTICS'] });
  });

  it('emits one zeroed coverage fact for a workflow without destinations', () => {
    const context = resolve('{"nodes":[],"connections":{}}');
    const coverage = context.facts.filter((fact) => fact.kind === 'destination.coverage.v1');
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.properties).toEqual({ inventoryStatus: 'COMPLETE', nodesExamined: 0, pathsConfigured: 0, recordsEmitted: 0, errors: 0, omitted: 0, errorCodes: [] });
  });

  it('deduplicates coverage error codes across records', () => {
    const context = resolve('{"nodes":[{"type":"n8n-nodes-base.httpRequest","typeVersion":1,"parameters":{}},{"type":"n8n-nodes-base.httpRequest","typeVersion":1,"parameters":{}}],"connections":{}}');
    const coverage = context.facts.find((fact) => fact.kind === 'destination.coverage.v1');
    expect(coverage?.properties).toEqual({ inventoryStatus: 'UNKNOWN', nodesExamined: 2, pathsConfigured: 2, recordsEmitted: 2, errors: 2, omitted: 2, errorCodes: ['MISSING_PATH'] });
  });

  it('applies the destination.v2/v3 per-fact cap and the one-fact coverage cap', () => {
    const source = fixture('{"nodes":[{"type":"n8n-nodes-base.httpRequest","typeVersion":1,"parameters":{"url":"https://example.test/path"}}],"connections":{}}').workflow.nodes[0]!.ref.source;
    const legacy = makeFact('destination.v2', { kind: 'SOURCE', source }, { parameterPath: '/url', scheme: 'HTTPS', hostname: 'example.test', authorityState: 'KNOWN', valueMode: 'LITERAL' });
    const noFindings = { ...DEFAULT_SCANNER_LIMITS_V2, maxFindings: 0 };
    expect(admitFacts([legacy, destinationV3(source)], noFindings)).toMatchObject({ ok: true });
    expect(admitFacts([coverageFact(0)], noFindings)).toMatchObject({ ok: true });
    expect(admitFacts([coverageFact(0), coverageFact(1)], noFindings)).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' });
  });
  it('uses the semantic destination identity for structural domain evidence', () => {
    const input = fixture('{"nodes":[{"type":"n8n-nodes-base.httpRequest","typeVersion":1,"parameters":{"url":"https://example.test/path"}}],"connections":{}}');
    const semantic = resolveAnalyzerSemanticContext({
      source: input.source,
      workflow: input.workflow,
      catalogue: BUILTIN_SEMANTIC_CATALOGUE_V2,
      capabilityId: 'structural-policies',
      required: true,
    });
    const structuralFacts: SafeFactV2[] = [];
    const finding: ScanFinding = {
      policyId: 'UNAPPROVED_DOMAIN',
      title: 'Unapproved domain',
      severity: 'MEDIUM',
      location: {},
      evidence: { domain: 'example.test' },
      message: 'The workflow targets an unapproved domain.',
      explanation: 'The destination domain is not approved by policy.',
      whyItMatters: 'External destinations can expand workflow exposure.',
      possibleImpact: 'Requests may reach an unintended external service.',
      remediation: 'Review the destination against the approved domain list.',
      remediationSteps: ['Confirm the destination is approved.'],
      confidence: 'HIGH',
    };
    candidateFacts(
      finding,
      input.workflow.nodes[0]!,
      structuralFacts,
    );
    const semanticDestination = semantic.facts.find((fact) => fact.kind === 'destination.v2');
    expect(structuralFacts).toHaveLength(1);
    expect(structuralFacts[0]).toEqual(semanticDestination);
  });


  it('maps an unreadable node to catalogue misses at the caller requiredness', () => {
    const text = '{"nodes":[{"type":"@example/unknown.node","parameters":"not-an-object"}],"connections":{}}';
    const required = resolve(text, { required: true });
    const optional = resolve(text, { required: false });
    expect(required.diagnostics).toEqual([expect.objectContaining({ code: 'SEMANTIC_CATALOGUE_MISS', aggregateEffect: 'INDETERMINATE', assessmentEligible: false, location: expect.objectContaining({ pointer: '/nodes/0' }) })]);
    expect(optional.diagnostics).toEqual([expect.objectContaining({ code: 'SEMANTIC_CATALOGUE_MISS', aggregateEffect: 'DEGRADED', assessmentEligible: true })]);
  });

  it('covers a readable unmodelled node with both degraded fallback diagnostics at any requiredness', () => {
    const text = '{"nodes":[{"type":"@example/unknown.node","parameters":{"apiKey":"x"}}],"connections":{}}';
    const expected = [
      expect.objectContaining({ code: 'SEMANTIC_CATALOGUE_MISS', category: 'CATALOGUE', aggregateEffect: 'DEGRADED', assessmentEligible: true, location: expect.objectContaining({ pointer: '/nodes/0' }) }),
      expect.objectContaining({ code: 'GENERIC_NODE_UNMODELED_CAPABILITY', category: 'CATALOGUE', aggregateEffect: 'DEGRADED', assessmentEligible: true, location: expect.objectContaining({ pointer: '/nodes/0' }) }),
    ];
    expect(resolve(text, { required: true }).diagnostics).toEqual(expected);
    expect(resolve(text, { required: false }).diagnostics).toEqual(expected);
  });

  it('copies, freezes, and canonically orders all emitted context', () => {
    const first = resolve('{"nodes":[{"type":"@example/unknown.node","parameters":{}}],"connections":{}}');
    const second = resolve('{"nodes":[{"type":"@example/unknown.node","parameters":{}}],"connections":{}}');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.facts)).toBe(true);
    expect(Object.isFrozen(first.diagnostics)).toBe(true);
    for (const fact of first.facts) {
      expect(Object.isFrozen(fact)).toBe(true);
      expect(Object.isFrozen(fact.subject)).toBe(true);
      expect(Object.isFrozen(fact.properties)).toBe(true);
    }
  });
});
