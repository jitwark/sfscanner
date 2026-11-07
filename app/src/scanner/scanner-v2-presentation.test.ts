// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import { projectResultV2ToV1 } from '@hub/scanner-core/compat/v1-projector';
import { validateScannerResultV2, type FindingV2, type SafeFactV2, type ScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import type { NodeRefV2, SourceSpanV2, SubjectV2 } from '@hub/contracts/scanner-v2-source';
import { toScannerReportModelV2, type ScannerReportModelV2 } from './scanner-v2-presentation';
import { evidenceEntries } from './report/report-safe-content';
import { isReportIncomplete } from './report/report-blocks';
import { sourceSpanLabel } from './report-v2/report-evidence';

function scan(json: string) {
  const result = scanWorkflowV2({ bytes: new TextEncoder().encode(json), profile: { id: 'beta-default', version: '2.0.0' } });
  if (!result.ok) throw new Error(result.message);
  return result.result;
}
const risky = JSON.stringify({
  nodes: [{ id: 'command', name: 'Run', type: 'n8n-nodes-base.executeCommand', parameters: { command: 'echo hello' } }],
  connections: {},
});
/** The genuinely ungraded envelope: an unmodelled node the scanner refuses to read, because its
 *  `parameters` member is not an object (ADR-generic-node-semantic-fallback §4 — the fallback is
 *  refused and `assessment` stays null). A *readable* unmodelled node now grades DEGRADED (§2), so
 *  it can no longer stand for the withheld-verdict state. */
const unknown = JSON.stringify({
  nodes: [{ id: 'custom', name: 'Custom', type: '@example/custom-node.unknown', parameters: 'not-an-object' }],
  connections: {},
});
/** One confirmed secret: the admitted rule whose rendered evidence carries `secretKind`. */
const secretJson = JSON.stringify({ nodes: [{ id: 'http-1', name: 'Call API', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, parameters: { apiKey: 'sk_live_super_secret_value' } }], connections: {} });
/** A `workflow.risk-summary.v1` fact no admitted capability emits, so every real envelope projects as
 *  INDETERMINATE with no grade (B4a report, F-C). Supplying it exercises the graded path. */
const RISK_SUMMARY_FACT: SafeFactV2 = { factId: 'b'.repeat(64), kind: 'workflow.risk-summary.v1', subject: { kind: 'WORKFLOW' }, properties: { topRisks: ['Hard-coded credential'], dataExposure: 'No external exposure was identified.', complexityDrivers: ['Single action node'] } };
const withRiskSummary = (result: ScannerResultV2): ScannerResultV2 => ({ ...result, facts: [...result.facts, RISK_SUMMARY_FACT] });
/** The optional-loss envelope B3 composed with the real composer, which every admitted beta-default
 *  run cannot reach (all rows required); the host's validator decides whether it is legal. */
function degradedEnvelope(result: ScannerResultV2): ScannerResultV2 {
  const diagnosticId = 'a'.repeat(64);
  const diagnostic: ScannerResultV2['analysis']['diagnostics'][number] = { id: diagnosticId, code: 'OPTIONAL_LIMIT_EXCEEDED', category: 'LIMIT', capabilityId: 'javascript-security', aggregateEffect: 'DEGRADED', assessmentEligible: true, observed: 1, maximum: 0, omitted: 1 };
  const row: ScannerResultV2['analysis']['capabilities'][number] = { id: 'javascript-security', version: '2.0.0', required: false, status: 'DEGRADED', seen: 1, analyzed: 0, skipped: 0, omitted: 1, diagnosticIds: [diagnosticId] };
  const rows = result.analysis.capabilities;
  const at = rows.findIndex(({ id }) => id === 'assessment');
  return { ...result, analysis: { status: 'DEGRADED', capabilities: [...rows.slice(0, at), row, ...rows.slice(at)], diagnostics: [diagnostic] }, stats: { ...result.stats, omittedFindings: 1 } };
}

/** The same node reference with the span the case under test needs (a boundary end, or none). */
const subjectWithSpan = (node: NodeRefV2, span: SourceSpanV2 | null): SubjectV2 => ({ kind: 'NODE', node: { ...node, source: { ...node.source, span } } });
const nodeSubjectOf = (result: ScannerResultV2) => {
  const finding = result.findings.find(({ subject }) => subject.kind === 'NODE');
  if (!finding || finding.subject.kind !== 'NODE') throw new Error('Expected a node-subject finding');
  return { finding, node: finding.subject.node };
};

describe('toScannerReportModelV2', () => {
  it('uses the core projector as the v1 authority while preserving v2 metadata', () => {
    const result = scan(risky);
    const projection = projectResultV2ToV1(result);
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    const model: ScannerReportModelV2 = toScannerReportModelV2(result);
    const { v2, limits, assessment, ...legacy } = model;
    expect(legacy).toEqual(projection.result);
    expect(v2).toEqual(result);
    expect(limits).toEqual(result.limits);
    expect(assessment).toEqual(result.assessment);
    expect(model.findings[0]?.location.sourceSpan).toBeDefined();
    expect(model.v2.findings[0]?.evidenceClass).toBe(result.findings[0]?.evidenceClass);
    expect(model.v2.findings[0]?.factRefs).toEqual(result.findings[0]?.factRefs);
    expect(model.v2.traces).toEqual(result.traces);
  });

  it('does not expose projection failure details as a clean result', () => {
    const result = structuredClone(scan(risky));
    result.engine = { ...result.engine, version: '9.9.9' };
    const model = toScannerReportModelV2(result);
    expect(model.analysisStatus).toBe('INDETERMINATE');
    expect(model.analysisDiagnostics).toEqual([{ code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' }]);
    expect(model.findings).toEqual([]);
    expect(model.riskAssessment).toBeUndefined();
    expect(model.summary).toBeUndefined();
    expect(model.humanSummary).toBeUndefined();
    expect(JSON.stringify(model)).not.toContain('UNKNOWN_ENGINE');
  });

  it('keeps v2 coordinates while projecting original-input coordinates to v1', () => {
    const result = scan(`\uFEFF${risky}`);
    const model = toScannerReportModelV2(result, { hasLeadingBom: true });
    const v2Span = result.findings[0]?.subject.kind === 'NODE'
      ? result.findings[0].subject.node.source.span
      : null;
    const v1Span = model.findings[0]?.location.sourceSpan;
    expect(v2Span).not.toBeNull();
    expect(model.v2).toEqual(result);
    if (!v2Span || !v1Span) throw new Error('Expected source spans for the risky finding');
    const { start, end } = v2Span;
    expect(v1Span.start.offset).toBe(start.utf16Offset + 1);
    expect(v1Span.end.offset).toBe(end.utf16Offset + 1);
    expect(v1Span.start.column).toBe(start.column + 1);
    expect(v1Span.end.column).toBe(end.column + 1);
  });

  it('does not turn unknown or null assessment into a reassuring v1 grade', () => {
    const result = scan(unknown);
    expect(result.analysis.status).toBe('INDETERMINATE');
    expect(result.assessment).toBeNull();
    const model = toScannerReportModelV2(result);
    expect(model.analysisStatus).toBe('INDETERMINATE');
    expect(model.riskAssessment).toBeUndefined();
    expect(model.summary).toBeUndefined();
    expect(model.humanSummary).toBeUndefined();
  });

  /**
   * Field-to-render map for the v2 sections: each group names its result field and the component that
   * reads it. Mutations caught: a field dropped, renamed or substituted by the model builder or by
   * `projectResultV2ToV1` (e.g. `result.workflow` where `result.limits` belongs).
   */
  it('projects each v2 report section from the result field it names', () => {
    const result = scan(secretJson);
    const model = toScannerReportModelV2(result);
    const { finding, node } = nodeSubjectOf(result);
    const span = node.source.span;
    if (!span) throw new Error('Expected a source span');
    // Identity and the v1 finding list survive into the model the report renders.
    expect([model.scannerVersion, model.policyProfile, model.findings.length]).toEqual([result.engine.version, result.profile.id, result.findings.length]);
    // Coverage status badge, capability rows and the omissions total the coverage section computes.
    expect(model.v2.analysis.status).toBe('COMPLETE');
    expect(model.v2.analysis.capabilities.every(({ required }) => required)).toBe(true);
    expect(model.v2.limits.usage.reduce((total, row) => total + row.omitted, 0) + model.v2.stats.omittedFindings).toBe(0);
    // Applicability verdicts and the advisory-fact list they are qualified against.
    expect(model.v2.findings.map(({ applicability }) => applicability)).toEqual(result.findings.map(({ applicability }) => applicability));
    // Evidence class/conclusion/references, and the coordinates the sections render verbatim.
    expect([model.v2.findings[0]?.evidenceClass, model.v2.findings[0]?.conclusion]).toEqual([finding.evidenceClass, finding.conclusion]);
    expect(sourceSpanLabel(finding.subject)).toBe(`Source span: line ${span.start.line}, column ${span.start.column} to line ${span.end.line}, column ${span.end.column}`);
    // The same span in the v1 coordinates the legacy findings section renders.
    expect(model.findings[0]?.location.sourceSpan).toEqual({ start: { line: 1, column: 11, offset: 10 }, end: { line: 1, column: 149, offset: 148 } });
    // The model carries the secret's classification, never the secret itself.
    expect(JSON.stringify(model)).not.toContain('sk_live_super_secret_value');
  });
  /** Mutations caught: a lossy envelope collapsed to COMPLETE, a graded envelope rendered in the withheld shape, and an indeterminate envelope gaining a grade. */
  it('renders complete, degraded and indeterminate envelopes as distinct states', () => {
    const complete = toScannerReportModelV2(withRiskSummary(scan(secretJson)));
    expect([complete.v2.analysis.status, complete.analysisStatus]).toEqual(['COMPLETE', 'COMPLETE']);
    expect(complete.riskAssessment?.grade).toBe(complete.assessment?.grade);
    expect(isReportIncomplete(complete)).toBe(false);
    const indeterminate = scan(unknown);
    const withheld = toScannerReportModelV2(indeterminate);
    expect(indeterminate.assessment).toBeNull();
    expect([withheld.v2.analysis.status, withheld.analysisStatus]).toEqual(['INDETERMINATE', 'INDETERMINATE']);
    expect(withheld.assessment).toBeNull();
    expect(withheld.riskAssessment).toBeUndefined();
    expect(isReportIncomplete(withheld)).toBe(true);
    const degraded = validateScannerResultV2(degradedEnvelope(withRiskSummary(scan(secretJson))));
    expect(degraded.ok).toBe(true);
    if (!degraded.ok) return;
    const lossy = toScannerReportModelV2(degraded.result);
    expect([lossy.v2.analysis.status, lossy.analysisStatus]).toEqual(['DEGRADED', 'DEGRADED']);
    expect(lossy.analysisDiagnostics.map(({ code }) => code)).toEqual(['ANALYSIS_LIMIT_EXCEEDED']);
    expect(lossy.v2.analysis.capabilities.find(({ id }) => id === 'javascript-security')).toMatchObject({ required: false, status: 'DEGRADED', omitted: 1 });
    expect(lossy.v2.limits.usage.reduce((total, row) => total + row.omitted, 0) + lossy.v2.stats.omittedFindings).toBe(1);
  });

  it('keeps degraded coverage explicit and redacts unsafe presentation strings', () => {
    const source = scan(risky);
    const unsafeInput = structuredClone(source);
    unsafeInput.workflow = { ...unsafeInput.workflow, name: 'sk_live_abc123456789' };
    expect(JSON.stringify(toScannerReportModelV2(unsafeInput))).not.toContain('sk_live_abc123456789');
    // Rendered evidence keeps its closed key vocabulary: an unregistered key is dropped instead of
    // being rendered as a label/value pair (mutation: report-safe-content opening SAFE_EVIDENCE_KEYS).
    expect(evidenceEntries({ secretKind: 'token', rawWorkflowJson: '{"nodes":[]}' })).toEqual([{ label: 'Secret Kind', value: 'token' }]);
  });
  /**
   * Coordinate truth taken from the fixture text. Mutations caught: a code-unit/code-point byte mixup,
   * utf8ByteOffset derived from utf16Offset, the BOM column shift applied to every line, an end
   * position past the document, and a null span rendered as a fabricated position.
   */
  it('resolves later-line, multi-byte and astral spans to the rendered position', () => {
    const nodeText = '{"id": "second", "name": "Call API", "type": "n8n-nodes-base.httpRequest", "typeVersion": 1, "parameters": {"apiKey": "sk_live_super_secret_value", "note": "astral 🙂 value"}}';
    const text = [
      '{',
      '"name": "🙂 pipeline",',
      '"nodes": [',
      '{"id": "first", "name": "安全 café", "type": "n8n-nodes-base.manualTrigger", "typeVersion": 1, "parameters": {"note": "é安全"}},',
      nodeText,
      '],',
      '"connections": {}',
      '}',
    ].join('\n');
    const result = scan(text);
    const { finding, node } = nodeSubjectOf(result);
    const span = node.source.span;
    if (!span) throw new Error('Expected a source span');
    // Positions derived from the text itself, never from the parser.
    const startLine = text.slice(0, span.start.utf16Offset).split('\n').length;
    const startColumn = span.start.utf16Offset - text.lastIndexOf('\n', span.start.utf16Offset - 1);
    const endLine = text.slice(0, span.end.utf16Offset).split('\n').length;
    const endColumn = span.end.utf16Offset - text.lastIndexOf('\n', span.end.utf16Offset - 1);
    const startBytes = new TextEncoder().encode(text.slice(0, span.start.utf16Offset)).length;
    const endBytes = new TextEncoder().encode(text.slice(0, span.end.utf16Offset)).length;
    expect(result.analysis.status).toBe('COMPLETE');
    expect(text.slice(span.start.utf16Offset, span.end.utf16Offset)).toBe(nodeText);
    expect([span.start.utf16Offset, span.start.line, span.start.column]).toEqual([text.indexOf(nodeText), startLine, startColumn]);
    expect([span.start.utf8ByteOffset, span.end.utf8ByteOffset]).toEqual([startBytes, endBytes]);
    expect(span.end.utf8ByteOffset).toBeGreaterThan(span.end.utf16Offset);
    expect(sourceSpanLabel(finding.subject)).toBe(`Source span: line ${startLine}, column ${startColumn} to line ${endLine}, column ${endColumn}`);
    // A BOM shifts offsets by one and the first line's column by one - never a later line's column.
    const bomResult = scan(`\uFEFF${text}`);
    const bomNode = nodeSubjectOf(bomResult).node;
    const bomSpan = bomNode.source.span;
    const projected = projectResultV2ToV1(bomResult, { hasLeadingBom: true });
    expect(projected.ok).toBe(true);
    if (!bomSpan || !projected.ok) throw new Error('Expected a BOM span and a successful projection');
    expect(bomSpan.start.line).toBeGreaterThan(1);
    expect(projected.result.findings[0]?.location.sourceSpan).toEqual({ start: { line: bomSpan.start.line, column: bomSpan.start.column, offset: bomSpan.start.utf16Offset + 1 }, end: { line: bomSpan.end.line, column: bomSpan.end.column, offset: bomSpan.end.utf16Offset + 1 } });
    // A span ending at the document end resolves to the last character, never past it.
    const lines = text.split('\n');
    const eof = { line: lines.length, column: lines[lines.length - 1]!.length + 1, utf16Offset: text.length, utf8ByteOffset: new TextEncoder().encode(text).length };
    const eofSubject = subjectWithSpan(node, { start: span.start, end: eof });
    expect(sourceSpanLabel(eofSubject)).toContain(`to line ${eof.line}, column ${eof.column}`);
    const eofProjection = projectResultV2ToV1({ ...result, findings: [{ ...finding, subject: eofSubject } satisfies FindingV2] });
    if (!eofProjection.ok) throw new Error('Expected a projection of the end-of-file span');
    expect(eofProjection.result.findings[0]?.location.sourceSpan?.end).toEqual({ line: eof.line, column: eof.column, offset: text.length });
    // A null span is rendered as unresolved rather than as a fabricated position.
    const unresolvedSubject = subjectWithSpan(node, null);
    expect(sourceSpanLabel(unresolvedSubject)).toBe('Source span unavailable (redacted or not retained).');
    const unresolved = projectResultV2ToV1({ ...result, findings: [{ ...finding, subject: unresolvedSubject } satisfies FindingV2] });
    if (!unresolved.ok) throw new Error('Expected a projection of the unresolved span');
    expect(unresolved.result.findings[0]?.location.sourceSpan).toBeUndefined();
  });
  /** Mutations caught: the projector's `secretKind` enum guard removed (the unsupported value would reach `evidence.secretKind` and render as a "Secret Kind" label). */
  it('refuses an unsupported secretKind instead of rendering a default label', () => {
    const result = scan(secretJson);
    const projection = projectResultV2ToV1(result);
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    const [legacyFinding] = projection.result.findings;
    if (!legacyFinding) throw new Error('Expected a projected finding');
    expect(evidenceEntries(legacyFinding.evidence)).toContainEqual({ label: 'Secret Kind', value: 'Stripe API key' });
    const poisoned: ScannerResultV2 = {
      ...result,
      facts: result.facts.map((fact) => (fact.kind === 'node.configuration.v2' ? { ...fact, properties: { ...fact.properties, secretKind: 'MAGIC_TOKEN_KIND' } } : fact)),
    };
    // The host's own validator accepts the unsupported value, so the enum guard in the projector is
    // what keeps it out of the rendered report; there is no default label behind it.
    expect(validateScannerResultV2(poisoned).ok).toBe(true);
    expect(projectResultV2ToV1(poisoned)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
    const model = toScannerReportModelV2(poisoned);
    expect(model.analysisStatus).toBe('INDETERMINATE');
    expect(model.riskAssessment).toBeUndefined();
    // No findings means no rendered evidence labels, so the unsupported kind cannot reach the page.
    expect(model.findings).toEqual([]);
  });

  it('redacts secret-shaped labels that a pre-redaction result can still carry', () => {
    const API_KEY_CANARY = 'api_key_canary_9ab712345678';
    const SECRET_TOKEN_CANARY = 'secret_token_canary_AWS_credential';
    const source = scan(secretJson);
    const { finding, node } = nodeSubjectOf(source);
    const poisoned: ScannerResultV2 = {
      ...source,
      workflow: { ...source.workflow, name: 'secret-token-utils' },
      target: { ...source.target, communityPackages: [{ name: 'secret-token-utils' }] },
      findings: source.findings.map((entry): FindingV2 => entry.findingId === finding.findingId
        ? { ...entry, subject: { kind: 'NODE', node: { ...node, explicitId: API_KEY_CANARY, name: SECRET_TOKEN_CANARY } } }
        : entry),
    };
    const model = toScannerReportModelV2(poisoned);
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain(API_KEY_CANARY);
    expect(serialized).not.toContain(SECRET_TOKEN_CANARY);
    // Control: a workflow name and a community-package name are not node refs, even when they are
    // shaped like a credential identifier.
    expect(model.v2.workflow.name).toBe('secret-token-utils');
    expect(model.workflow.name).toBe('secret-token-utils');
    expect(model.v2.target.communityPackages).toEqual([{ name: 'secret-token-utils' }]);
    const redacted = model.v2.findings.find(({ findingId }) => findingId === finding.findingId);
    if (!redacted || redacted.subject.kind !== 'NODE') throw new Error('Expected the node finding in the model');
    expect([redacted.subject.node.explicitId, redacted.subject.node.name]).toEqual(['[REDACTED]', '[REDACTED]']);
    expect([redacted.subject.node.ordinal, redacted.subject.node.identityDigest]).toEqual([node.ordinal, node.identityDigest]);
    // Identity, coordinates and the report status survive label redaction unchanged.
    expect(redacted.subject.node.source).toEqual(node.source);
    expect(model.findings[0]?.location).toMatchObject({ nodeId: '[REDACTED]', nodeName: '[REDACTED]' });
    expect(model.analysisStatus).toBe(toScannerReportModelV2(source).analysisStatus);
  });

  it('redacts a canary embedded in a larger node label and leaves non-ref names alone', () => {
    const API_KEY_CANARY = 'api_key_canary_9ab712345678';
    const source = withRiskSummary(scan(secretJson));
    const { finding, node } = nodeSubjectOf(source);
    const poisoned: ScannerResultV2 = {
      ...source,
      workflow: { ...source.workflow, name: 'secret-token-utils' },
      target: { ...source.target, communityPackages: [{ name: 'secret-token-utils' }] },
      findings: source.findings.map((entry): FindingV2 => entry.findingId === finding.findingId
        ? { ...entry, subject: { kind: 'NODE', node: { ...node, explicitId: `job-${API_KEY_CANARY}`, name: `Run job-${API_KEY_CANARY} node` } } }
        : entry),
    };
    const model = toScannerReportModelV2(poisoned);
    const serialized = JSON.stringify(model);
    // Final review: an anchored label rule left `job-api_key_canary_…` published.
    expect(serialized).not.toContain(API_KEY_CANARY);
    // Control: a workflow name and a community-package name are not node refs, even when shaped
    // like a credential identifier.
    expect([model.workflow.name, model.v2.workflow.name]).toEqual(['secret-token-utils', 'secret-token-utils']);
    expect(model.v2.target.communityPackages).toEqual([{ name: 'secret-token-utils' }]);
    const redacted = model.v2.findings.find(({ findingId }) => findingId === finding.findingId);
    if (!redacted || redacted.subject.kind !== 'NODE') throw new Error('Expected the node finding in the model');
    expect([redacted.subject.node.explicitId, redacted.subject.node.name]).toEqual(['job-[REDACTED]', 'Run job-[REDACTED] node']);
    // Identity and coordinates survive label redaction unchanged.
    expect([redacted.subject.node.ordinal, redacted.subject.node.identityDigest]).toEqual([node.ordinal, node.identityDigest]);
    expect(redacted.subject.node.source).toEqual(node.source);
    expect(model.findings[0]?.location).toMatchObject({ nodeId: 'job-[REDACTED]', nodeName: 'Run job-[REDACTED] node' });
    expect(model.analysisStatus).toBe(toScannerReportModelV2(source).analysisStatus);
    // The derived human summary keeps the readable remainder and never the canary.
    expect(model.humanSummary?.findingHighlights.join(' ')).toContain('in Run job-[REDACTED] node.');
  });

  it('redacts a secret-shaped node name embedded in graded summary prose', () => {
    const API_KEY_CANARY = 'api_key_canary_9ab712345678';
    const SECRET_TOKEN_CANARY = 'secret_token_canary_AWS_credential';
    const source = withRiskSummary(scan(secretJson));
    const { finding, node } = nodeSubjectOf(source);
    const poisoned: ScannerResultV2 = {
      ...source,
      workflow: { ...source.workflow, name: 'secret-token-utils' },
      target: { ...source.target, communityPackages: [{ name: 'secret-token-utils' }] },
      findings: source.findings.map((entry): FindingV2 => entry.findingId === finding.findingId
        ? { ...entry, subject: { kind: 'NODE', node: { ...node, explicitId: API_KEY_CANARY, name: SECRET_TOKEN_CANARY } } }
        : entry),
    };
    const model = toScannerReportModelV2(poisoned);
    // The risk-summary fact keeps the legacy projection graded, so the derived human summary exists.
    expect([model.v2.analysis.status, model.analysisStatus]).toEqual(['COMPLETE', 'COMPLETE']);
    const highlights = model.humanSummary?.findingHighlights.join(' ') ?? '';
    expect(highlights).toContain('in [REDACTED].');
    expect(highlights).not.toContain(SECRET_TOKEN_CANARY);
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain(SECRET_TOKEN_CANARY);
    expect(serialized).not.toContain(API_KEY_CANARY);
    // Control: non-ref names are metadata, not node identifiers.
    expect(model.workflow.name).toBe('secret-token-utils');
    expect(model.v2.workflow.name).toBe('secret-token-utils');
    expect(model.v2.target.communityPackages).toEqual([{ name: 'secret-token-utils' }]);
    expect(model.humanSummary?.plainLanguageOverview).toContain('secret-token-utils');
  });
});
