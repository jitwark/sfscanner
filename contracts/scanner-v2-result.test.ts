import { notRequestedAdvisoryFixture as advisoryFixture } from './scanner-v2-advisory-fixture.test-helper';
import { createTargetContextDigestV3 } from './scanner-target-v3';
import { createRequire } from 'node:module';
import scannerResultSchema from '../schemas/scanner-result-v2.schema.json';
import fieldFlowVectors from '../docs/superpowers/plans/2026-10-21-scanner-deepseek/Q04-FIELD-FACT-VECTORS.json';
import { describe, expect, it } from 'vitest';
import { validateScannerResultV2, type SafeFactV2, type ScannerResultV2 } from './scanner-v2-result';

const digest = (letter: string) => letter.repeat(64);
const defaultTarget = { schemaVersion: 'scanner-target-v3' as const, edition: 'UNKNOWN' as const,
  deployment: 'UNKNOWN' as const, role: 'UNKNOWN' as const, taskRunner: 'UNKNOWN' as const,
  communityPackages: [], configuration: [] };
const defaultTargetDigest = createTargetContextDigestV3(defaultTarget);
const notRequestedAdvisoryFixture = () => advisoryFixture(defaultTargetDigest);
const sourceRef = (pointer = '') => ({ pointer, occurrencePath: [0], astNodeId: digest('a'), span: null });
const nodeRef = (pointer = '') => ({ ordinal: 0, source: sourceRef(pointer), identityDigest: digest('b') });
const validResult = (): ScannerResultV2 => ({
  schemaVersion: 'scanner-result-v2',
  engine: { id: 'secureflow-scanner', version: '2.0.0', buildDigest: digest('a') },
  input: { rawSha256: digest('b'), semanticSha256: digest('c'), ambiguitySha256: digest('d'), ambiguityCount: 0, utf8Bytes: 1 },
  profile: { id: 'beta-default', version: '2.0.0' },
  ruleset: { id: 'rules', version: '2.0.0', digest: digest('e'), signatureStatus: 'VERIFIED' },
  semantics: { id: 'semantics', version: '2.0.0', digest: digest('f') },
  target: { ...defaultTarget, contextDigest: defaultTargetDigest },
  limits: { schemaVersion: 'scanner-limits-v2', digest: digest('1'), usage: [] },
  analysis: { status: 'COMPLETE', capabilities: [], diagnostics: [] },
  workflow: { name: null, nodeCount: 0, rawNodeCount: 0, annotationNodeCount: 0, triggerCount: 0, actionCount: 0, integrationCount: 0, edgeCount: 0, resolvedEdgeCount: 0, payloadBytes: 0, complexity: 'LOW', isSubWorkflow: false },
  facts: [notRequestedAdvisoryFixture()], traces: [], findings: [],
  assessment: { score: 0, grade: 'LOW', scoringPolicyVersion: 'secureflow-risk-v2@2.0.0', basisFindingIds: [], excludedReportOnlyFindingIds: [], excludedUncertainFindingIds: [], excludedNotApplicableFindingIds: [], unknownEvidenceCount: 0 },
  stats: { rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings: 0, serializedBytes: 0 },
});
const capability = (id: string, required: boolean, status: 'COMPLETED' | 'SKIPPED' | 'DEGRADED' | 'FAILED' = 'COMPLETED', diagnosticIds: string[] = [], omitted = 0) => ({ id, version: '2.0.0', required, status, seen: 0, analyzed: 0, skipped: 0, omitted, diagnosticIds });
const diagnostic = (id = digest('c')) => ({ id, code: 'SOURCE_SPAN_UNAVAILABLE' as const, category: 'SOURCE' as const, capabilityId: 'source-normalization', aggregateEffect: 'DEGRADED' as const, assessmentEligible: true });

