import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { segmentExpressionIslands } from '../analyzers/expression/expression-islands';
import type { AnalysisDiagnostic, ScanFinding } from '../policy/policy';
import { canonicalizeJson } from '../canonical-json';
import { canonicalSafeFactProperties } from '../facts/safe-fact-validator';
import { createDiagnosticId } from '../diagnostics/identity';
import { classifyDiagnostic, type AnalysisDiagnosticV2, type DiagnosticCodeV2 } from '../diagnostics/registry';
import { UNKNOWN_RULE_DIAGNOSTIC_V2, resolveRuleAuthorityV2, unknownRuleCaseV2 } from '../rules-v2/rule-authority';
import { createCapabilityCandidateAdmissionSnapshotV2, type ScannerAdmissionSnapshotV2 } from '../admission/snapshot';
import type { SecurityNodeV2, SemanticFieldV2 } from '../workflow-v2/security-workflow';
import type { AnalyzerContextV2, CapabilityCandidateV2, FindingCandidateV2, SafeFactV2, SubjectV2 } from './scheduler';
import type { ProfileCapabilityV2 } from './profile-manifest';

export type AdmittedCapabilityCandidateV2 = ScannerAdmissionSnapshotV2<CapabilityCandidateV2>;

export function admitCandidate(candidate: CapabilityCandidateV2): AdmittedCapabilityCandidateV2 {
  return createCapabilityCandidateAdmissionSnapshotV2(candidate);
}

const digest = (parts: readonly string[]): string => bytesToHex(sha256(new TextEncoder().encode(requireTuple(parts))));
const requireTuple = (parts: readonly string[]): string => parts.map((part) => {
  const tagged = `N${new TextEncoder().encode(part).byteLength}:${part}`;
  return `${new TextEncoder().encode(tagged).byteLength}:${tagged}`;
}).join('');

type FactProperties = Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]>;

export function makeFact(kind: string, subject: SubjectV2, properties: FactProperties): SafeFactV2 {
  const subjectId = subject.kind === 'WORKFLOW' ? 'WORKFLOW' : subject.kind === 'SOURCE' ? `SOURCE${subject.source.astNodeId}` : subject.kind === 'NODE' ? `NODE${subject.node.identityDigest}` : `EDGE${subject.edge.ordinal}`;
  // The ID must hash the properties `validateSafeFact` will admit, not the ones a policy handed
  // over: an ingress fact quarantines malformed authentication, so hashing the raw value made the
  // validator reject its own producer's fact and drop the finding's whole capability (65-F1).
  // `undefined` keeps the raw properties, which fails closed at validation exactly as before.
  const admitted = canonicalSafeFactProperties(kind, properties) ?? properties;
  return { factId: digest(['secureflow-fact-id-v2', kind, subjectId, canonicalizeJson(admitted)]), kind, subject, properties: admitted };
}

export function emptyCandidate(seen = 0, analyzed = seen): CapabilityCandidateV2 {
  return createCapabilityCandidateAdmissionSnapshotV2({ findings: [], diagnostics: [], facts: [], traces: [], seen, analyzed, skipped: 0, omitted: 0 });
}

export function createDiagnostic(code: DiagnosticCodeV2, capabilityId: string, required: boolean, location?: SecurityNodeV2['ref']['source'], counts?: Pick<AnalysisDiagnosticV2, 'observed' | 'maximum' | 'omitted'>): AnalysisDiagnosticV2 {
  const classification = classifyDiagnostic(code, required);
  const identity = { code, capabilityId, ...classification, ...(location === undefined ? {} : { location }), ...counts };
  return Object.freeze({ ...identity, id: createDiagnosticId(identity) });
}

export function adaptDiagnostic(input: AnalysisDiagnostic, context: AnalyzerContextV2, capability: ProfileCapabilityV2): AnalysisDiagnosticV2 {
  const isLimit = input.code === 'ANALYSIS_LIMIT_EXCEEDED';
  const code = isLimit ? capability.required ? 'REQUIRED_LIMIT_EXCEEDED' : 'OPTIONAL_LIMIT_EXCEEDED' : input.code === 'DUPLICATE_JSON_KEY' ? 'DUPLICATE_SECURITY_KEY' : input.code as DiagnosticCodeV2;
  const nodeIndex = input.location?.path?.match(/^\/nodes\/(\d+)$/)?.[1];
  const node = nodeIndex === undefined ? undefined : Array.prototype.at.call(context.workflow.nodes, Number(nodeIndex)) as SecurityNodeV2 | undefined;
  const counts = isLimit ? { observed: 1, maximum: 0, omitted: 1 } : undefined;
  return createDiagnostic(code, capability.id, capability.required, node === undefined ? undefined : admittedSource(node.ref.source), counts);
}

