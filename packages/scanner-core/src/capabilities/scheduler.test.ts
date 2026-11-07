import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { BETA_DEFAULT_PROFILE_MANIFEST, BETA_HARDENED_PROFILE_MANIFEST, type ProfileManifestV2 } from './profile-manifest';
import { createDiagnosticId } from '../diagnostics/identity';
import { classifyDiagnostic, type AnalysisDiagnosticV2, type DiagnosticCodeV2 } from '../diagnostics/registry';
import { isParsedSourceDocument } from '../source/source-document-provenance';
import { parseSourceDocument } from '../source/source-parser';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import { validateTargetContextV3 } from '../semantics/target-context';
import { createCapabilityCandidateAdmissionSnapshotV2 } from '../admission/snapshot';
import { SAFE_FACT_EVIDENCE_MAPPINGS_V2 } from '../facts/safe-fact-registry';
import { betaHardenedRuleCatalog } from '../policy/rule-catalog';
import { RULE_PACK_DIGEST_V2 } from './candidate-validator';
import { scheduleCapabilities, type AnalyzerContextV2, type CapabilityCandidateV2, type CapabilityExecutionV2, type CapabilitySpecV2 } from './scheduler';

const emptyCandidate = (count = 1): CapabilityCandidateV2 => createCapabilityCandidateAdmissionSnapshotV2({ findings: [], diagnostics: [], facts: [], traces: [], seen: count, analyzed: count, skipped: 0, omitted: 0 });

function registryFor(manifest: ProfileManifestV2, run: (id: string) => CapabilityCandidateV2): Map<string, CapabilitySpecV2> {
  return new Map(manifest.capabilities.map((capability) => [capability.id, { ...capability, run: () => run(capability.id) }]));
}

function nullPrototypeRegistryFor(manifest: ProfileManifestV2, run: (id: string) => CapabilityCandidateV2): Map<string, CapabilitySpecV2> {
  return new Map(manifest.capabilities.map((capability) => {
    const entry = Object.create(null) as CapabilitySpecV2;
    Object.assign(entry, capability, { run: () => run(capability.id) });
    return [capability.id, entry] as const;
  }));
}

function copyManifest(manifest: ProfileManifestV2, capabilities = manifest.capabilities): ProfileManifestV2 {
  return { ...manifest, capabilities: capabilities.map((capability) => ({ ...capability })) };
}

const schedulerRules = new Map(SAFE_FACT_EVIDENCE_MAPPINGS_V2.map((mapping) => {
  const catalog = betaHardenedRuleCatalog.find((entry) => entry.policyId === mapping.ruleId)!;
  return [mapping.ruleId, {
    ruleId: mapping.ruleId, revision: '1', capabilityId: mapping.ownerCapabilityId,
    effect: mapping.ownerCapabilityId === 'structural-policies' ? 'SCORING' as const : 'REPORT_ONLY' as const,
    severity: catalog.defaultSeverity, confidence: catalog.defaultConfidence, evidenceSchemaId: mapping.evidenceSchemaId,
    remediationId: 'r', cweIds: [...catalog.cweIds], owaspAgenticIds: [...(catalog.owaspAgenticIds ?? [])], packDigest: RULE_PACK_DIGEST_V2,
  }] as const;
}));
const emptyParsedSource = parseSourceDocument(new TextEncoder().encode('{"nodes":[],"connections":{}}'), DEFAULT_SCANNER_LIMITS_V2);
if (!emptyParsedSource.ok) throw new Error('scheduler fixture source must parse');
const emptyNormalizedWorkflow = normalizeSecurityWorkflow(emptyParsedSource.document, DEFAULT_SCANNER_LIMITS_V2);
if (!emptyNormalizedWorkflow.ok) throw new Error('scheduler fixture workflow must normalize');
const context = { source: emptyParsedSource.document, workflow: emptyNormalizedWorkflow.workflow, limits: DEFAULT_SCANNER_LIMITS_V2, rules: { rules: schedulerRules } } as unknown as AnalyzerContextV2;

function diagnostic(code: DiagnosticCodeV2, capabilityId: string): AnalysisDiagnosticV2 {
  const classification = classifyDiagnostic(code, false); const identity = { code, capabilityId, ...classification } as const;
  return Object.freeze({ ...identity, id: createDiagnosticId(identity) });
}