describe('validateScannerResultV2', () => {
  it('binds field-flow findings and witnesses after closed result validation', () => {
    const [origin, summary] = fieldFlowVectors.facts;
    const trace = {
      traceId: digest('2'), kind: 'CONFIDENTIALITY',
      steps: [
        { ordinal: 0, kind: 'SOURCE', subject: origin.subject, factRefs: [origin.factId] },
        { ordinal: 1, kind: 'SINK', subject: summary.subject, factRefs: [summary.factId] },
      ],
    };
    const finding = {
      findingId: digest('3'), ruleId: 'TAINTED_COMMAND', ruleRevision: '2.0.0', effect: 'REPORT_ONLY',
      evidenceClass: 'POTENTIAL_DATAFLOW', conclusion: 'POTENTIAL', applicability: 'APPLICABLE',
      subject: summary.subject, factRefs: [summary.factId], traceRefs: [trace.traceId],
      remediationId: 'tainted-command', severity: 'HIGH', confidence: 'HIGH',
    };
    const base = validResult();
    const candidate = {
      ...base, facts: [notRequestedAdvisoryFixture(), ...fieldFlowVectors.facts], traces: [trace], findings: [finding],
      assessment: { ...base.assessment!, excludedReportOnlyFindingIds: [finding.findingId] },
    };
    expect(validateScannerResultV2(candidate).ok).toBe(true);
    expect(validateScannerResultV2({ ...candidate, traces: [{ ...trace, kind: 'INTEGRITY' }] }).ok).toBe(false);
    expect(validateScannerResultV2({ ...candidate, findings: [{ ...finding, subject: origin.subject }] }).ok).toBe(false);
    const unsupported = { ...trace, steps: [{ ...trace.steps[0], factRefs: [summary.factId] }, trace.steps[1]] };
    expect(validateScannerResultV2({ ...candidate, traces: [unsupported] }).ok).toBe(false);
  });

  it('reads closed field-flow facts and rejects every missing required property', () => {
    const facts = [notRequestedAdvisoryFixture(), ...fieldFlowVectors.facts];
    const candidate = { ...validResult(), facts };
    expect(validateScannerResultV2(candidate).ok).toBe(true);
    for (const [index, fact] of facts.entries()) {
      for (const key of Object.keys(fact.properties)) {
        const { [key]: omitted, ...properties } = fact.properties as Record<string, unknown>;
        void omitted;
        const changed = facts.map((entry, ordinal) => ordinal === index ? { ...entry, properties } : entry);
        expect(validateScannerResultV2({ ...candidate, facts: changed }).ok).toBe(false);
      }
    }
  });

  it('refuses unsafe whole field paths, forged origins and false-complete field coverage', () => {
    const facts = [notRequestedAdvisoryFixture(), ...fieldFlowVectors.facts];
    const candidate = { ...validResult(), facts };
    for (const properties of [
      { ...facts[1].properties, sinkParameterPath: '/safe/secret=CANARY' },
      { ...facts[1].properties, sourceFieldPath: ['safe', '../private', 'sibling'] },
      { ...facts[1].properties, taintLabels: ['UNREVIEWED'] },
      { ...facts[1].properties, knowledge: 'UNKNOWN' },
    ]) expect(validateScannerResultV2({ ...candidate, facts: [facts[0], { ...facts[1], properties }, facts[2]] }).ok).toBe(false);
    expect(validateScannerResultV2({ ...candidate, facts: [{ ...facts[0], properties: { ...facts[0].properties, sourceNodeOrdinal: 1 } }, facts[1], facts[2]] }).ok).toBe(false);
    expect(validateScannerResultV2({ ...candidate, facts: [facts[0], facts[1], { ...facts[2], properties: { ...facts[2].properties, witnessUnavailable: 1 } }] }).ok).toBe(false);
  });

  it('rejects dangling or mismatched embedded provenance and duplicate capability coverage', () => {
    const [origin, summary, coverage] = fieldFlowVectors.facts;
    const candidate = validResult();
    expect(validateScannerResultV2({ ...candidate, facts: [summary, coverage] }).ok).toBe(false);
    for (const properties of [
      { ...summary.properties, sourceFieldPath: ['different'] },
      { ...summary.properties, taintLabels: ['WEBHOOK_QUERY'] },
      { ...summary.properties, sourceProvenanceFactId: coverage.factId },
    ]) expect(validateScannerResultV2({ ...candidate, facts: [origin, { ...summary, properties }, coverage] }).ok).toBe(false);
    const duplicate = { ...coverage, factId: digest('f'), properties: { ...coverage.properties, coverageStatus: 'LIMITED', witnessUnavailable: 1 } };
    expect(validateScannerResultV2({ ...candidate, facts: [origin, summary, coverage, duplicate] }).ok).toBe(false);
  });

  it('accepts a closed complete result and freezes the copied graph', () => {
    const candidate = validResult();
    const result = validateScannerResultV2(candidate);
    expect(result.ok).toBe(true);
    if (result.ok) { expect(Object.isFrozen(result.result)).toBe(true); expect(result.result).not.toBe(candidate); expect(Object.isFrozen(candidate)).toBe(false); }
  });

  it('rejects unknown keys and invalid unions', () => {
    const candidate = validResult() as Record<string, unknown>;
    candidate.extra = true;
    (candidate.analysis as Record<string, unknown>).status = 'BROKEN';
    expect(validateScannerResultV2(candidate).ok).toBe(false);
  });

  it('accepts NODE subjects and EDGE endpoints with escaped multi-segment pointers', () => {
    const candidate = validResult();
    const node = nodeRef('/nodes/0/parameters/name~1value');
    const edge = { ordinal: 0, sourceNode: node, targetNode: node, sourceLabel: 'A', targetLabel: 'B', connectionType: 'main', sourcePort: 0, targetPort: 0, source: sourceRef('/connections/main/0'), resolution: 'RESOLVED' as const };
    const factId = digest('1'); const findingId = digest('2');
    candidate.facts = [notRequestedAdvisoryFixture(), { factId, kind: 'workflow.summary.v1', subject: { kind: 'NODE', node }, properties: { connectionCount: 1 } }];
    candidate.findings = [{ findingId, ruleId: 'RULE', ruleRevision: '1', effect: 'REPORT_ONLY', severity: 'INFO', confidence: 'HIGH', evidenceClass: 'CAPABILITY', conclusion: 'OBSERVED', applicability: 'APPLICABLE', subject: { kind: 'EDGE', edge }, factRefs: [factId], traceRefs: [], remediationId: 'remediation' }];
    candidate.assessment = { ...candidate.assessment!, excludedReportOnlyFindingIds: [findingId] };
    expect(validateScannerResultV2(candidate).ok).toBe(true);
  });

  it('rejects malformed RFC6901 escapes', () => {
    const candidate = validResult();
    const node = nodeRef('/nodes/~2');
    candidate.facts = [notRequestedAdvisoryFixture(), { factId: digest('1'), kind: 'workflow.summary.v1', subject: { kind: 'NODE', node }, properties: { connectionCount: 1 } }];
    expect(validateScannerResultV2(candidate).ok).toBe(false);
  });

  it('rejects duplicate or dangling evidence references', () => {
    const candidate = validResult();
    candidate.facts = [notRequestedAdvisoryFixture(), { factId: digest('a'), kind: 'workflow.summary.v1', subject: { kind: 'WORKFLOW' }, properties: {} }];
    candidate.traces = [{ traceId: digest('b'), kind: 'CONTROL', steps: [{ ordinal: 0, kind: 'SOURCE', subject: { kind: 'WORKFLOW' }, factRefs: ['missing'] }] }];
    expect(validateScannerResultV2(candidate).ok).toBe(false);
  });

  it('requires exact one-capability ownership for every diagnostic', () => {
    const candidate = validResult(); const d = diagnostic();
    candidate.analysis = { status: 'DEGRADED', capabilities: [capability('source-normalization', true, 'COMPLETED', [d.id]), capability('workflow-insights', true, 'COMPLETED', [d.id])], diagnostics: [d] };
    expect(validateScannerResultV2(candidate).ok).toBe(false);
    const unreferenced = validResult(); unreferenced.analysis = { status: 'DEGRADED', capabilities: [capability('source-normalization', true)], diagnostics: [d] };
    expect(validateScannerResultV2(unreferenced).ok).toBe(false);
  });

  it('reduces required omissions to indeterminate and optional omissions to degraded', () => {
    const required = validResult(); required.analysis = { status: 'INDETERMINATE', capabilities: [capability('source-normalization', true, 'SKIPPED', [], 1)], diagnostics: [] }; required.assessment = null;
    expect(validateScannerResultV2(required).ok).toBe(true);
    // The row publishes the status its own omitted count corroborates; a COMPLETED claim here would be rejected.
    const optional = validResult(); optional.analysis = { status: 'DEGRADED', capabilities: [capability('expression-security', false, 'DEGRADED', [], 1)], diagnostics: [] };
    expect(validateScannerResultV2(optional).ok).toBe(true);
  });

  it('makes result omissions incompatible with COMPLETE', () => {
    const candidate = validResult(); candidate.stats.omittedFindings = 1;
    expect(validateScannerResultV2(candidate).ok).toBe(false);
    candidate.analysis.status = 'DEGRADED';
    expect(validateScannerResultV2(candidate).ok).toBe(true);
  });

  it('rejects a completed capability whose counters record skipped units', () => {
    const candidate = validResult();
    candidate.analysis = { status: 'COMPLETE', capabilities: [{ ...capability('source-normalization', true), seen: 3, analyzed: 1, skipped: 2, omitted: 0 }], diagnostics: [] };
    const validated = validateScannerResultV2(candidate);
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.errors).toContain('analysis.capabilities[0] claims COMPLETED while recording skipped or omitted units');
      expect(validated.errors).toContain('analysis.status disagrees with capability/diagnostic effects');
    }
  });

  it('rejects the same skip recorded by an optional capability', () => {
    const candidate = validResult();
    candidate.analysis = { status: 'COMPLETE', capabilities: [{ ...capability('expression-security', false), seen: 3, analyzed: 1, skipped: 2, omitted: 0 }], diagnostics: [] };
    expect(validateScannerResultV2(candidate).ok).toBe(false);
  });

  it('accepts the corroborated status for counters that record skipped units', () => {
    const candidate = validResult();
    candidate.analysis = { status: 'DEGRADED', capabilities: [{ ...capability('source-normalization', true, 'DEGRADED'), seen: 3, analyzed: 1, skipped: 2, omitted: 0 }], diagnostics: [] };
    expect(validateScannerResultV2(candidate).ok).toBe(true);
  });

  it('still accepts a completed capability whose counters record performed work only', () => {
    const candidate = validResult();
    candidate.analysis = { status: 'COMPLETE', capabilities: [{ ...capability('source-normalization', true), seen: 3, analyzed: 3, skipped: 0, omitted: 0 }], diagnostics: [] };
    expect(validateScannerResultV2(candidate).ok).toBe(true);
  });

  it('rejects counters that no run can produce, naming the inconsistency', () => {
    const analyzedBeyondAccounted = validResult();
    analyzedBeyondAccounted.analysis = { status: 'COMPLETE', capabilities: [{ ...capability('source-normalization', true), seen: 3, analyzed: 5, skipped: 0, omitted: 0 }], diagnostics: [] };
    const unseen = validateScannerResultV2(analyzedBeyondAccounted);
    expect(unseen.ok).toBe(false);
    if (!unseen.ok) expect(unseen.errors).toEqual(['analysis.capabilities[0] counters record UNSEEN_ANALYSIS: analyzed exceeds seen + skipped + omitted']);

    const seenBeyondAccounted = validResult();
    seenBeyondAccounted.analysis = { status: 'COMPLETE', capabilities: [{ ...capability('source-normalization', true), seen: 3, analyzed: 1, skipped: 0, omitted: 0 }], diagnostics: [] };
    const unaccounted = validateScannerResultV2(seenBeyondAccounted);
    expect(unaccounted.ok).toBe(false);
    if (!unaccounted.ok) expect(unaccounted.errors).toEqual(['analysis.capabilities[0] counters record UNACCOUNTED_SEEN: seen exceeds analyzed + skipped + omitted']);
  });

  it('accepts the counter shapes the analyzers and the scheduler emit', () => {
    // Analyzers count in their own units, so the counters are not a partition of `seen`: one seen node
    // becomes one analyzed source plus its recorded omission, and a skipped row saw nothing at all.
    const nonPartition = validResult();
    nonPartition.analysis = { status: 'DEGRADED', capabilities: [{ ...capability('expression-security', false, 'DEGRADED'), seen: 1, analyzed: 1, skipped: 0, omitted: 1 }], diagnostics: [] };
    expect(validateScannerResultV2(nonPartition).ok).toBe(true);
    const skippedNothingSeen = validResult();
    skippedNothingSeen.analysis = { status: 'DEGRADED', capabilities: [{ ...capability('expression-security', false, 'SKIPPED'), seen: 0, analyzed: 0, skipped: 1, omitted: 0 }], diagnostics: [] };
    expect(validateScannerResultV2(skippedNothingSeen).ok).toBe(true);
  });

  it('rejects a diagnostic that records omission the owning capability counters deny', () => {
    const diagnosticId = digest('c');
    const truncation = { id: diagnosticId, code: 'OPTIONAL_LIMIT_EXCEEDED' as const, category: 'LIMIT' as const, capabilityId: 'expression-security', aggregateEffect: 'DEGRADED' as const, assessmentEligible: true, observed: 1, maximum: 0, omitted: 1 };
    const denied = validResult();
    denied.analysis = { status: 'DEGRADED', capabilities: [capability('expression-security', false, 'COMPLETED', [diagnosticId], 0)], diagnostics: [truncation] };
    const refused = validateScannerResultV2(denied);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors).toEqual(['analysis.diagnostics[0] counters record UNRECORDED_OMISSION: omitted exceeds the owning capability omitted count']);
    // The same diagnostic validates once the row that owns it records the omission it names.
    const corroborated = validResult();
    corroborated.analysis = { status: 'DEGRADED', capabilities: [capability('expression-security', false, 'DEGRADED', [diagnosticId], 1)], diagnostics: [truncation] };
    expect(validateScannerResultV2(corroborated).ok).toBe(true);
  });

  it('accepts a finer-unit row whose analyzed and omitted units together exceed seen', () => {
    const optional = validResult();
    optional.analysis = { status: 'DEGRADED', capabilities: [{ ...capability('javascript-security', false, 'DEGRADED'), seen: 1, analyzed: 3, skipped: 0, omitted: 3 }], diagnostics: [] };
    expect(validateScannerResultV2(optional).ok).toBe(true);
    const required = validResult();
    required.analysis = { status: 'INDETERMINATE', capabilities: [{ ...capability('structural-policies', true, 'DEGRADED'), seen: 1, analyzed: 3, skipped: 0, omitted: 3 }], diagnostics: [] };
    required.assessment = null;
    expect(validateScannerResultV2(required).ok).toBe(true);
  });

  it('reports a counter that is not a safe integer instead of guessing at its arithmetic', () => {
    const candidate = validResult();
    candidate.analysis = { status: 'COMPLETE', capabilities: [{ ...capability('source-normalization', true), seen: Number.MAX_SAFE_INTEGER + 1, analyzed: 0, skipped: 0, omitted: 0 }], diagnostics: [] };
    const validated = validateScannerResultV2(candidate);
    expect(validated.ok).toBe(false);
    if (!validated.ok) expect(validated.errors).toEqual(['analysis.capabilities[0].seen must be a safe integer']);
  });

  it('rejects accessors without invoking them and rejects oversized arrays before iteration', () => {
    const accessor = validResult(); let invoked = false;
    Object.defineProperty(accessor.workflow, 'name', { enumerable: true, get: () => { invoked = true; throw new Error('secret'); } });
    expect(validateScannerResultV2(accessor).ok).toBe(false); expect(invoked).toBe(false);
    const oversized = validResult(); oversized.facts = new Array(100_001);
    expect(validateScannerResultV2(oversized).ok).toBe(false);
  });
  it('isolates nested values before validation can observe caller mutations', () => {
    const candidate = validResult();
    const initialDigest = candidate.engine.buildDigest;
    const workflow = candidate.workflow;
    candidate.workflow = new Proxy(workflow, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'name') candidate.engine.buildDigest = digest('f');
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const result = validateScannerResultV2(candidate);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.engine.buildDigest).toBe(initialDigest);
  });

  it('rejects indeterminate results that carry an assessment', () => {
    const candidate = validResult(); candidate.analysis = { status: 'INDETERMINATE', capabilities: [], diagnostics: [] };
    expect(validateScannerResultV2(candidate).ok).toBe(false);
  });

  it('accepts registered safe fact properties', () => {
    const candidate = validResult();
    candidate.facts = [notRequestedAdvisoryFixture(), { factId: digest('a'), kind: 'workflow.summary.v1', subject: { kind: 'WORKFLOW' }, properties: { connectionCount: 1 } }];
    expect(validateScannerResultV2(candidate).ok).toBe(true);
  });
  it('accepts registered destination pointers without allowing unsafe path text elsewhere', () => {
    const candidate = validResult();
    candidate.facts = [notRequestedAdvisoryFixture(), {
      factId: digest('a'),
      kind: 'destination.v2',
      subject: { kind: 'SOURCE', source: sourceRef('/nodes/0/parameters/url') },
      properties: { parameterPath: '/url', scheme: 'HTTPS', hostname: 'example.test', authorityState: 'KNOWN', valueMode: 'LITERAL' },
    }];
    expect(validateScannerResultV2(candidate).ok).toBe(true);
  });

  it('rejects duplicate IDs, unsafe content, invalid digests, and unsafe numbers', () => {
    const duplicate = validResult(); duplicate.facts = [{ factId: digest('a'), kind: 'workflow.summary.v1', subject: { kind: 'WORKFLOW' }, properties: {} }, { factId: digest('a'), kind: 'workflow.summary.v1', subject: { kind: 'WORKFLOW' }, properties: {} }];
    expect(validateScannerResultV2(duplicate).ok).toBe(false);
    const unsafe = validResult(); unsafe.engine.buildDigest = 'not-a-digest'; unsafe.workflow.nodeCount = Number.MAX_SAFE_INTEGER + 1;
    expect(validateScannerResultV2(unsafe).ok).toBe(false);
    const secret = validResult(); secret.facts = [{ factId: digest('a'), kind: 'workflow.summary.v1', subject: { kind: 'WORKFLOW' }, properties: { value: 'password: leaked' } }];
    expect(validateScannerResultV2(secret).ok).toBe(false);
  });

  it('requires explicit nullable fields and rejects inconsistent status', () => {
    const missing = validResult() as Record<string, unknown>; delete missing.assessment;
    expect(validateScannerResultV2(missing).ok).toBe(false);
    const inconsistent = validResult(); inconsistent.analysis = { status: 'DEGRADED', capabilities: [capability('source-normalization', true, 'FAILED', [], 1)], diagnostics: [] };
    expect(validateScannerResultV2(inconsistent).ok).toBe(false);
  });

  it('keeps JSON schema closure and JSON round trips valid results', () => {
    const schema = scannerResultSchema as Record<string, unknown>;
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.additionalProperties).toBe(false);
    expect((schema.required as string[])).toContain('assessment');
    expect(validateScannerResultV2(JSON.parse(JSON.stringify(validResult()))).ok).toBe(true);
  });
});