export function unknownRuleDiagnostic(capability: ProfileCapabilityV2): AnalysisDiagnosticV2 {
  const ruleCase = unknownRuleCaseV2(capability);
  return createDiagnostic(UNKNOWN_RULE_DIAGNOSTIC_V2[ruleCase], capability.id, capability.required);
}

export function policyFailureDiagnostic(capability: ProfileCapabilityV2): AnalysisDiagnosticV2 {
  return createDiagnostic('POLICY_EXECUTION_FAILED', capability.id, capability.required);
}

export function candidateFinding(
  finding: ScanFinding,
  node: SecurityNodeV2,
  context: AnalyzerContextV2,
  capability: ProfileCapabilityV2,
  facts: SafeFactV2[],
): FindingCandidateV2 | undefined {
  const resolution = resolveRuleAuthorityV2(context.rules.rules, finding.policyId, capability);
  if (!resolution.ok || !capability.ruleIds.includes(finding.policyId) || resolution.rule.capabilityId !== capability.id) return undefined;
  const rule = resolution.rule;
  const subject: SubjectV2 = { kind: 'NODE', node: admittedNode(node.ref) };
  const evidence = finding.evidence;
  const add = (kind: string, properties: FactProperties, factSubject: SubjectV2 = subject): string => {
    const created = makeFact(kind, factSubject, properties); if (!facts.some((item) => item.factId === created.factId)) facts.push(created); return created.factId;
  };
  const factRefs = findingFactRefs(finding, node, add);
  if (factRefs === undefined) return undefined;
  const conclusion = rule.effect === 'SCORING' && node.scoringEligibility === 'INDETERMINATE' ? 'UNKNOWN' : 'OBSERVED';
  const evidenceClass = finding.policyId.startsWith('TAINTED_') ? 'POTENTIAL_DATAFLOW' : finding.policyId.includes('DYNAMIC_EXECUTION') ? 'SUSPICIOUS_SYNTAX' : ['RAW_AUTH_HEADER', 'RAW_SECRET_INDICATOR', 'UNAPPROVED_DOMAIN', 'UNKNOWN_NODE_PACKAGE', 'WEBHOOK_EXPOSURE'].includes(finding.policyId) ? 'CONFIGURATION' : 'CAPABILITY';
  return { ruleId: finding.policyId, evidenceClass, conclusion, applicability: 'APPLICABLE', subject, factRefs, traceRefs: [], remediationId: 'r' };
}

export function candidateFacts(finding: ScanFinding, node: SecurityNodeV2, facts: SafeFactV2[]): readonly string[] {
  const subject: SubjectV2 = { kind: 'NODE', node: admittedNode(node.ref) };
  const add = (kind: string, properties: FactProperties, factSubject: SubjectV2 = subject): string => {
    const created = makeFact(kind, factSubject, properties); if (!facts.some((item) => item.factId === created.factId)) facts.push(created); return created.factId;
  };
  return findingFactRefs(finding, node, add) ?? [];
}

function admittedSource(source: SecurityNodeV2['ref']['source']): SecurityNodeV2['ref']['source'] {
  const span = source.span === null ? null : { start: { ...source.span.start }, end: { ...source.span.end } };
  return { pointer: source.pointer, occurrencePath: Array.prototype.slice.call(source.occurrencePath) as number[], astNodeId: source.astNodeId, span };
}

function admittedNode(ref: SecurityNodeV2['ref']): SecurityNodeV2['ref'] {
  return { ...ref, source: admittedSource(ref.source) };
}

