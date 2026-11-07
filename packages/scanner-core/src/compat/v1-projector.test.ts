import { describe, expect, it } from 'vitest';
import type { FindingV2, SafeFactV2, TraceV2 } from '../../../../contracts/scanner-v2-evidence';
import type { ScannerResultV2 } from '../../../../contracts/scanner-v2-result';
import type { NodeRefV2 } from '../../../../contracts/scanner-v2-source';
import { validateRequiredScanResult } from '../../../../pipeline/cli/cli-result-schema';
import { V2_PROJECTION_FIXTURE } from './__fixtures__/projection';
import { projectResultV2ToV1 } from './v1-projector';

describe('v2 to v1 projection', () => {
  it('projects the closed default result with the registered finding shape', () => {
    const projected = projectResultV2ToV1(V2_PROJECTION_FIXTURE);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result).toMatchObject({ schemaVersion: 'scanner-result-v1', scannerVersion: '2.0.0', policyProfile: 'beta-default', analysisStatus: 'COMPLETE' });
    expect(projected.result.workflow).toEqual({ name: 'Fixture workflow', nodeCount: 1, rawNodeCount: 1, annotationNodeCount: 0, triggerCount: 1, actionCount: 0, integrationCount: 0, connectionCount: 0, payloadBytes: 128, complexity: 'LOW', isSubWorkflow: false });
    expect(projected.result.functionSummary).toMatchObject({ businessCategory: 'MANUAL_AUTOMATION', confidence: 'HIGH' });
    expect(projected.result.findings[0]).toMatchObject({ policyId: 'N8N_EXECUTE_COMMAND', policyEffect: 'LEGACY_SCORE', evidence: { nodeType: 'n8n-nodes-base.executeCommand' } });
    const errors: Parameters<typeof validateRequiredScanResult>[2] = [];
    validateRequiredScanResult(projected.result as unknown as Record<string, unknown>, 'result', errors);
    expect(errors).toEqual([]);
    expect(projected.result.findings[0]?.location.sourceSpan?.start.offset).toBe(0);
  });

  it('shifts only v1 source coordinates when the original input had a leading BOM', () => {
    const projected = projectResultV2ToV1(V2_PROJECTION_FIXTURE, { hasLeadingBom: true });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result.findings[0]?.location.sourceSpan).toEqual({
      start: { line: 1, column: 2, offset: 1 },
      end: { line: 1, column: 5, offset: 4 },
    });
    expect(projectResultV2ToV1(V2_PROJECTION_FIXTURE)).toEqual(
      projectResultV2ToV1(V2_PROJECTION_FIXTURE, { hasLeadingBom: false }),
    );

    const withDiagnostic = structuredClone(V2_PROJECTION_FIXTURE);
    const subject = withDiagnostic.findings[0]?.subject;
    if (subject?.kind !== 'NODE') return;
    withDiagnostic.analysis = {
      ...withDiagnostic.analysis,
      status: 'INDETERMINATE',
      diagnostics: [{
        id: 'd'.repeat(64), code: 'REQUIRED_LIMIT_EXCEEDED', category: 'LIMIT',
        capabilityId: 'structural-policies', aggregateEffect: 'INDETERMINATE',
        assessmentEligible: false, location: subject.node.source,
      }],
    };
    const diagnosticProjection = projectResultV2ToV1(withDiagnostic, { hasLeadingBom: true });
    expect(diagnosticProjection.ok).toBe(true);
    if (!diagnosticProjection.ok) return;
    expect(diagnosticProjection.result.analysisDiagnostics[0]?.location?.sourceSpan?.start)
      .toEqual({ line: 1, column: 2, offset: 1 });
  });

  it('omits completed fields and appends only the policy sentinel for indeterminate loss', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    input.analysis = { ...input.analysis, status: 'INDETERMINATE', diagnostics: [] };
    const projected = projectResultV2ToV1(input);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result.analysisStatus).toBe('INDETERMINATE');
    expect(projected.result.riskAssessment).toBeUndefined();
    expect(projected.result.humanSummary).toBeUndefined();
    expect(projected.result.summary).toBeUndefined();
    expect(projected.result.analysisDiagnostics).toEqual([{ code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' }]);
  });

  it('rejects unregistered engine, profile, and rule identities', () => {
    expect(projectResultV2ToV1({ ...V2_PROJECTION_FIXTURE, engine: { ...V2_PROJECTION_FIXTURE.engine, version: '9.9.9' } })).toMatchObject({ ok: false, reason: 'UNKNOWN_ENGINE' });
    expect(projectResultV2ToV1({ ...V2_PROJECTION_FIXTURE, profile: { id: 'beta-hardened', version: '2.0.0' } })).toMatchObject({ ok: false, reason: 'UNKNOWN_PROFILE' });
    expect(projectResultV2ToV1({ ...V2_PROJECTION_FIXTURE, findings: [{ ...V2_PROJECTION_FIXTURE.findings[0]!, ruleId: 'UNKNOWN_RULE' }] })).toMatchObject({ ok: false, reason: 'UNKNOWN_RULE' });
  });

  it('is deterministic when findings and facts arrive in a different order', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    input.facts = [...input.facts].reverse();
    input.findings = [...input.findings].reverse();
    expect(projectResultV2ToV1(input)).toEqual(projectResultV2ToV1(V2_PROJECTION_FIXTURE));
  });
  it('maps indeterminate diagnostics before adding one policy sentinel', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    input.analysis = { ...input.analysis, diagnostics: [{ id: 'c'.repeat(64), code: 'REQUIRED_LIMIT_EXCEEDED', category: 'LIMIT', capabilityId: 'structural-policies', aggregateEffect: 'INDETERMINATE', assessmentEligible: false }] };
    const projected = projectResultV2ToV1(input);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result.analysisStatus).toBe('INDETERMINATE');
    expect(projected.result.analysisDiagnostics).toEqual([{ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' }, { code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' }]);
  });

  it('turns missing descriptive risk facts into compatibility loss', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    input.facts = input.facts.filter((fact) => fact.kind !== 'workflow.risk-summary.v1');
    const projected = projectResultV2ToV1(input);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result.analysisStatus).toBe('INDETERMINATE');
    expect(projected.result.riskAssessment).toBeUndefined();
    expect(projected.result.analysisDiagnostics).toContainEqual({ code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' });
  });
  it('projects lowercase multi-label destination hostnames', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    const subject = input.findings[0]?.subject;
    if (subject?.kind !== 'NODE') return;
    const destinationId = 'f'.repeat(64);
    input.facts = [...input.facts, { factId: destinationId, kind: 'destination.v2', subject: { kind: 'SOURCE', source: subject.node.source }, properties: { parameterPath: '/url', scheme: 'HTTPS', hostname: 'example.com', authorityState: 'KNOWN', valueMode: 'LITERAL' } }];
    input.findings = [...input.findings, { ...input.findings[0]!, findingId: '1'.repeat(64), ruleId: 'UNAPPROVED_DOMAIN', severity: 'MEDIUM', confidence: 'HIGH', evidenceClass: 'CONFIGURATION', subject: { kind: 'SOURCE', source: subject.node.source }, factRefs: [destinationId] }];
    const projected = projectResultV2ToV1(input);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result.findings.find((finding) => finding.policyId === 'UNAPPROVED_DOMAIN')).toMatchObject({ evidence: { domain: 'example.com' } });
  });

  it('rejects incomplete non-descriptive security facts as unsafe input', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    input.facts = input.facts.map((fact) => fact.kind === 'node.capability.v2' ? { ...fact, properties: Object.fromEntries(Object.entries(fact.properties).filter(([key]) => key !== 'nodePackage')) } : fact);
    expect(projectResultV2ToV1(input)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
  });

  it('converts degraded results without mapped diagnostics into indeterminate loss', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    input.analysis = { ...input.analysis, status: 'DEGRADED', diagnostics: [] };
    const projected = projectResultV2ToV1(input);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result.analysisStatus).toBe('INDETERMINATE');
    expect(projected.result.analysisDiagnostics).toEqual([{ code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' }]);
    const errors: Parameters<typeof validateRequiredScanResult>[2] = [];
    validateRequiredScanResult(projected.result as unknown as Record<string, unknown>, 'result', errors);
    expect(errors).toEqual([]);
  });

  it('turns duplicate descriptive risk facts into compatibility loss', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    const risk = input.facts.find((fact) => fact.kind === 'workflow.risk-summary.v1');
    if (!risk) return;
    input.facts = [...input.facts, { ...risk, factId: 'f'.repeat(64) }];
    const projected = projectResultV2ToV1(input);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result.analysisStatus).toBe('INDETERMINATE');
    expect(projected.result.riskAssessment).toBeUndefined();
    expect(projected.result.analysisDiagnostics).toContainEqual({ code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' });
    const errors: Parameters<typeof validateRequiredScanResult>[2] = [];
    validateRequiredScanResult(projected.result as unknown as Record<string, unknown>, 'result', errors);
    expect(errors).toEqual([]);
  });

  it('rejects accessor-backed findings before reading nested fields', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    const finding = { ...input.findings[0]! };
    Object.defineProperty(finding, 'ruleId', { enumerable: true, get: () => { throw new Error('accessed'); } });
    input.findings = [finding];
    expect(projectResultV2ToV1(input)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
  });

  it('rejects reversed source spans as unsafe input', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    const finding = input.findings[0]!;
    if (finding.subject.kind !== 'NODE' || !finding.subject.node.source.span) return;
    finding.subject.node.source.span = { ...finding.subject.node.source.span, end: { ...finding.subject.node.source.span.end, utf16Offset: -1 } };
    expect(projectResultV2ToV1(input)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
  });
  it('sorts integration services and nested node types canonically', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    input.workflow = { ...input.workflow, integrationCount: 1 };
    input.facts = [...input.facts, { factId: 'f'.repeat(64), kind: 'integration.v1', subject: { kind: 'WORKFLOW' }, properties: { service: 'Zed', usage: 'Uses Zed', nodeTypes: ['n8n-nodes-base.zed', 'n8n-nodes-base.alpha'], nodeCount: 1, riskNotes: [] } }];
    const projected = projectResultV2ToV1(input);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result.integrations[0]).toMatchObject({ service: 'Zed', nodeTypes: ['n8n-nodes-base.alpha', 'n8n-nodes-base.zed'] });
  });
});