type PublishedFact = Readonly<{ factId: string; kind: string; subject: Record<string, unknown>; properties: Record<string, unknown> }>;
type Ajv6 = { compile(schema: Record<string, unknown>): ((value: unknown) => boolean) & { errors?: unknown } };
const Ajv = createRequire(new URL('../pipeline/package.json', import.meta.url))('ajv') as new () => Ajv6;
// Ajv 6 speaks draft-07. The published dialect marker is stripped and `$defs` is resolved as a plain
// JSON pointer, so the harness validates the same keyword subset the published document uses
// (`if`/`then`, `oneOf`, `enum`, `const`, bounds) without 2020-only semantics.
const { $schema: publishedDraft, ...publishedSource } = scannerResultSchema as Record<string, unknown>;
void publishedDraft;
const validatePublishedFact = new Ajv().compile({ ...publishedSource, $ref: '#/$defs/fact' });
const publishedFacts = fieldFlowVectors.facts as unknown as PublishedFact[];

const destinationV3Fact = (): SafeFactV2 => ({
  factId: digest('d'), kind: 'destination.v3',
  subject: { kind: 'SOURCE', source: sourceRef('/nodes/0/parameters/url') },
  properties: {
    parameterPath: '/url', scheme: 'HTTPS', hostname: 'example.test', authorityState: 'KNOWN',
    valueMode: 'LITERAL', reason: 'NONE', omitted: 0, inventoryStatus: 'COMPLETE',
  },
});
const destinationCoverageFact = (): SafeFactV2 => ({
  factId: digest('e'), kind: 'destination.coverage.v1', subject: { kind: 'WORKFLOW' },
  properties: { inventoryStatus: 'COMPLETE', nodesExamined: 1, pathsConfigured: 1, recordsEmitted: 1, errors: 0, omitted: 0, errorCodes: [] },
});
const legacyDestinationV2Fact = (): SafeFactV2 => ({
  factId: digest('9'), kind: 'destination.v2',
  subject: { kind: 'SOURCE', source: sourceRef('/nodes/0/parameters/url') },
  properties: { parameterPath: '/url', scheme: 'HTTPS', hostname: 'example.test', authorityState: 'KNOWN', valueMode: 'LITERAL' },
});
const advisoryFacts = (targetDigest: string): readonly SafeFactV2[] => [{
  factId: digest('6'), kind: 'advisory.evaluation.v1', subject: { kind: 'WORKFLOW' }, properties: {
    evaluationState: 'UNAVAILABLE', evaluationReason: 'NO_ADMITTED_SNAPSHOT', targetDigest,
    sourceId: null, pinDigest: null, coverageDigest: null, rightsReceiptDigest: null,
    provenanceReceiptDigest: null, boundsDigest: null, admissionReceiptDigest: null,
    pinnedSnapshotSha256: null, snapshotSha256: null, capturedAt: null, admittedAt: null,
    evaluatedAt: null, catalogueVersion: null, catalogueDigest: null, coverageClaimed: false,
    packagesRequested: 1, packagesCovered: 0, packageRowsOmitted: 0, recordsExamined: 0,
    recordsApplicable: 0, recordsNotApplicable: 0, recordsUnknown: 0, omissionReasons: [],
  },
}, {
  factId: digest('7'), kind: 'advisory.package-coverage.v1', subject: { kind: 'WORKFLOW' },
  properties: { packageName: 'pkg', packageVersion: '1.2.3', coverageState: 'UNKNOWN', coverageReason: 'SNAPSHOT_UNAVAILABLE' },
}];