describe('capability scheduler', () => {
  it('fails a required capability that claims zero work for a parser-eligible node', () => {
    const text = '{"nodes":[{"name":"A","type":"n8n-nodes-base.set","parameters":{}}],"connections":{}}';
    const parsed = parseSourceDocument(new TextEncoder().encode(text), DEFAULT_SCANNER_LIMITS_V2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const normalized = normalizeSecurityWorkflow(parsed.document, DEFAULT_SCANNER_LIMITS_V2);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const parsedContext = { ...context, source: parsed.document, workflow: normalized.workflow } as AnalyzerContextV2;
    const result = scheduleCapabilities(parsedContext, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'structural-policies' ? emptyCandidate(0) : emptyCandidate(1)));
    expect(result.executions.find(({ id }) => id === 'structural-policies')).toMatchObject({ status: 'FAILED', seen: 0, analyzed: 0, skipped: 0, omitted: 1 });
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REQUIRED_CAPABILITY_FAILED', capabilityId: 'structural-policies' })]));
    expect(result.candidates).toHaveLength(2);
  });

  it('refuses a capability whose declared rule the admitted catalogue does not carry', () => {
    const invoked: string[] = [];
    const partial = new Map([...schedulerRules].filter(([ruleId]) => ruleId !== 'UNAPPROVED_DOMAIN'));
    const partialContext = { ...context, rules: { rules: partial } } as unknown as AnalyzerContextV2;
    const result = scheduleCapabilities(partialContext, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => { invoked.push(id); return emptyCandidate(1); }));
    // The capability never runs against a catalogue that cannot express its declared rules, so it
    // cannot publish a reduced rule set as if the missing rule had simply not fired.
    expect(invoked).toEqual(['source-normalization', 'workflow-insights']);
    expect(result.executions.find(({ id }) => id === 'structural-policies')).toMatchObject({ status: 'FAILED', seen: 0, analyzed: 0, skipped: 0, omitted: 1 });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNKNOWN_SCORING_RULE', capabilityId: 'structural-policies', aggregateEffect: 'INDETERMINATE', assessmentEligible: false }),
    ]));
    expect(result.diagnostics.filter(({ code }) => code === 'DEPENDENCY_UNAVAILABLE').map(({ capabilityId }) => capabilityId)).toEqual(['assessment', 'presentation-facts']);
    expect(result.candidates).toHaveLength(2);
  });

  it('runs every selected capability in manifest order and retains counters', () => {
    const order: string[] = []; const entries = [...registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => { order.push(id); return emptyCandidate(2); }).entries()].reverse();
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, new Map(entries));
    expect(order).toEqual(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map(({ id }) => id));
    expect(result.executions.map(({ id, status, seen, analyzed, omitted }) => ({ id, status, seen, analyzed, omitted }))).toEqual(
      BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map(({ id }) => ({ id, status: 'COMPLETED', seen: 2, analyzed: 2, omitted: 0 })),
    );
    expect(result.candidates).toHaveLength(5); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.executions[0])).toBe(true); expect(Object.isFrozen(result.executions[0].diagnosticIds)).toBe(true);
  });
  it('schedules every default capability from exact null-prototype registry entries', () => {
    const order: string[] = [];
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, nullPrototypeRegistryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => {
      order.push(id);
      return emptyCandidate(id === 'structural-policies' ? 0 : 1);
    }));

    expect(order).toEqual(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map(({ id }) => id));
    expect(result.executions.map(({ id, status }) => ({ id, status }))).toEqual(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map(({ id }) => ({ id, status: 'COMPLETED' })));
    expect(result.candidates).toHaveLength(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.length);
    expect(result.diagnostics).toEqual([]);
  });
  it('produces byte-identical output for repeated full schedules', () => {
    const entries = [...registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => emptyCandidate(id.length)).entries()].reverse(); const run = () => JSON.stringify(scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, new Map(entries)));
    expect(run()).toBe(run());
  });
  it('does not run a defined but unadmitted hardened manifest', () => {
    const invoked: string[] = [];
    const result = scheduleCapabilities(context, BETA_HARDENED_PROFILE_MANIFEST, registryFor(BETA_HARDENED_PROFILE_MANIFEST, (id) => { invoked.push(id); return emptyCandidate(); }));
    expect(invoked).toEqual([]);
    expect(result.executions.map(({ id, status }) => ({ id, status }))).toEqual(BETA_HARDENED_PROFILE_MANIFEST.capabilities.map(({ id, required }) => ({ id, status: required ? 'FAILED' : 'DEGRADED' })));
    expect(result.candidates).toEqual([]);
  });
  it('does not run a digest-invalid manifest', () => {
    const manifest = { ...BETA_DEFAULT_PROFILE_MANIFEST, digest: '0'.repeat(64) };
    let invoked = 0;
    const result = scheduleCapabilities(context, manifest, registryFor(manifest, () => { invoked += 1; return emptyCandidate(); }));
    expect(invoked).toBe(0);
    expect(result.executions).toHaveLength(manifest.capabilities.length);
    expect(result.executions.every(({ status }) => status === 'FAILED')).toBe(true);
    expect(result.candidates).toEqual([]);
  });
  it('does not run a forward-dependency manifest', () => {
    const manifest = copyManifest(BETA_HARDENED_PROFILE_MANIFEST, BETA_HARDENED_PROFILE_MANIFEST.capabilities.map((capability) => capability.id === 'expression-security'
      ? { ...capability, dependsOn: ['python-security'] }
      : capability));
    let invoked = 0;
    const result = scheduleCapabilities(context, manifest, registryFor(manifest, () => { invoked += 1; return emptyCandidate(); }));
    expect(invoked).toBe(0);
    expect(result.executions.map(({ id }) => id)).toEqual(manifest.capabilities.map(({ id }) => id));
    expect(result.executions.some(({ status }) => status === 'COMPLETED')).toBe(false);
    expect(result.candidates).toEqual([]);
  });
  it('returns a closed deterministic schedule for duplicate capability IDs', () => {
    const first = BETA_DEFAULT_PROFILE_MANIFEST.capabilities[0];
    const manifest = copyManifest(BETA_DEFAULT_PROFILE_MANIFEST, [...BETA_DEFAULT_PROFILE_MANIFEST.capabilities, { ...first }]);
    let invoked = false;
    const registry = registryFor(manifest, () => { invoked = true; return emptyCandidate(); });
    const result = scheduleCapabilities(context, manifest, registry);
    expect(invoked).toBe(false);
    expect(result.executions.map(({ id }) => id)).toEqual(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map(({ id }) => id));
    expect(JSON.stringify(result)).toBe(JSON.stringify(scheduleCapabilities(context, manifest, registry)));
  });
  it('does not echo untrusted capability IDs or versions from invalid manifests', () => {
    const attackerId = 'C:\\private\\source.json';
    const attackerVersion = 'secret-version-token';
    const manifest = copyManifest(BETA_DEFAULT_PROFILE_MANIFEST, BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map((capability, index) => index === 0
      ? { ...capability, id: attackerId, version: attackerVersion }
      : capability));
    const result = scheduleCapabilities(context, manifest, registryFor(manifest, () => emptyCandidate()));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(attackerId);
    expect(serialized).not.toContain(attackerVersion);
    expect(result.executions.map(({ id, version }) => ({ id, version }))).toEqual(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map(({ id, version }) => ({ id, version })));
  });
  it('returns an empty closed schedule for an accessor manifest without touching it', () => {
    let touched = false; let invoked = false;
    const manifest = Object.create(null) as ProfileManifestV2;
    Object.defineProperty(manifest, 'capabilities', { get: () => { touched = true; throw new Error('manifest accessor'); } });
    const result = scheduleCapabilities(context, manifest, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => { invoked = true; return emptyCandidate(); }));
    expect(touched).toBe(false); expect(invoked).toBe(false); expect(result).toEqual({ executions: [], candidates: [], diagnostics: [] });
  });
  it('allows zero node-scoped counters only when the parsed workflow has no nodes', () => {
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => emptyCandidate(id === 'structural-policies' ? 0 : 1)));
    expect(result.executions.map(({ id, status, seen, analyzed, skipped, omitted }) => ({ id, status, seen, analyzed, skipped, omitted }))).toEqual(
      BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map(({ id }) => ({ id, status: 'COMPLETED', seen: id === 'structural-policies' ? 0 : 1, analyzed: id === 'structural-policies' ? 0 : 1, skipped: 0, omitted: 0 })),
    );
    expect(result.candidates.find(({ seen }) => seen === 0)).toEqual({ findings: [], diagnostics: [], facts: [], traces: [], seen: 0, analyzed: 0, skipped: 0, omitted: 0 });
    expect(result.diagnostics).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.candidates.every((candidate) => Object.isFrozen(candidate) && Object.isFrozen(candidate.findings) && Object.isFrozen(candidate.diagnostics) && Object.isFrozen(candidate.facts) && Object.isFrozen(candidate.traces))).toBe(true);
  });
  it('snapshots exact registry specs before runners can poison later selections', () => {
    const registry = registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()); const original = registry.get('workflow-insights')!; let selectedRuns = 0;
    registry.set('workflow-insights', { ...original, run: () => { selectedRuns += 1; return emptyCandidate(); } });
    const source = registry.get('source-normalization')!; registry.set('source-normalization', { ...source, run: () => { registry.set('workflow-insights', { ...original, id: 'poisoned', run: () => { selectedRuns += 100; return emptyCandidate(99); } }); return emptyCandidate(); } });
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registry);
    expect(selectedRuns).toBe(1); expect(result.executions.find(({ id }) => id === 'workflow-insights')).toMatchObject({ status: 'COMPLETED', seen: 1 });
  });
  it('isolates failures, skips unavailable dependents, and preserves prior safe candidates', () => {
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => { if (id === 'workflow-insights') throw new Error('secret=C:\\private\\source.json'); return emptyCandidate(); }));
    const byId = new Map(result.executions.map((execution) => [execution.id, execution]));
    expect(byId.get('source-normalization')).toMatchObject({ status: 'COMPLETED', omitted: 0 }); expect(byId.get('workflow-insights')).toMatchObject({ status: 'FAILED', omitted: 1 }); expect(byId.get('structural-policies')).toMatchObject({ status: 'COMPLETED', omitted: 0 }); expect(byId.get('assessment')).toMatchObject({ status: 'SKIPPED', skipped: 1, omitted: 1 });
    expect(result.candidates).toHaveLength(2); expect(result.diagnostics.map(({ code }) => code)).toContain('REQUIRED_CAPABILITY_FAILED'); expect(JSON.stringify(result)).not.toContain('private'); expect(JSON.stringify(result)).not.toContain('secret');
    // The first capability's own results survive the second capability's failure intact and complete.
    expect(result.candidates[0]).toEqual({ findings: [], diagnostics: [], facts: [], traces: [], seen: 1, analyzed: 1, skipped: 0, omitted: 0 });
    expect(Object.isFrozen(result.candidates[0])).toBe(true);
    expect(byId.get('workflow-insights')).toMatchObject({ seen: 0, analyzed: 0, skipped: 0, omitted: 1, diagnosticIds: [expect.any(String)] });
  });

  it('fails closed for hardened profiles with required and optional effects', () => {
    let invoked = false;
    const result = scheduleCapabilities(context, BETA_HARDENED_PROFILE_MANIFEST, new Map(BETA_HARDENED_PROFILE_MANIFEST.capabilities.map((capability) => [capability.id, { ...capability, run: () => { invoked = true; return emptyCandidate(); } }])));
    const byId = new Map(result.executions.map((execution) => [execution.id, execution]));
    expect(invoked).toBe(false); expect(byId.get('structural-policies')).toMatchObject({ status: 'FAILED', omitted: 1 }); expect(byId.get('expression-security')).toMatchObject({ status: 'DEGRADED', omitted: 1 }); expect(byId.get('taint-confidentiality')).toMatchObject({ status: 'DEGRADED', omitted: 1 }); expect(result.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining(['REQUIRED_CAPABILITY_FAILED', 'POLICY_EXECUTION_FAILED']));
  });

  it('does not mutate context or registry inputs and freezes nested outputs', () => {
    const registry = registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()); const before = [...registry.keys()]; const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registry);
    expect([...registry.keys()]).toEqual(before); expect(Object.isFrozen(result.candidates[0])).toBe(true); expect(Object.isFrozen(result.candidates[0].findings)).toBe(true); expect(Object.isFrozen(result.diagnostics)).toBe(true);
  });
  it('gives each runner an isolated immutable context view', () => {
    const priorOutcomes = new Map<string, CapabilityExecutionV2>(); const isolatedContext = { ...context, priorOutcomes } as AnalyzerContextV2; let laterTopLevelValue: unknown; let laterMapValue = false;
    const registry = registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()); for (const [id, spec] of registry) registry.set(id, { ...spec, run: (runnerContext) => {
      if (id === 'source-normalization') { expect(Object.isFrozen(runnerContext)).toBe(true); try { (runnerContext as unknown as { poisoned?: string }).poisoned = 'secret'; } catch { /* immutable */ } try { (runnerContext.priorOutcomes as unknown as Map<string, CapabilityExecutionV2>).set('poison', {} as CapabilityExecutionV2); } catch { /* immutable */ } } else if (id === 'workflow-insights') { laterTopLevelValue = (runnerContext as unknown as { poisoned?: string }).poisoned; laterMapValue = runnerContext.priorOutcomes.has('poison'); }
      return emptyCandidate();
    } });
    scheduleCapabilities(isolatedContext, BETA_DEFAULT_PROFILE_MANIFEST, registry);
    expect(laterTopLevelValue).toBeUndefined(); expect(laterMapValue).toBe(false); expect(priorOutcomes.has('poison')).toBe(false);
  });
  it('preserves branded parsed-source identity while isolating other context state', () => {
    const parsed = parseSourceDocument(new TextEncoder().encode('{}'), DEFAULT_SCANNER_LIMITS_V2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const target = { edition: 'COMMUNITY', marker: 'target' };
    const isolatedContext = { ...context, source: parsed.document, target } as unknown as AnalyzerContextV2;
    let receivedSource: unknown;
    let receivedTarget: unknown;
    const registry = registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate(1));
    registry.set('source-normalization', { ...registry.get('source-normalization')!, run: (runnerContext) => {
      receivedSource = runnerContext.source;
      receivedTarget = runnerContext.target;
      return emptyCandidate(1);
    } });

    scheduleCapabilities(isolatedContext, BETA_DEFAULT_PROFILE_MANIFEST, registry);

    expect(receivedSource).toBe(parsed.document);
    expect(isParsedSourceDocument(receivedSource)).toBe(true);
    expect(receivedTarget).not.toBe(target);
    expect(Object.getPrototypeOf(receivedTarget)).toBe(null);
  });
  it('isolates nested context data and blocks intrinsic map mutation', () => {
    const source = emptyParsedSource.document;
    const workflow = { workflowFields: [], nodes: [{ ref: { ordinal: 0, source: { pointer: '/', occurrencePath: [], astNodeId: 'node', span: null }, identityDigest: 'b' }, type: 'test', disabled: false, scoringEligibility: 'ELIGIBLE', marker: 'workflow', parameters: [], credentials: [], settings: [] }], edges: [], ambiguities: [] };
    const target = { edition: 'COMMUNITY', deployment: 'SELF_HOSTED', role: 'OWNER', taskRunner: 'NATIVE', communityPackages: [{ name: 'package', version: '1' }], configuration: [{ key: 'flag', state: 'ENABLED' }], contextDigest: 'c' };
    const limits = { schemaVersion: 'scanner-limits-v2', maxBytes: 1, maxNodes: 1, maxEdges: 1, maxConnectionDepth: 1, maxParameterDepth: 1, maxParameterLeaves: 1, workerDeadlineMs: 1, maxSyntaxNodes: 1, maxDocumentDepth: 1, maxMembersAndElements: 1, maxRawEdges: 1, maxDuplicateKeys: 1, maxDiagnostics: 1, maxStoredSourceSpans: 1, maxSourceWork: 1, maxExpressionTokens: 1, maxCodeSyntaxNodes: 1, maxGraphOperations: 1, maxTaintStates: 1, maxTraceStepsPerFinding: 1, maxFindings: 1, maxRedactionPatches: 1, maxRedactedArtifactBytes: 1, maxEvidenceBytes: DEFAULT_SCANNER_LIMITS_V2.maxEvidenceBytes, maxSerializedResultBytes: 1, maxRuleOperations: 1 };
    const semanticValue = { semanticId: 'semantic-original', nested: { marker: 'semantic' } };
    const ruleValue = { ruleId: 'rule-original', nested: { marker: 'rule' } };
    const priorValue = { id: 'prior', nested: { marker: 'prior' } };
    const resolvedNodeSemantics = new Map([['semantic', semanticValue]]);
    const rules = new Map([['rule', ruleValue]]);
    const priorOutcomes = new Map([['prior', priorValue]]);
    const isolatedContext = { source, workflow, target, limits, semantics: { id: 'semantics', version: '1', digest: 'd', resolvedNodeSemantics }, rules: { id: 'rules', version: '1', digest: 'e', rules }, priorOutcomes } as unknown as AnalyzerContextV2;
    let later: Record<string, unknown> | undefined;
    let mapMutationWasVisible = false;
    const attempt = (mutation: () => void) => { try { mutation(); } catch { /* immutable view */ } };
    const registry = registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate());
    for (const [id, spec] of registry) registry.set(id, { ...spec, run: (runnerContext) => {
      if (id === 'source-normalization') {
        const view = runnerContext as unknown as Record<string, any>;
        attempt(() => { view.source.root.kind = 'STRING'; });
        attempt(() => { view.workflow.nodes[0].marker = 'changed'; });
        attempt(() => { view.target.communityPackages[0].name = 'changed'; });
        attempt(() => { view.limits.maxBytes = 99; });
        attempt(() => { view.semantics.resolvedNodeSemantics.get('semantic').nested.marker = 'changed'; });
        attempt(() => { view.rules.rules.get('rule').nested.marker = 'changed'; });
        attempt(() => { view.priorOutcomes.get('prior').nested.marker = 'changed'; });
        for (const map of [view.semantics.resolvedNodeSemantics, view.rules.rules, view.priorOutcomes]) {
          attempt(() => Map.prototype.set.call(map, 'poison', {}));
          mapMutationWasVisible ||= map.has('poison');
        }
      } else if (id === 'workflow-insights') {
        const view = runnerContext as unknown as Record<string, any>;
        later = { source: view.source.root.kind, workflow: view.workflow.nodes[0].marker, target: view.target.communityPackages[0].name, limit: view.limits.maxBytes, semantic: view.semantics.resolvedNodeSemantics.get('semantic').nested.marker, rule: view.rules.rules.get('rule').nested.marker, prior: view.priorOutcomes.get('prior').nested.marker };
      }
      return emptyCandidate(1);
    } });
    scheduleCapabilities(isolatedContext, BETA_DEFAULT_PROFILE_MANIFEST, registry);
    expect(later).toEqual({ source: 'OBJECT', workflow: 'workflow', target: 'package', limit: 1, semantic: 'semantic', rule: 'rule', prior: 'prior' });
    expect(mapMutationWasVisible).toBe(false);
    expect(source.root.kind).toBe('OBJECT'); expect(workflow.nodes[0].marker).toBe('workflow'); expect(target.communityPackages[0].name).toBe('package'); expect(limits.maxBytes).toBe(1);
    expect(semanticValue.nested.marker).toBe('semantic'); expect(ruleValue.nested.marker).toBe('rule'); expect(priorValue.nested.marker).toBe('prior');
    expect(resolvedNodeSemantics.has('poison')).toBe(false); expect(rules.has('poison')).toBe(false); expect(priorOutcomes.has('poison')).toBe(false);
  });

  it('does not expose shared built-in prototypes through context snapshots', () => {
    const keys = { object: '__wc0202_object_proto__', array: '__wc0202_array_proto__', map: '__wc0202_map_proto__' } as const;
    const payload = { object: { value: 'safe' }, array: ['safe'], map: new Map([['value', 'safe']]) };
    const isolatedContext = { ...context, priorOutcomes: new Map([['payload', payload]]) } as unknown as AnalyzerContextV2;
    let later: Record<keyof typeof keys, unknown> | undefined;
    const registry = registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate(1));
    for (const [id, spec] of registry) registry.set(id, { ...spec, run: (runnerContext) => {
      const view = runnerContext.priorOutcomes.get('payload') as unknown as Record<keyof typeof keys, object> | undefined;
      if (id === 'source-normalization' && view) {
        for (const key of Object.keys(keys) as (keyof typeof keys)[]) {
          const prototype = Object.getPrototypeOf(view[key]);
          if (prototype) Object.defineProperty(prototype, keys[key], { value: true, configurable: true, writable: true });
        }
      } else if (id === 'workflow-insights' && view) {
        later = { object: (Object.getPrototypeOf(view.object) as Record<string, unknown> | null)?.[keys.object], array: (Object.getPrototypeOf(view.array) as Record<string, unknown> | null)?.[keys.array], map: (Object.getPrototypeOf(view.map) as Record<string, unknown> | null)?.[keys.map] };
      }
      return emptyCandidate(1);
    } });
    try {
      scheduleCapabilities(isolatedContext, BETA_DEFAULT_PROFILE_MANIFEST, registry);
    } finally {
      delete (Object.prototype as Record<string, unknown>)[keys.object];
      delete (Array.prototype as unknown as Record<string, unknown>)[keys.array];
      delete (Map.prototype as unknown as Record<string, unknown>)[keys.map];
    }
    expect(later).toEqual({ object: undefined, array: undefined, map: undefined });
  });

  it('does not expose a mutable backing map through forEach callbacks', () => {
    const prior = Object.freeze({ id: 'prior', version: '2.0.0', required: true, status: 'COMPLETED' as const, seen: 0, analyzed: 0, skipped: 0, omitted: 0, diagnosticIds: Object.freeze([]) });
    const priorOutcomes = new Map<string, CapabilityExecutionV2>([[prior.id, prior]]); const isolatedContext = { ...context, priorOutcomes } as AnalyzerContextV2; let mutationWasVisible = false;
    const registry = new Map(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map((capability) => [capability.id, { ...capability, run: (runnerContext: AnalyzerContextV2) => {
      runnerContext.priorOutcomes.forEach((_value, _key, map) => { const mutableMap = map as unknown as Map<string, CapabilityExecutionV2>; mutableMap.set('poison', prior); mutationWasVisible = mutableMap.has('poison'); });
      return emptyCandidate();
    } }]));
    scheduleCapabilities(isolatedContext, BETA_DEFAULT_PROFILE_MANIFEST, registry);
    expect(mutationWasVisible).toBe(false);
    expect(priorOutcomes.has('poison')).toBe(false);
  });

  it('fails closed for context graphs deeper than the snapshot bound', () => {
    const root: { next?: { next?: unknown } } = {}; let cursor: { next?: unknown } = root;
    for (let index = 0; index < 100; index += 1) { const next: { next?: unknown } = {}; cursor.next = next; cursor = next; }
    const hostileContext = { ...context, priorOutcomes: new Map([['deep', root]]) } as unknown as AnalyzerContextV2;
    const result = scheduleCapabilities(hostileContext, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()));
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 });
  });

  it('fails closed for context maps larger than the snapshot bound', () => {
    const oversized = new Map<number, number>(); for (let index = 0; index < 4097; index += 1) oversized.set(index, index);
    const hostileContext = { ...context, priorOutcomes: oversized } as unknown as AnalyzerContextV2;
    const result = scheduleCapabilities(hostileContext, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()));
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 });
  });

  it('fails closed for sparse and extra-property context arrays', () => {
    const sparse = new Array(1);
    const extra = [] as unknown[];
    Object.defineProperty(extra, 'unexpected', { value: 'secret' });
    for (const value of [sparse, extra]) {
      const hostileContext = { ...context, priorOutcomes: new Map([['array', value]]) } as unknown as AnalyzerContextV2;
      const result = scheduleCapabilities(hostileContext, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()));
      expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 });
    }
  });

  it('rejects context arrays with excess own properties before traversing them', () => {
    const oversized = [] as unknown[];
    for (let index = 0; index < 4097; index += 1) Object.defineProperty(oversized, `extra-${index}`, { value: index });
    const hostileContext = { ...context, priorOutcomes: new Map([['array', oversized]]) } as unknown as AnalyzerContextV2;
    const result = scheduleCapabilities(hostileContext, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()));
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 });
  });

  it('rejects cap-plus-one context own-key and symbol collections', () => {
    let touched = false;
    const oversizedObject = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(oversizedObject, 'first', { get: () => { touched = true; return 'secret'; } });
    for (let index = 1; index < 4097; index += 1) Object.defineProperty(oversizedObject, `key-${index}`, { value: index });
    const oversizedSymbols = Object.create(null) as Record<symbol, unknown>;
    for (let index = 0; index < 4097; index += 1) Object.defineProperty(oversizedSymbols, Symbol(`overflow-${index}`), { value: index });
    const oversizedArray = [] as unknown[];
    for (let index = 0; index < 4097; index += 1) Object.defineProperty(oversizedArray, Symbol(`array-overflow-${index}`), { value: index });
    for (const value of [oversizedObject, oversizedSymbols, oversizedArray]) {
      const hostileContext = { ...context, priorOutcomes: new Map([['value', value]]) } as unknown as AnalyzerContextV2;
      const result = scheduleCapabilities(hostileContext, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()));
      expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 });
    }
    expect(touched).toBe(false);
  });

  it('fails closed for callable context entries', () => {
    const callable = () => 'secret';
    const hostileContext = { ...context, priorOutcomes: new Map([['callable', callable]]) } as unknown as AnalyzerContextV2;
    const result = scheduleCapabilities(hostileContext, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()));
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 });
  });

  it('uses intrinsic map traversal instead of a hostile custom iterator', () => {
    const prior = Object.freeze({ id: 'prior', version: '2.0.0', required: true, status: 'COMPLETED' as const, seen: 0, analyzed: 0, skipped: 0, omitted: 0, diagnosticIds: Object.freeze([]) });
    const hostileMap = new Map<string, CapabilityExecutionV2>([[prior.id, prior]]); let iteratorTouched = false; let runnerSawEntry = false;
    Object.defineProperty(hostileMap, Symbol.iterator, { value: () => { iteratorTouched = true; throw new Error('custom iterator must not run'); } });
    const hostileContext = { ...context, priorOutcomes: hostileMap } as AnalyzerContextV2;
    const registry = new Map(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map((capability) => [capability.id, { ...capability, run: (runnerContext: AnalyzerContextV2) => { runnerSawEntry ||= runnerContext.priorOutcomes.has(prior.id); return emptyCandidate(); } }]));
    const result = scheduleCapabilities(hostileContext, BETA_DEFAULT_PROFILE_MANIFEST, registry);
    expect(iteratorTouched).toBe(false);
    expect(runnerSawEntry).toBe(true);
    expect(result.executions[0]).toMatchObject({ status: 'COMPLETED' });
  });

  it('does not admit candidate diagnostics before WC-0203', () => {
    const duplicate = diagnostic('SOURCE_SPAN_UNAVAILABLE', 'source-normalization'); const registry = registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'source-normalization' ? { ...emptyCandidate(), diagnostics: [diagnostic('OPTIONAL_LIMIT_EXCEEDED', id), duplicate, duplicate] } : id === 'structural-policies' ? { ...emptyCandidate(), diagnostics: [diagnostic('DUPLICATE_FINDING_COLLAPSED', id)] } : emptyCandidate());
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registry);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(['REQUIRED_CAPABILITY_FAILED', 'DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE']); expect(result.executions.filter(({ status }) => status === 'FAILED')).toHaveLength(1); expect(result.candidates).toHaveLength(0);
  });

  it('omits nested candidate data without reading proxies or leaking serialization content', () => {
    let touched = false; const hostile = new Proxy(Object.create(null), { get: () => { touched = true; throw new Error('secret source path'); }, getPrototypeOf: () => { touched = true; throw new Error('secret source path'); }, ownKeys: () => { touched = true; throw new Error('secret source path'); }, getOwnPropertyDescriptor: () => { touched = true; throw new Error('secret source path'); } });
    const candidate = { ...emptyCandidate(), findings: [hostile], diagnostics: [hostile] } as unknown as CapabilityCandidateV2; const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'source-normalization' ? candidate : emptyCandidate()));
    expect(touched).toBe(false); expect(result.candidates).toHaveLength(0); expect(result.candidates.every(({ findings, facts, traces, diagnostics }) => findings.length === 0 && facts.length === 0 && traces.length === 0 && diagnostics.length === 0)).toBe(true); expect(result.executions[0]).toMatchObject({ status: 'FAILED', seen: 0, analyzed: 0, skipped: 0, omitted: 1 }); expect(result.diagnostics.map(({ code }) => code)).toEqual(['REQUIRED_CAPABILITY_FAILED', 'DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE']); expect(JSON.stringify(result)).not.toContain('secret'); expect(JSON.stringify(result)).not.toContain('source path'); expect(Object.isFrozen(hostile)).toBe(false);
  });

  it('does not retain orphan candidate diagnostics or shared nested references', () => {
    const shared = { secret: 'candidate-secret' }; const orphan = diagnostic('OPTIONAL_LIMIT_EXCEEDED', 'orphan-capability'); const candidate = { ...emptyCandidate(), findings: [shared], diagnostics: [orphan] } as unknown as CapabilityCandidateV2; const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'source-normalization' ? candidate : emptyCandidate()));
    expect(result.diagnostics.some(({ id }) => id === orphan.id)).toBe(false); expect(result.candidates.some(({ findings }) => findings.length > 0)).toBe(false); expect(JSON.stringify(result)).not.toContain('candidate-secret'); shared.secret = 'mutated-after-scheduling'; expect(JSON.stringify(result)).not.toContain('mutated-after-scheduling');
  });

  it('retains safe counter boundaries and preserves prior counters for runners', () => {
    const prior = Object.freeze({ id: 'source-normalization', version: '2.0.0', required: true, status: 'COMPLETED' as const, seen: Number.MAX_SAFE_INTEGER, analyzed: Number.MAX_SAFE_INTEGER - 1, skipped: 0, omitted: 0, diagnosticIds: Object.freeze([]) }); let receivedPrior: CapabilityExecutionV2 | undefined; const priorOutcomes = new Map([[prior.id, prior]]); const priorContext = { ...context, priorOutcomes } as AnalyzerContextV2;
    const result = scheduleCapabilities(priorContext, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => { if (id === 'workflow-insights') receivedPrior = priorContext.priorOutcomes.get('source-normalization'); return emptyCandidate(Number.MAX_SAFE_INTEGER); }));
    expect(receivedPrior).toBe(prior); expect(result.executions.find(({ id }) => id === 'workflow-insights')).toMatchObject({ seen: Number.MAX_SAFE_INTEGER, analyzed: Number.MAX_SAFE_INTEGER }); expect(result.executions.find(({ id }) => id === 'source-normalization')).toMatchObject({ seen: Number.MAX_SAFE_INTEGER, analyzed: Number.MAX_SAFE_INTEGER }); expect(prior).toMatchObject({ seen: Number.MAX_SAFE_INTEGER, analyzed: Number.MAX_SAFE_INTEGER - 1 });
    const overflow = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'source-normalization' ? emptyCandidate(Number.MAX_SAFE_INTEGER + 1) : emptyCandidate())); expect(overflow.executions[0]).toMatchObject({ status: 'FAILED', seen: 0, analyzed: 0, omitted: 1 });
    const maxPlusOne = { ...emptyCandidate(), findings: new Array(4097) } as CapabilityCandidateV2; const bounded = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'source-normalization' ? maxPlusOne : emptyCandidate())); expect(bounded.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 });
  });
  it('fails closed for hostile empty candidate array shapes', () => {
    const malformed: unknown[][] = [(() => { const value: unknown[] = []; Object.setPrototypeOf(value, {}); return value; })(), (() => { const value: unknown[] = []; Object.defineProperty(value, Symbol('unexpected'), { value: true }); return value; })(), (() => { const value: unknown[] = []; Object.defineProperty(value, 'extra', { value: true }); return value; })()];
    for (const findings of malformed) { const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'source-normalization' ? { ...emptyCandidate(), findings } as unknown as CapabilityCandidateV2 : emptyCandidate())); expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 }); }
  });

  it('rejects cap-plus-one own-key and symbol candidate arrays', () => {
    const extraKeys = [] as unknown[];
    for (let index = 0; index < 4097; index += 1) Object.defineProperty(extraKeys, `overflow-${index}`, { value: index });
    const extraSymbols = [] as unknown[];
    for (let index = 0; index < 4097; index += 1) Object.defineProperty(extraSymbols, Symbol(`overflow-${index}`), { value: index });
    for (const findings of [extraKeys, extraSymbols]) {
      const candidate = { ...emptyCandidate(), findings } as unknown as CapabilityCandidateV2;
      const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'source-normalization' ? candidate : emptyCandidate()));
      expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 });
    }
  });

  it('rejects an unbranded malformed collection before reading counters', () => {
    const findings = [] as unknown[];
    Object.defineProperty(findings, 'unexpected', { value: true });
    const candidate = { ...emptyCandidate(), findings, seen: 7, analyzed: 5, skipped: 2, omitted: 3 } as unknown as CapabilityCandidateV2;
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'source-normalization' ? candidate : emptyCandidate()));
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', seen: 0, analyzed: 0, skipped: 0, omitted: 1 });
  });

  it('rejects an unbranded symbol-bearing candidate before reading counters', () => {
    const candidate = { ...emptyCandidate(), seen: 7, analyzed: 5, skipped: 2, omitted: 3 } as unknown as Record<string, unknown>;
    Object.defineProperty(candidate, Symbol('unexpected'), { value: true });
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'source-normalization' ? candidate as CapabilityCandidateV2 : emptyCandidate()));
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', seen: 0, analyzed: 0, skipped: 0, omitted: 1 });
    expect(result.candidates).toEqual([]);
  });

  it('rejects an unbranded extra-key candidate before reading counters', () => {
    const candidate = { ...emptyCandidate(), seen: 7, analyzed: 5, skipped: 2, omitted: 3, unexpected: 'secret' } as unknown as CapabilityCandidateV2;
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'source-normalization' ? candidate : emptyCandidate()));
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', seen: 0, analyzed: 0, skipped: 0, omitted: 1 });
    expect(result.candidates).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects an unbranded missing-key candidate before reading counters', () => {
    const { findings: _findings, ...withoutFindings } = { ...emptyCandidate(), seen: 7, analyzed: 5, skipped: 2, omitted: 3 };
    const candidate = withoutFindings as unknown as CapabilityCandidateV2;
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'source-normalization' ? candidate : emptyCandidate()));
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', seen: 0, analyzed: 0, skipped: 0, omitted: 1 });
    expect(result.candidates).toEqual([]);
  });
  it('does not mutate a branded runner output', () => {
    const emitted = emptyCandidate(2);
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emitted));
    expect(emitted).toMatchObject({ seen: 2, analyzed: 2, skipped: 0, omitted: 0 });
    expect(Object.isFrozen(emitted)).toBe(true); expect(result.candidates[0]).not.toBe(emitted);
  });
  it('rejects hostile limits without invoking ownKeys', () => {
    let ownKeysCalls = 0; let invoked = false;
    const hostileLimits = new Proxy({}, { ownKeys: () => { ownKeysCalls += 1; return Array.from({ length: 100_000 }, (_, index) => `limit-${index}`); } });
    const result = scheduleCapabilities({ ...context, limits: hostileLimits as typeof DEFAULT_SCANNER_LIMITS_V2 }, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => { invoked = true; return emptyCandidate(); }));
    expect(ownKeysCalls).toBe(0); expect(invoked).toBe(false);
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 }); expect(result.candidates).toEqual([]);
  });
  it('rejects an unbranded accessor candidate before reading counters', () => {
    let invoked = false;
    const candidate = { ...emptyCandidate(), seen: 7, analyzed: 5, skipped: 2, omitted: 3 } as Record<string, unknown>;
    Object.defineProperty(candidate, 'findings', { get: () => { invoked = true; throw new Error('candidate payload must not be read'); } });
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'source-normalization' ? candidate as CapabilityCandidateV2 : emptyCandidate()));
    expect(invoked).toBe(false);
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', seen: 0, analyzed: 0, skipped: 0, omitted: 1 });
    expect(result.candidates).toEqual([]);
  });

  it('rejects unbranded forwarding output before reflection', () => {
    let ownKeysCalls = 0; let prototypeCalls = 0;
    const hostile = new Proxy(Object.create(null), {
      ownKeys: () => { ownKeysCalls += 1; return Array.from({ length: 100_000 }, (_, index) => `key-${index}`); },
      getPrototypeOf: () => { prototypeCalls += 1; throw new Error('candidate prototype must remain opaque'); },
      get: () => { throw new Error('candidate payload must remain opaque'); },
      getOwnPropertyDescriptor: () => undefined,
    });
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'source-normalization' ? hostile as unknown as CapabilityCandidateV2 : emptyCandidate()));
    expect(ownKeysCalls).toBe(0); expect(prototypeCalls).toBe(0);
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', seen: 0, analyzed: 0, skipped: 0, omitted: 1 });
    expect(result.candidates).toEqual([]);
  });
});