type FieldFlowChannel = 'CONFIDENTIALITY' | 'INTEGRITY';
type TaintCase = Readonly<{
  ruleId: string; sinkClass: string; parameterPath: string; sinkFieldPath: string[];
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM'; confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  channel: FieldFlowChannel; taintLabels: string[];
}>;
const CONFIDENTIALITY_LABELS = ['WEBHOOK_BODY', 'WEBHOOK_QUERY'];
const INTEGRITY_LABELS = ['MODEL_OUTPUT'];
const TAINT_CASES: readonly TaintCase[] = [
  { ruleId: 'TAINTED_COMMAND', sinkClass: 'COMMAND', parameterPath: '/command', sinkFieldPath: ['command'], severity: 'CRITICAL', confidence: 'MEDIUM', channel: 'CONFIDENTIALITY', taintLabels: CONFIDENTIALITY_LABELS },
  { ruleId: 'TAINTED_SQL_QUERY', sinkClass: 'SQL', parameterPath: '/query', sinkFieldPath: ['query'], severity: 'HIGH', confidence: 'MEDIUM', channel: 'CONFIDENTIALITY', taintLabels: CONFIDENTIALITY_LABELS },
  { ruleId: 'TAINTED_REQUEST_URL', sinkClass: 'SSRF', parameterPath: '/url', sinkFieldPath: ['url'], severity: 'HIGH', confidence: 'MEDIUM', channel: 'CONFIDENTIALITY', taintLabels: CONFIDENTIALITY_LABELS },
  { ruleId: 'TAINTED_FILE_PATH', sinkClass: 'PATH', parameterPath: '/path', sinkFieldPath: ['path'], severity: 'HIGH', confidence: 'MEDIUM', channel: 'CONFIDENTIALITY', taintLabels: CONFIDENTIALITY_LABELS },
  { ruleId: 'TAINTED_CODE_INPUT', sinkClass: 'CODE', parameterPath: '/code', sinkFieldPath: ['code'], severity: 'HIGH', confidence: 'MEDIUM', channel: 'CONFIDENTIALITY', taintLabels: CONFIDENTIALITY_LABELS },
  { ruleId: 'TAINTED_REQUEST_HEADER', sinkClass: 'HEADER', parameterPath: '/headers', sinkFieldPath: ['headers'], severity: 'MEDIUM', confidence: 'MEDIUM', channel: 'CONFIDENTIALITY', taintLabels: CONFIDENTIALITY_LABELS },
  { ruleId: 'TAINTED_AI_PROMPT', sinkClass: 'PROMPT', parameterPath: '/prompt', sinkFieldPath: ['prompt'], severity: 'MEDIUM', confidence: 'LOW', channel: 'INTEGRITY', taintLabels: INTEGRITY_LABELS },
];
type SummaryOverrides = Readonly<Record<string, string | number | readonly string[]>>;
type FieldFlowParts = { facts: SafeFactV2[]; findings: FindingV2[]; traces: TraceV2[]; source: NodeRefV2; sink: NodeRefV2; provenance: SafeFactV2; summary: SafeFactV2 };
const hex = (seed: number): string => seed.toString(16).padStart(64, '0');