describe('published scanner result schema', () => {
  it('validates canonical advisory facts and rejects incoherent projections', () => {
    const base = validResult();
    base.target.communityPackages = [{ name: 'pkg', version: '1.2.3' }];
    base.target.contextDigest = createTargetContextDigestV3(base.target);
    const facts = advisoryFacts(base.target.contextDigest);
    for (const fact of facts) expect(validatePublishedFact(fact)).toBe(true);
    expect(validateScannerResultV2({ ...base, facts: [...facts] }).ok).toBe(true);
    const [evaluation, coverage] = facts;
    expect(validatePublishedFact({ ...evaluation, properties: { ...evaluation.properties, evaluationReason: 'BOGUS' } })).toBe(false);
    expect(validateScannerResultV2({ ...base, facts: [{ ...evaluation, properties: { ...evaluation.properties, evaluationReason: 'NONE' } }, coverage] }).ok).toBe(false);
    expect(validatePublishedFact({ ...coverage, properties: { ...coverage.properties, packageVersion: null } })).toBe(true);
    expect(validateScannerResultV2({ ...base, facts: [evaluation] }).ok).toBe(false);
  });

  it('accepts every frozen field-flow vector and the destination inventory facts', () => {
    for (const fact of publishedFacts) expect(validatePublishedFact(fact)).toBe(true);
    for (const fact of [destinationV3Fact(), destinationCoverageFact()]) {
      expect(validatePublishedFact(fact)).toBe(true);
      expect(validateScannerResultV2({ ...validResult(), facts: [notRequestedAdvisoryFixture(), fact] }).ok).toBe(true);
    }
  });

  it('requires every destination inventory property in the schema and the root validator', () => {
    const v3 = destinationV3Fact();
    const coverage = destinationCoverageFact();
    const { inventoryStatus, ...withoutInventoryStatus } = v3.properties;
    const { recordsEmitted, ...withoutRecordsEmitted } = coverage.properties;
    void inventoryStatus;
    void recordsEmitted;
    const incomplete: unknown[] = [
      { ...v3, properties: withoutInventoryStatus },
      { ...coverage, properties: withoutRecordsEmitted },
      { ...v3, properties: {} },
      { ...coverage, properties: {} },
    ];
    for (const fact of incomplete) {
      expect(validatePublishedFact(fact)).toBe(false);
      expect(validateScannerResultV2({ ...validResult(), facts: [notRequestedAdvisoryFixture(), fact] }).ok).toBe(false);
    }
    // Legacy destination.v2 keeps its permissive bag in both validators.
    const legacy = { ...legacyDestinationV2Fact(), properties: { parameterPath: '/url' } };
    expect(validatePublishedFact(legacy)).toBe(true);
    expect(validateScannerResultV2({ ...validResult(), facts: [notRequestedAdvisoryFixture(), legacy] }).ok).toBe(true);
  });

  it('accepts RFC6901 empty tokens in destination paths while field-flow paths stay non-empty', () => {
    const v3 = destinationV3Fact();
    for (const parameterPath of ['/options//host', '/url/']) {
      const fact = { ...v3, properties: { ...v3.properties, parameterPath } };
      expect(validatePublishedFact(fact)).toBe(true);
      expect(validateScannerResultV2({ ...validResult(), facts: [notRequestedAdvisoryFixture(), fact] }).ok).toBe(true);
    }
    const [origin, summary, coverage] = publishedFacts;
    const emptyToken = { ...summary, properties: { ...summary.properties, sinkParameterPath: '/options//host' } };
    expect(validatePublishedFact(emptyToken)).toBe(false);
    expect(validateScannerResultV2({ ...validResult(), facts: [notRequestedAdvisoryFixture(), origin, emptyToken, coverage] }).ok).toBe(false);
  });

  it('keeps the legacy fact kinds, including the agentic dataflow summary and destination v2', () => {
    const [origin] = publishedFacts;
    expect(validatePublishedFact(legacyDestinationV2Fact())).toBe(true);
    expect(validatePublishedFact({
      factId: digest('f'), kind: 'dataflow.summary.v2', subject: origin.subject,
      properties: { flowKind: 'AGENT_INFLUENCE', propertyPathComplete: true, humanGatePresent: false, humanGateDominates: false, taintLabels: ['INBOUND_MESSAGE'] },
    })).toBe(true);
  });

  it('refuses malformed structure for the five published per-kind shapes', () => {
    const [origin, summary, coverage] = publishedFacts;
    const { sourceNodeDigest, ...withoutSourceDigest } = origin.properties;
    void sourceNodeDigest;
    const malformed: unknown[] = [
      { ...origin, properties: withoutSourceDigest },
      { ...coverage, properties: { ...coverage.properties, fieldsExamined: '2' } },
      { ...coverage, properties: { ...coverage.properties, omittedAtoms: -1 } },
      { ...summary, subject: { kind: 'WORKFLOW' } },
      { ...summary, properties: { ...summary.properties, taintChannel: 'MODEL' } },
      { ...summary, properties: { ...summary.properties, edgeChannel: 'SINK' } },
      { ...summary, properties: { ...summary.properties, propertyPathComplete: true } },
      { ...destinationV3Fact(), properties: { ...destinationV3Fact().properties, inventoryStatus: 'PARTIAL' } },
      { ...destinationCoverageFact(), properties: { ...destinationCoverageFact().properties, recordsEmitted: -1 } },
    ];
    for (const fact of malformed) expect(validatePublishedFact(fact)).toBe(false);
  });
});