function findingFactRefs(finding: ScanFinding, node: SecurityNodeV2, add: (kind: string, properties: FactProperties, subject?: SubjectV2) => string): string[] | undefined {
  const e = finding.evidence; const source: SubjectV2 = { kind: 'SOURCE', source: admittedSource(node.ref.source) };
  if (finding.policyId === 'N8N_EXECUTE_COMMAND' || finding.policyId === 'N8N_CODE_NODE' || finding.policyId === 'UNKNOWN_NODE_PACKAGE') return [add('node.capability.v2', nodeCapability(node, e))];
  if (finding.policyId === 'RAW_AUTH_HEADER') return [add('node.configuration.v2', { observation: 'AUTH_HEADER', header: 'Authorization', literalValue: e.literalValue === true }, source)];
  if (finding.policyId === 'RAW_SECRET_INDICATOR') return [add('node.configuration.v2', { observation: 'SECRET_INDICATOR', parameterPath: pointer(String(e.parameterPath ?? '')), secretKind: String(e.secretKind ?? 'opaque secret'), indicator: e.indicator === 'sensitive_key' ? 'SENSITIVE_KEY' : 'SENSITIVE_VALUE', hasLiteralValue: e.hasLiteralValue === true }, source)];
  if (finding.policyId === 'UNAPPROVED_DOMAIN') {
    const destination = destinationEvidence(finding, node);
    return [add('destination.v2', destination.properties, { kind: 'SOURCE', source: destination.source })];
  }
  if (finding.policyId === 'WEBHOOK_EXPOSURE') return [add('ingress.v2', { authentication: typeof e.authentication === 'string' ? e.authentication : null, authenticationState: 'MISSING', legacyAuthenticated: false })];
  if (finding.policyId === 'JAVASCRIPT_DYNAMIC_EXECUTION' || finding.policyId === 'PYTHON_DYNAMIC_EXECUTION') return [add('code.indicator.v2', { language: finding.policyId.startsWith('JAVA') ? 'JAVASCRIPT' : 'PYTHON', indicator: String(e.indicator), ...(typeof e.member === 'string' ? { member: e.member } : {}), start: Number(e.start), end: Number(e.end), parseState: 'VERIFIED' }, source)];
  if (finding.policyId.startsWith('TAINTED_')) return [add('dataflow.summary.v2', taintProperties(finding), source)];
  if (finding.policyId === 'AI_AGENT_UNGATED_TOOL') return [add('node.capability.v2', nodeCapability(node, e)), add('dataflow.summary.v2', { flowKind: 'AGENT_INFLUENCE', propertyPathComplete: true, humanGatePresent: e.humanGatePresent === true, humanGateDominates: e.humanGateDominates === true, taintLabels: labels(e.taintLabels) }, source)];
  return undefined;
}
function destinationEvidence(finding: ScanFinding, node: SecurityNodeV2): Readonly<{ properties: FactProperties; source: SecurityNodeV2['ref']['source'] }> {
  const domain = typeof finding.evidence.domain === 'string' ? finding.evidence.domain.toLowerCase() : null;
  if (domain !== null) {
    const fields: SemanticFieldV2[] = [];
    collectSemanticFields(node.parameters, fields);
    let match: Readonly<{ path: string; source: SecurityNodeV2['ref']['source']; scheme: 'HTTP' | 'HTTPS'; hostname: string | null; authorityState: 'KNOWN' | 'UNKNOWN'; valueMode: 'LITERAL' | 'DYNAMIC' }> | undefined;
    for (const field of fields) {
      if (typeof field.value !== 'string') continue;
      let url: URL;
      try { url = new URL(field.value); } catch { continue; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:' || url.hostname.toLowerCase() !== domain) continue;
      const prefix = `${node.ref.source.pointer}/parameters`;
      if (!field.pointer.startsWith(`${prefix}/`)) continue;
      const path = field.pointer.slice(prefix.length);
      for (let occurrenceIndex = 0; occurrenceIndex < field.occurrences.length; occurrenceIndex += 1) {
        const source = field.occurrences[occurrenceIndex];
        if (match === undefined || path < match.path || path === match.path && source.astNodeId < match.source.astNodeId) {
          const islands = segmentExpressionIslands(field.value);
          const valueMode = field.classification === 'EXPRESSION' || islands.some((part) => part.kind === 'EXPRESSION') ? 'DYNAMIC' : 'LITERAL';
          const masked = maskExpressions(field.value, islands);
          const authorityBoundary = authorityEnd(masked);
          const dynamicAuthority = valueMode === 'DYNAMIC' && (authorityBoundary === 0 || islands.some((part) => part.kind === 'EXPRESSION' && part.start < authorityBoundary));
          const hostname = dynamicAuthority ? null : url.hostname.toLowerCase();
          const authorityState = dynamicAuthority || hostname === null ? 'UNKNOWN' : 'KNOWN';
          match = { path, source: admittedSource(source), scheme: url.protocol === 'https:' ? 'HTTPS' : 'HTTP', hostname, authorityState, valueMode };
        }
      }
    }
    if (match !== undefined) return { source: match.source, properties: { parameterPath: match.path, scheme: match.scheme, hostname: match.hostname, authorityState: match.authorityState, valueMode: match.valueMode } };
  }
  return { source: admittedSource(node.ref.source), properties: { parameterPath: '', scheme: 'UNKNOWN', hostname: domain, authorityState: 'KNOWN', valueMode: 'UNKNOWN' } };
}

function maskExpressions(value: string, islands: readonly { kind: string; start: number; end: number }[]): string {
  let output = '';
  let cursor = 0;
  for (const island of islands) {
    if (island.kind !== 'EXPRESSION') continue;
    output += `${value.slice(cursor, island.start)}x`;
    cursor = island.end;
  }
  return output + value.slice(cursor);
}

function authorityEnd(value: string): number {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*:)?\/\//.exec(value);
  if (!match) return 0;
  const start = match[0].length;
  const offset = value.slice(start).search(/[/?#]/);
  return offset < 0 ? value.length : start + offset;
}

function collectSemanticFields(fields: readonly SemanticFieldV2[], output: SemanticFieldV2[]): void {
  for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
    const field = fields[fieldIndex];
    output.push(field);
    if (Array.isArray(field.value)) collectSemanticFields(field.value, output);
  }
}
function nodeCapability(node: SecurityNodeV2, evidence: Record<string, unknown>): FactProperties {
  const type = node.type; const namespaceClass = type.startsWith('n8n-nodes-base.') ? 'OFFICIAL_BASE' : type.startsWith('@n8n/') ? 'OFFICIAL_SCOPED' : 'NON_OFFICIAL';
  const capabilities = type.endsWith('executeCommand') ? ['EXECUTE_COMMAND'] : type.endsWith('.code') || type.endsWith('.function') || type.endsWith('.functionItem') ? ['CUSTOM_CODE'] : type.endsWith('.webhook') ? ['WEBHOOK'] : Number(evidence.toolCount ?? 0) > 0 ? ['AI_AGENT'] : Array.isArray(evidence.capabilities) ? labels(evidence.capabilities) : [];
  return { nodeType: type, nodePackage: type.split('.')[0] ?? type, namespaceClass, capabilities, toolCount: Number(evidence.toolCount ?? 0), contextCount: Number(evidence.contextCount ?? 0) };
}

function taintProperties(finding: ScanFinding): FactProperties {
  const e = finding.evidence; const sink = finding.policyId === 'TAINTED_SQL_QUERY' ? 'SQL' : finding.policyId === 'TAINTED_COMMAND' ? 'COMMAND' : finding.policyId === 'TAINTED_REQUEST_URL' ? 'SSRF' : finding.policyId === 'TAINTED_FILE_PATH' ? 'PATH' : finding.policyId === 'TAINTED_CODE_INPUT' ? 'CODE' : finding.policyId === 'TAINTED_REQUEST_HEADER' ? 'HEADER' : 'PROMPT';
  return { flowKind: 'TAINT_SINK', sink, parameterPath: pointer(String(e.parameterPath ?? '')), referenceRoot: String(e.referenceRoot ?? 'DYNAMIC_NODE'), ...(typeof e.propertyPath === 'string' ? { propertyPath: pointer(e.propertyPath) } : {}), ...(typeof e.sourceNodeId === 'string' ? { sourceNodeId: e.sourceNodeId } : {}), ...(typeof e.sourceNodeName === 'string' ? { sourceNodeName: e.sourceNodeName } : {}), propertyPathComplete: e.propertyPathComplete === true, humanGatePresent: false, humanGateDominates: false, taintLabels: labels(e.taintLabels) };
}

function labels(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function pointer(value: string): string { if (value === '') return ''; const parts = value.replace(/^parameters(?:\.|$)/, '').split('.').filter(Boolean).flatMap((part) => part.match(/^[^\[]+/)?.[0] ? [part.match(/^[^\[]+/)![0], ...(part.match(/\[(\d+)\]/g) ?? []).map((item) => item.slice(1, -1))] : []); return parts.length === 0 ? '' : `/${parts.map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`; }