function nodeRef(ordinal: number, explicitId?: string, name?: string): NodeRefV2 {
  const offset = ordinal * 100;
  return {
    ordinal,
    ...(explicitId === undefined ? {} : { explicitId }),
    ...(name === undefined ? {} : { name }),
    identityDigest: hex(0x1000 + ordinal),
    source: {
      pointer: `/nodes/${ordinal}`,
      occurrencePath: [0, ordinal],
      astNodeId: hex(0x2000 + ordinal),
      span: {
        start: { line: 1, column: offset + 1, utf16Offset: offset, utf8ByteOffset: offset },
        end: { line: 1, column: offset + 4, utf16Offset: offset + 3, utf8ByteOffset: offset + 3 },
      },
    },
  };
}

function provenanceFact(factId: string, node: NodeRefV2, channel: FieldFlowChannel, taintLabels: readonly string[]): SafeFactV2 {
  return {
    factId,
    kind: 'dataflow.provenance.v1',
    subject: { kind: 'NODE', node },
    properties: { sourceNodeOrdinal: node.ordinal, sourceNodeDigest: node.identityDigest, sourceFieldPath: ['body', 'value'], taintChannel: channel, taintLabels: [...taintLabels] },
  };
}

function summaryFact(factId: string, sink: NodeRefV2, origin: SafeFactV2, overrides: SummaryOverrides = {}): SafeFactV2 {
  const properties: SafeFactV2['properties'] = {
    flowKind: 'TAINT_SINK', sinkClass: 'COMMAND', sinkParameterPath: '/command', sinkChannel: 'DATA', edgeChannel: 'DATA',
    taintChannel: origin.properties.taintChannel!, taintLabels: origin.properties.taintLabels!,
    sourceProvenanceFactId: origin.factId, sourceNodeOrdinal: origin.properties.sourceNodeOrdinal!,
    sourceNodeDigest: origin.properties.sourceNodeDigest!, sourceFieldPath: origin.properties.sourceFieldPath!,
    sinkFieldPath: ['command'], knowledge: 'KNOWN', unknownReasons: [], omittedAtoms: 0, omittedSanitizers: 0,
    sanitizedFor: [], reachability: 'CONFIGURED', ...overrides,
  };
  return { factId, kind: 'dataflow.summary.v3', subject: { kind: 'NODE', node: sink }, properties };
}