describe('capability count lattice', () => {
  const counts = (seen: number, analyzed: number, skipped: number, omitted: number): CapabilityCandidateV2 =>
    createCapabilityCandidateAdmissionSnapshotV2({ findings: [], diagnostics: [], facts: [], traces: [], seen, analyzed, skipped, omitted });

  it('does not publish a completed capability whose own counts record skipped work', () => {
    // The capability did not skip a whole stage: it ran, and two of the three units it saw are
    // recorded as skipped. A `COMPLETED` row here is a complete outcome claimed by an incomplete
    // result, so the boundary publishes the degraded outcome those counts corroborate.
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'structural-policies' ? counts(3, 1, 2, 0) : emptyCandidate()));
    expect(result.executions.find(({ id }) => id === 'structural-policies')).toMatchObject({ status: 'DEGRADED', seen: 3, analyzed: 1, skipped: 2, omitted: 0 });
  });

  it('does not publish a completed capability whose own counts record an omission', () => {
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'structural-policies' ? counts(2, 2, 0, 1) : emptyCandidate()));
    expect(result.executions.find(({ id }) => id === 'structural-policies')).toMatchObject({ status: 'DEGRADED', seen: 2, analyzed: 2, skipped: 0, omitted: 1 });
  });

  it('rejects a capability that claims more analyzed units than it accounted for', () => {
    const result = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'structural-policies' ? counts(1, 4, 0, 0) : emptyCandidate()));
    // The rejected capability publishes no candidate, and the capabilities that depend on it are
    // skipped behind it, so only the two independent ones still publish.
    expect(result.candidates).toHaveLength(2);
    expect(result.executions.find(({ id }) => id === 'structural-policies')).toMatchObject({ status: 'FAILED', omitted: 1 });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REQUIRED_CAPABILITY_FAILED', capabilityId: 'structural-policies' }),
    ]));
  });

  it('reports a corroborated count row for every capability declared by both v2 manifests', () => {
    const defaultRun = scheduleCapabilities(context, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()));
    const hardenedRun = scheduleCapabilities(context, BETA_HARDENED_PROFILE_MANIFEST, registryFor(BETA_HARDENED_PROFILE_MANIFEST, () => emptyCandidate()));
    expect(defaultRun.executions.map(({ id, status }) => [id, status])).toEqual(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map(({ id }) => [id, 'COMPLETED']));
    for (const { manifest, run } of [{ manifest: BETA_DEFAULT_PROFILE_MANIFEST, run: defaultRun }, { manifest: BETA_HARDENED_PROFILE_MANIFEST, run: hardenedRun }]) {
      expect(run.executions.map(({ id }) => id)).toEqual(manifest.capabilities.map(({ id }) => id));
      for (const row of run.executions) {
        for (const count of [row.seen, row.analyzed, row.skipped, row.omitted]) expect(Number.isSafeInteger(count) && count >= 0, `${row.id} counters must be non-negative safe integers`).toBe(true);
        const unperformed = row.skipped + row.omitted;
        if (row.status === 'COMPLETED') expect(unperformed, `${row.id} cannot claim a completed outcome`).toBe(0);
        else expect(unperformed, `${row.id} must record the work it did not do`).toBeGreaterThan(0);
      }
    }
  });
});