function taintFinding(findingId: string, rule: TaintCase, sink: NodeRefV2, factRefs: string[], traceRefs: string[] = []): FindingV2 {
  return {
    findingId, ruleId: rule.ruleId, ruleRevision: '1', effect: 'REPORT_ONLY', severity: rule.severity, confidence: rule.confidence,
    evidenceClass: 'POTENTIAL_DATAFLOW', conclusion: 'OBSERVED', applicability: 'APPLICABLE',
    subject: { kind: 'NODE', node: sink }, factRefs, traceRefs, remediationId: 'r',
  };
}

function traceFact(traceId: string, channel: FieldFlowChannel, source: NodeRefV2, sink: NodeRefV2, provenanceFactId: string, summaryFactId: string): TraceV2 {
  return {
    traceId, kind: channel,
    steps: [
      { ordinal: 0, kind: 'SOURCE', subject: { kind: 'NODE', node: source }, factRefs: [provenanceFactId] },
      { ordinal: 1, kind: 'SINK', subject: { kind: 'NODE', node: sink }, factRefs: [summaryFactId] },
    ],
  };
}

/** One v3 summary plus the provenance it references, shaped like a real migrated taint result. */
function fieldFlowResult(rule: TaintCase, overrides: SummaryOverrides = {}, edit?: (parts: FieldFlowParts) => void): ScannerResultV2 {
  const input = structuredClone(V2_PROJECTION_FIXTURE);
  const source = nodeRef(0, 'source', 'Source');
  const sink = nodeRef(1, 'sink', 'Sink');
  const provenance = provenanceFact(hex(0x11), source, rule.channel, rule.taintLabels);
  const summary = summaryFact(hex(0x12), sink, provenance, { sinkClass: rule.sinkClass, sinkParameterPath: rule.parameterPath, sinkFieldPath: rule.sinkFieldPath, ...overrides });
  const parts: FieldFlowParts = {
    facts: [...input.facts, provenance, summary],
    findings: [...input.findings, taintFinding(hex(0x21), rule, sink, [summary.factId])],
    traces: [...input.traces], source, sink, provenance, summary,
  };
  edit?.(parts);
  return { ...input, facts: parts.facts, findings: parts.findings, traces: parts.traces };
}

/** Every migrated taint rule, each with its own sink summary and shared channel origin. */
function sevenTaintResult(): ScannerResultV2 {
  const input = structuredClone(V2_PROJECTION_FIXTURE);
  const source = nodeRef(0, 'source', 'Source');
  const origins = new Map<string, SafeFactV2>();
  const facts: SafeFactV2[] = [];
  const findings: FindingV2[] = [];
  const originFor = (rule: TaintCase): SafeFactV2 => {
    const key = `${rule.channel}:${rule.taintLabels.join(',')}`;
    const existing = origins.get(key);
    if (existing) return existing;
    const created = provenanceFact(hex(0x11 + origins.size), source, rule.channel, rule.taintLabels);
    origins.set(key, created);
    facts.push(created);
    return created;
  };
  TAINT_CASES.forEach((rule, index) => {
    const sink = nodeRef(index + 1, `sink-${index}`, `Sink ${index}`);
    const origin = originFor(rule);
    const summary = summaryFact(hex(0x40 + index), sink, origin, { sinkClass: rule.sinkClass, sinkParameterPath: rule.parameterPath, sinkFieldPath: rule.sinkFieldPath });
    facts.push(summary);
    findings.push(taintFinding(hex(0x80 + index), rule, sink, [summary.factId]));
  });
  return { ...input, facts: [...input.facts, ...facts], findings: [...input.findings, ...findings] };
}

function taintEvidence(result: { ok: true; result: { findings: readonly { policyId: string; evidence: Readonly<Record<string, unknown>> }[] } } | { ok: false }, ruleId: string) {
  if (!result.ok) return undefined;
  return result.result.findings.find((finding) => finding.policyId === ruleId);
}