describe('context snapshot limits', () => {
  // The `workflow` budget these limits derive: floor 8_192 objects + 8 objects per unit over
  // `maxMembersAndElements + maxStoredSourceSpans + maxNodes + maxEdges` = 128 units. A change to
  // the floor, the per-unit cost, or the unit sum fails the numbers asserted below.
  const derivedObjects = 8_192 + 8 * (32 + 32 + 32 + 32);
  const tightLimits = { ...DEFAULT_SCANNER_LIMITS_V2, maxNodes: 32, maxEdges: 32, maxStoredSourceSpans: 32, maxMembersAndElements: 32, maxParameterLeaves: 32, maxDocumentDepth: 32 };
  // Object counts: 1 workflow record + 1 nodes array + one inner array and two empty records per
  // element, so 2_800 elements cost 8_402 objects (under) and 3_200 cost 9_602 (over).
  const nestedRecords = (elements: number): Record<string, unknown> => ({ nodes: Array.from({ length: elements }, () => [{}, {}]) });
  const overBudgetContext = { ...context, workflow: nestedRecords(3_200), limits: tightLimits } as unknown as AnalyzerContextV2;
  const underBudgetContext = { ...context, workflow: nestedRecords(2_800), limits: tightLimits } as unknown as AnalyzerContextV2;
  const limitDiagnostic = (result: { diagnostics: readonly AnalysisDiagnosticV2[] }) => result.diagnostics.find(({ code }) => code === 'REQUIRED_LIMIT_EXCEEDED');

  it('refuses a context view past the derived object budget and publishes the bound that fired', () => {
    const result = scheduleCapabilities(overBudgetContext, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()));
    expect(result.executions[0]).toMatchObject({ id: 'source-normalization', status: 'FAILED', seen: 0, analyzed: 0, skipped: 0, omitted: 1 });
    // The budget is a cumulative count that stops at its crossing, so the refusal names the bound
    // that fired (9_216) instead of `maximum + 1` (9_217).
    expect(limitDiagnostic(result)).toMatchObject({ code: 'REQUIRED_LIMIT_EXCEEDED', category: 'LIMIT', capabilityId: 'source-normalization', observed: derivedObjects, maximum: derivedObjects, omitted: 0 });
    expect(result.candidates).toEqual([]);
  });

  it('runs every capability over a context view under the derived budget', () => {
    const result = scheduleCapabilities(underBudgetContext, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate(1)));
    expect(result.executions.map(({ status }) => status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED']);
    expect(result.diagnostics).toEqual([]);
    expect(result.candidates).toHaveLength(5);
  });

  it('publishes the real container size when a map crosses the floor item bound', () => {
    const oversized = new Map<number, number>(); for (let index = 0; index < 5_000; index += 1) oversized.set(index, index);
    const result = scheduleCapabilities({ ...context, priorOutcomes: oversized } as unknown as AnalyzerContextV2, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()));
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 });
    // The map's size is known before the walk, so `observed` is the real entry count and `omitted`
    // the entries the bound refused — not the first crossing (4_097 / 1).
    expect(limitDiagnostic(result)).toMatchObject({ code: 'REQUIRED_LIMIT_EXCEEDED', capabilityId: 'source-normalization', observed: 5_000, maximum: 4_096, omitted: 904 });
  });

  it('publishes the real array length when an array crosses the floor item bound', () => {
    const result = scheduleCapabilities({ ...context, priorOutcomes: new Map([['array', new Array(5_000).fill(0)]]) } as unknown as AnalyzerContextV2, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()));
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 });
    expect(limitDiagnostic(result)).toMatchObject({ code: 'REQUIRED_LIMIT_EXCEEDED', capabilityId: 'source-normalization', observed: 5_000, maximum: 4_096, omitted: 904 });
  });

  it('publishes the floor depth bound when the walk crosses the depth budget', () => {
    const root: { next?: unknown } = {}; let cursor: { next?: unknown } = root;
    for (let index = 0; index < 65; index += 1) { const next: { next?: unknown } = {}; cursor.next = next; cursor = next; }
    const result = scheduleCapabilities({ ...context, priorOutcomes: new Map([['deep', root]]) } as unknown as AnalyzerContextV2, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()));
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 });
    // The value sits at depth 65 against a floor of 64, and the cumulative budget publishes the
    // bound that fired, not 65.
    expect(limitDiagnostic(result)).toMatchObject({ code: 'REQUIRED_LIMIT_EXCEEDED', capabilityId: 'source-normalization', observed: 64, maximum: 64, omitted: 0 });
  });

  it('admits a validated target whose collections exceed the old floor', () => {
    const target = validateTargetContextV3({ schemaVersion: 'scanner-target-v3', edition: 'COMMUNITY', communityPackages: Array.from({ length: 5_000 }, (_, index) => ({ name: `package-${index}` })), configuration: [] });
    const result = scheduleCapabilities({ ...context, target } as unknown as AnalyzerContextV2, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate(1)));
    expect(result.executions.map(({ status }) => status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED']);
    expect(result.diagnostics).toEqual([]);
  });

  it('refuses a raw target collection past the admitted target bound with the real size', () => {
    const target = { edition: 'COMMUNITY', communityPackages: new Array(100_001).fill(null), configuration: [] };
    const result = scheduleCapabilities({ ...context, target } as unknown as AnalyzerContextV2, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()));
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 });
    expect(limitDiagnostic(result)).toMatchObject({ code: 'REQUIRED_LIMIT_EXCEEDED', capabilityId: 'source-normalization', observed: 100_001, maximum: 100_000, omitted: 1 });
  });

  it('publishes the validator limit numbers when a candidate crosses maxFindings', () => {
    const findings: CapabilityCandidateV2['findings'] = [{ ruleId: 'N8N_EXECUTE_COMMAND', evidenceClass: 'CAPABILITY', conclusion: 'OBSERVED', applicability: 'APPLICABLE', subject: { kind: 'WORKFLOW' }, factRefs: [], traceRefs: [], remediationId: 'r' }];
    const candidate = createCapabilityCandidateAdmissionSnapshotV2({ findings, diagnostics: [], facts: [], traces: [], seen: 1, analyzed: 1, skipped: 0, omitted: 0 });
    const limited = { ...context, limits: { ...DEFAULT_SCANNER_LIMITS_V2, maxFindings: 0 } } as unknown as AnalyzerContextV2;
    const result = scheduleCapabilities(limited, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, (id) => id === 'source-normalization' ? candidate : emptyCandidate(1)));
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 });
    // The validator refuses without inspecting the finding, so the refusal numbers are the real
    // array length (1) against the zero allowance — the triple the validator itself demands of
    // capability-emitted LIMIT diagnostics.
    expect(limitDiagnostic(result)).toMatchObject({ code: 'REQUIRED_LIMIT_EXCEEDED', category: 'LIMIT', capabilityId: 'source-normalization', observed: 1, maximum: 0, omitted: 1 });
  });

  it('refuses a semantics catalogue past the derived per-node object budget', () => {
    // The `semantics` budget is floor 8_192 + 64 objects per `maxNodes` entry = 328_192 at the
    // default 5_000. Only objects count as copied nodes, so each of the 5_000 catalogue entries
    // carries a 65-object array: 5_000 × 67 objects cross the budget, and a change to the floor,
    // the per-node cost, or `maxNodes` fails the numbers asserted below.
    const resolvedNodeSemantics = new Map(Array.from({ length: 5_000 }, (_, index) => [`semantic-${index}`, { nested: Array.from({ length: 65 }, () => ({})) }]));
    const result = scheduleCapabilities(
      { ...context, semantics: { id: 'semantics', version: '2.0.0', digest: 'digest', resolvedNodeSemantics } } as unknown as AnalyzerContextV2,
      BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate()),
    );
    expect(result.executions[0]).toMatchObject({ id: 'source-normalization', status: 'FAILED', omitted: 1 });
    expect(limitDiagnostic(result)).toMatchObject({ code: 'REQUIRED_LIMIT_EXCEEDED', category: 'LIMIT', capabilityId: 'source-normalization', observed: 328_192, maximum: 328_192, omitted: 0 });
  });

  it('walks a target the target admission admits at its collection maximum', () => {
    // `semantics/target-context.ts` admits up to `MAX_COLLECTION_ITEMS = 100_000` items per
    // collection, so this target passes target validation; the floor's 4_096-item budget refused it
    // before the repair (D-1 review, finding 3), and the target budget must not do so again.
    const target = validateTargetContextV3({
      schemaVersion: 'scanner-target-v3', edition: 'COMMUNITY', communityPackages: Array.from({ length: 100_000 }, (_, index) => ({ name: `package-${index}` })), configuration: [],
    });
    const result = scheduleCapabilities({ ...context, target } as unknown as AnalyzerContextV2, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST, () => emptyCandidate(1)));
    expect(result.diagnostics).toEqual([]);
    expect(result.executions.map(({ status }) => status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED']);
  });

});