describe('v2 to v1 field-flow projection', () => {
  it('projects every migrated v3 taint summary onto the legacy evidence keys', () => {
    const projected = projectResultV2ToV1(sevenTaintResult());
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result.analysisStatus).toBe('COMPLETE');
    for (const rule of TAINT_CASES) {
      const finding = projected.result.findings.find((entry) => entry.policyId === rule.ruleId);
      expect(finding?.evidence).toEqual({
        sink: rule.sinkClass,
        parameterPath: rule.parameterPath,
        taintLabels: rule.taintLabels,
        sourceNodeId: 'source',
        sourceNodeName: 'Source',
      });
    }
  });

  it('emits the optional property path only when the summary carries one', () => {
    const withPath = projectResultV2ToV1(fieldFlowResult(TAINT_CASES[1]!, { propertyPath: '/body/value' }));
    expect(taintEvidence(withPath, 'TAINTED_SQL_QUERY')?.evidence).toEqual({
      sink: 'SQL', parameterPath: '/query', propertyPath: '/body/value', taintLabels: CONFIDENTIALITY_LABELS, sourceNodeId: 'source', sourceNodeName: 'Source',
    });
    const root = projectResultV2ToV1(fieldFlowResult(TAINT_CASES[0]!, { sinkParameterPath: '' }));
    expect(taintEvidence(root, 'TAINTED_COMMAND')?.evidence).toMatchObject({ parameterPath: '' });
    expect(taintEvidence(root, 'TAINTED_COMMAND')?.evidence).not.toHaveProperty('referenceRoot');
    expect(taintEvidence(root, 'TAINTED_COMMAND')?.evidence).not.toHaveProperty('propertyPathComplete');
  });

  it('takes source labels only from the referenced provenance subject', () => {
    const projected = projectResultV2ToV1(fieldFlowResult(TAINT_CASES[0]!, {}, (parts) => {
      parts.facts = parts.facts.map((fact) => fact.factId === parts.provenance.factId ? { ...fact, subject: { kind: 'NODE', node: nodeRef(0) } } : fact);
    }));
    const evidence = taintEvidence(projected, 'TAINTED_COMMAND')?.evidence;
    expect(evidence).toEqual({ sink: 'COMMAND', parameterPath: '/command', taintLabels: CONFIDENTIALITY_LABELS });
    expect(evidence).not.toHaveProperty('sourceNodeId');
    expect(evidence).not.toHaveProperty('sourceNodeName');
  });

  it('refuses dangling, mismatched, and malformed field-flow evidence', () => {
    const refused = (input: ScannerResultV2, reason: string) => expect(projectResultV2ToV1(input)).toMatchObject({ ok: false, reason });
    refused(fieldFlowResult(TAINT_CASES[0]!, { sourceProvenanceFactId: hex(0xdead) }), 'INVALID_RESULT');
    refused(fieldFlowResult(TAINT_CASES[0]!, { sourceFieldPath: ['body', 'other'] }), 'INVALID_RESULT');
    refused(fieldFlowResult(TAINT_CASES[0]!, { taintLabels: ['WEBHOOK_QUERY'] }), 'INVALID_RESULT');
    refused(fieldFlowResult(TAINT_CASES[0]!, { sinkClass: 'SHELL' }), 'UNSAFE_INPUT');
    refused(fieldFlowResult(TAINT_CASES[0]!, {}, (parts) => {
      parts.facts = parts.facts.map((fact) => fact.factId === parts.provenance.factId ? { ...fact, subject: { kind: 'NODE', node: nodeRef(2) } } : fact);
    }), 'UNSAFE_INPUT');
  });

  it('never republishes an unsafe path canary', () => {
    for (const canary of ['/../etc/passwd', '/body/api_key=AKIAABCDEFGHIJKLMNOP']) {
      const projected = projectResultV2ToV1(fieldFlowResult(TAINT_CASES[0]!, { sinkParameterPath: canary }));
      expect(projected).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
      expect(JSON.stringify(projected)).not.toContain(canary);
    }
  });

  it('retains a supported UNKNOWN sink summary instead of dropping the finding', () => {
    const projected = projectResultV2ToV1(fieldFlowResult(TAINT_CASES[2]!, { knowledge: 'UNKNOWN', unknownReasons: ['UNMODELLED_TRANSFER'] }));
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result.analysisStatus).toBe('INDETERMINATE');
    expect(taintEvidence(projected, 'TAINTED_REQUEST_URL')?.evidence).toEqual({
      sink: 'SSRF', parameterPath: '/url', taintLabels: CONFIDENTIALITY_LABELS, sourceNodeId: 'source', sourceNodeName: 'Source',
    });
  });

  it('accepts no-trace and matching-trace findings but refuses a mismatched witness', () => {
    const noTrace = projectResultV2ToV1(fieldFlowResult(TAINT_CASES[0]!));
    expect(taintEvidence(noTrace, 'TAINTED_COMMAND')?.evidence).toMatchObject({ sink: 'COMMAND' });
    const traced = projectResultV2ToV1(fieldFlowResult(TAINT_CASES[0]!, {}, (parts) => {
      const traceId = hex(0x31);
      const finding = parts.findings[parts.findings.length - 1]!;
      parts.findings = [...parts.findings.slice(0, -1), { ...finding, traceRefs: [traceId] }];
      parts.traces = [...parts.traces, traceFact(traceId, 'CONFIDENTIALITY', parts.source, parts.sink, parts.provenance.factId, parts.summary.factId)];
    }));
    expect(taintEvidence(traced, 'TAINTED_COMMAND')?.evidence).toMatchObject({ sink: 'COMMAND' });
    const mismatched = projectResultV2ToV1(fieldFlowResult(TAINT_CASES[0]!, {}, (parts) => {
      const traceId = hex(0x32);
      const finding = parts.findings[parts.findings.length - 1]!;
      parts.findings = [...parts.findings.slice(0, -1), { ...finding, traceRefs: [traceId] }];
      parts.traces = [...parts.traces, traceFact(traceId, 'INTEGRITY', parts.source, parts.sink, parts.provenance.factId, parts.summary.factId)];
    }));
    expect(mismatched).toMatchObject({ ok: false, reason: 'INVALID_RESULT' });
  });

  it('refuses a finding attributed to another sink even without a witness', () => {
    const input = fieldFlowResult(TAINT_CASES[0]!, {}, (parts) => {
      const finding = parts.findings[parts.findings.length - 1]!;
      parts.findings = [...parts.findings.slice(0, -1), { ...finding, subject: { kind: 'NODE', node: parts.source } }];
    });
    expect(projectResultV2ToV1(input)).toMatchObject({ ok: false, reason: 'INVALID_RESULT' });
  });

  it('refuses duplicate witness identities and step ordinals in either order', () => {
    for (const reverse of [false, true]) {
      const input = fieldFlowResult(TAINT_CASES[0]!, {}, (parts) => {
        const traceId = hex(0x61);
        const finding = parts.findings[parts.findings.length - 1]!;
        parts.findings = [...parts.findings.slice(0, -1), { ...finding, traceRefs: [traceId] }];
        const good = traceFact(traceId, 'CONFIDENTIALITY', parts.source, parts.sink, parts.provenance.factId, parts.summary.factId);
        const wrong = { ...good, kind: 'INTEGRITY' as const };
        parts.traces = reverse ? [good, wrong] : [wrong, good];
      });
      expect(projectResultV2ToV1(input)).toMatchObject({ ok: false });
    }
    const duplicateOrdinal = fieldFlowResult(TAINT_CASES[0]!, {}, (parts) => {
      const traceId = hex(0x62);
      const finding = parts.findings[parts.findings.length - 1]!;
      parts.findings = [...parts.findings.slice(0, -1), { ...finding, traceRefs: [traceId] }];
      const good = traceFact(traceId, 'CONFIDENTIALITY', parts.source, parts.sink, parts.provenance.factId, parts.summary.factId);
      parts.traces = [{ ...good, steps: [good.steps[0]!, { ...good.steps[1]!, ordinal: 0 }] }];
    });
    expect(projectResultV2ToV1(duplicateOrdinal)).toMatchObject({ ok: false });
  });

  it('preserves canonical visible source names and refuses invisible labels', () => {
    const renamed = (name: string) => fieldFlowResult(TAINT_CASES[0]!, {}, (parts) => {
      const provenance = { ...parts.provenance, subject: { kind: 'NODE' as const, node: { ...parts.source, name } } };
      parts.facts = parts.facts.map((fact) => fact.factId === provenance.factId ? provenance : fact);
    });
    expect(taintEvidence(projectResultV2ToV1(renamed('Function')), 'TAINTED_COMMAND')?.evidence.sourceNodeName).toBe('Function');
    expect(projectResultV2ToV1(renamed('Source\u200b'))).toMatchObject({ ok: false });
  });

  it('refuses credential-like node metadata before projection', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    input.facts = input.facts.map((fact) => fact.kind === 'node.capability.v2'
      ? { ...fact, properties: { ...fact.properties, nodeType: 'Basic dXNlcjpwYXNz' } } : fact);
    expect(projectResultV2ToV1(input)).toMatchObject({ ok: false });
  });

  it('leaves the native default and agentic v2 projections unchanged', () => {
    const baseline = projectResultV2ToV1(V2_PROJECTION_FIXTURE);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(baseline.result.analysisStatus).toBe('COMPLETE');
    expect(baseline.result.findings.map((finding) => finding.policyId)).toEqual(['N8N_EXECUTE_COMMAND']);

    const input = structuredClone(V2_PROJECTION_FIXTURE);
    const subject = input.findings[0]!.subject;
    const capability = input.facts.find((fact) => fact.kind === 'node.capability.v2')!;
    const agentSummary: SafeFactV2 = {
      factId: hex(0x41), kind: 'dataflow.summary.v2', subject,
      properties: { flowKind: 'AGENT_INFLUENCE', propertyPathComplete: true, humanGatePresent: false, humanGateDominates: false, taintLabels: ['WEBHOOK_BODY'] },
    };
    input.facts = [...input.facts, agentSummary];
    input.findings = [...input.findings, {
      findingId: hex(0x42), ruleId: 'AI_AGENT_UNGATED_TOOL', ruleRevision: '1', effect: 'REPORT_ONLY', severity: 'MEDIUM', confidence: 'LOW',
      evidenceClass: 'CAPABILITY', conclusion: 'OBSERVED', applicability: 'APPLICABLE', subject,
      factRefs: [capability.factId, agentSummary.factId], traceRefs: [], remediationId: 'r',
    }];
    const agentic = projectResultV2ToV1(input);
    expect(agentic.ok).toBe(true);
    if (!agentic.ok) return;
    expect(agentic.result.analysisStatus).toBe('COMPLETE');
    expect(agentic.result.findings.find((finding) => finding.policyId === 'AI_AGENT_UNGATED_TOOL')?.evidence).toEqual({
      toolCount: 0, contextCount: 0, taintLabels: ['WEBHOOK_BODY'], humanGatePresent: false, humanGateDominates: false,
    });
  });

  it('ignores traces that no field-flow finding references', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    input.findings = [{ ...input.findings[0]!, traceRefs: [hex(0x51)] }];
    input.traces = [{ traceId: hex(0x52) } as unknown as TraceV2];
    const projected = projectResultV2ToV1(input);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result.analysisStatus).toBe('COMPLETE');
  });

  it('surfaces a stale v2 taint summary as indeterminate projection loss', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    const subject = input.findings[0]!.subject;
    const legacySummary: SafeFactV2 = {
      factId: hex(0x61), kind: 'dataflow.summary.v2', subject,
      properties: { flowKind: 'TAINT_SINK', sink: 'COMMAND', parameterPath: '/command', referenceRoot: 'DYNAMIC_NODE', propertyPathComplete: true, humanGatePresent: false, humanGateDominates: false, taintLabels: ['WEBHOOK_BODY'] },
    };
    input.facts = [...input.facts, legacySummary];
    input.findings = [...input.findings, {
      findingId: hex(0x62), ruleId: 'TAINTED_COMMAND', ruleRevision: '1', effect: 'REPORT_ONLY', severity: 'CRITICAL', confidence: 'MEDIUM',
      evidenceClass: 'POTENTIAL_DATAFLOW', conclusion: 'OBSERVED', applicability: 'APPLICABLE', subject,
      factRefs: [legacySummary.factId], traceRefs: [], remediationId: 'r',
    }];
    const projected = projectResultV2ToV1(input);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result.analysisStatus).toBe('INDETERMINATE');
    expect(projected.result.findings.some((finding) => finding.policyId === 'TAINTED_COMMAND')).toBe(false);
  });

  it('refuses unsupported agentic labels rather than publishing them as evidence', () => {
    const input = structuredClone(V2_PROJECTION_FIXTURE);
    const subject = input.findings[0]!.subject;
    const node = input.facts.find((fact) => fact.kind === 'node.capability.v2')!;
    const summary: SafeFactV2 = {
      factId: hex(0x71), kind: 'dataflow.summary.v2', subject,
      properties: { flowKind: 'AGENT_INFLUENCE', propertyPathComplete: true, humanGatePresent: false, humanGateDominates: false, taintLabels: ['NOT_A_LABEL'] },
    };
    input.facts = [...input.facts, summary];
    input.findings = [...input.findings, {
      findingId: hex(0x72), ruleId: 'AI_AGENT_UNGATED_TOOL', ruleRevision: '1', effect: 'REPORT_ONLY', severity: 'MEDIUM', confidence: 'LOW',
      evidenceClass: 'CAPABILITY', conclusion: 'OBSERVED', applicability: 'APPLICABLE', subject,
      factRefs: [node.factId, summary.factId], traceRefs: [], remediationId: 'r',
    }];
    expect(projectResultV2ToV1(input)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
  });
});
