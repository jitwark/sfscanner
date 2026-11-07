import type { FindingV2 } from '../../../../contracts/scanner-v2-evidence';
import type { ScannerResultV2 } from '../../../../contracts/scanner-v2-result';
import type { SubjectV2 } from '../../../../contracts/scanner-v2-source';
import { canonicalSubjectIdentity } from './identities';
import type { WorkflowComplexity } from '../workflow-insights';

export type AssessmentV2 = NonNullable<ScannerResultV2['assessment']>;
type PlainRecord = Record<string, unknown>;
type PreparedFinding = { finding: FindingV2; subjectKey: string };
type RuleTotal = { base: number; total: number };

const FINDING_KEYS = ['findingId', 'ruleId', 'ruleRevision', 'effect', 'severity', 'confidence', 'evidenceClass', 'conclusion', 'applicability', 'subject', 'factRefs', 'traceRefs', 'remediationId'] as const;
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
const COMPLEXITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_ARRAY = 100_000;
const POLICY = 'secureflow-risk-v2@2.0.0';
const WEIGHT: Record<(typeof SEVERITIES)[number], number> = { CRITICAL: 55, HIGH: 35, MEDIUM: 18, LOW: 6, INFO: 1 };
const COMPLEXITY_WEIGHT: Record<WorkflowComplexity, number> = { LOW: 0, MEDIUM: 10, HIGH: 20 };

export function scoreFindingsV2(findings: readonly FindingV2[], complexity: WorkflowComplexity): AssessmentV2 {
  try {
    if (!COMPLEXITIES.includes(complexity as (typeof COMPLEXITIES)[number])) throw new TypeError('Invalid workflow complexity');
    const prepared = dense(findings).map((value, index) => readFinding(value, index));
    const seen = new Set<string>();
    for (const { finding } of prepared) { if (seen.has(finding.findingId)) throw new TypeError('Duplicate finding ID'); seen.add(finding.findingId); }
    prepared.sort(compareFindings);
    const basisFindingIds: string[] = [];
    const excludedReportOnlyFindingIds: string[] = [];
    const excludedUncertainFindingIds: string[] = [];
    const excludedNotApplicableFindingIds: string[] = [];
    const totals = new Map<string, RuleTotal>();
    for (const { finding } of prepared) {
      if (finding.effect === 'REPORT_ONLY') excludedReportOnlyFindingIds.push(finding.findingId);
      else if (finding.applicability === 'NOT_APPLICABLE') excludedNotApplicableFindingIds.push(finding.findingId);
      else if (finding.applicability === 'UNKNOWN' || finding.conclusion === 'POTENTIAL' || finding.conclusion === 'UNKNOWN') excludedUncertainFindingIds.push(finding.findingId);
      else {
        basisFindingIds.push(finding.findingId);
        const base = WEIGHT[finding.severity];
        const prior = totals.get(finding.ruleId);
        if (!prior) totals.set(finding.ruleId, { base, total: base });
        else prior.total = Math.min(prior.base * 2, prior.total + prior.base * 0.25);
      }
    }
    let score = 0;
    for (const item of totals.values()) score += item.total;
    score = Math.floor(Math.min(100, score + COMPLEXITY_WEIGHT[complexity]) + 0.5);
    return { score, grade: score >= 80 ? 'CRITICAL' : score >= 55 ? 'HIGH' : score >= 25 ? 'MEDIUM' : 'LOW', scoringPolicyVersion: POLICY, basisFindingIds, excludedReportOnlyFindingIds, excludedUncertainFindingIds, excludedNotApplicableFindingIds, unknownEvidenceCount: excludedUncertainFindingIds.length };
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Invalid scoring input');
  }
}

function readFinding(value: unknown, index: number): PreparedFinding {
  const item = closed(value, FINDING_KEYS, `findings[${index}]`);
  digest(item.findingId, 'findingId'); idText(item.ruleId, 'ruleId'); idText(item.ruleRevision, 'ruleRevision'); idText(item.remediationId, 'remediationId');
  enumValue(item.effect, ['SCORING', 'REPORT_ONLY'], 'effect'); enumValue(item.severity, SEVERITIES, 'severity'); enumValue(item.confidence, ['HIGH', 'MEDIUM', 'LOW'], 'confidence');
  enumValue(item.evidenceClass, ['CAPABILITY', 'CONFIGURATION', 'SUSPICIOUS_SYNTAX', 'POTENTIAL_DATAFLOW', 'VERSION_APPLICABILITY'], 'evidenceClass');
  enumValue(item.conclusion, ['OBSERVED', 'POTENTIAL', 'UNKNOWN'], 'conclusion'); enumValue(item.applicability, ['APPLICABLE', 'NOT_APPLICABLE', 'UNKNOWN'], 'applicability');
  const subjectKey = subject(item.subject); refs(item.factRefs, 'factRefs'); refs(item.traceRefs, 'traceRefs');
  return { finding: item as unknown as FindingV2, subjectKey };
}

function subject(value: unknown): string {
  const item = closed(value, ['kind', 'node', 'edge', 'source'], ['kind']);
  if (item.kind === 'WORKFLOW') { if (Object.keys(item).length !== 1) throw new TypeError('Invalid workflow subject'); return 'WORKFLOW'; }
  if (item.kind === 'SOURCE') member(closed(item.source, ['pointer', 'occurrencePath', 'astNodeId', 'span'], 'source'));
  else if (item.kind === 'NODE') nodeRef(item.node);
  else if (item.kind === 'EDGE') edgeRef(item.edge);
  else throw new TypeError('Invalid subject kind');
  return canonicalSubjectIdentity(value as SubjectV2);
}
function member(value: PlainRecord): void { text(value.pointer, 'pointer', true); if (!pointer(value.pointer as string)) throw new TypeError('pointer must be RFC6901'); integers(value.occurrencePath, 'occurrencePath'); digest(value.astNodeId, 'astNodeId'); if (value.span !== null) { const span = closed(value.span, ['start', 'end'], 'span'); position(span.start, 'start'); position(span.end, 'end'); } }
function pointer(value: string): boolean { if (value === '') return true; if (value[0] !== '/') return false; for (let index = 1; index < value.length; index += 1) if (value[index] === '~') { const next = value[index + 1]; if (next !== '0' && next !== '1') return false; index += 1; } return true; }
function position(value: unknown, label: string): void { const item = closed(value, ['line', 'column', 'utf16Offset', 'utf8ByteOffset'], label); integer(item.line, `${label}.line`, 1); integer(item.column, `${label}.column`, 1); integer(item.utf16Offset, `${label}.utf16Offset`); integer(item.utf8ByteOffset, `${label}.utf8ByteOffset`); }
function nodeRef(value: unknown): void { const item = closed(value, ['ordinal', 'source', 'explicitId', 'name', 'identityDigest'], ['ordinal', 'source', 'identityDigest']); integer(item.ordinal, 'node.ordinal'); member(closed(item.source, ['pointer', 'occurrencePath', 'astNodeId', 'span'], 'node.source')); if ('explicitId' in item) text(item.explicitId, 'node.explicitId', true); if ('name' in item) text(item.name, 'node.name', true); digest(item.identityDigest, 'node.identityDigest'); }
function edgeRef(value: unknown): void { const item = closed(value, ['ordinal', 'sourceNode', 'targetNode', 'sourceLabel', 'targetLabel', 'connectionType', 'sourcePort', 'targetPort', 'source', 'resolution'], ['ordinal', 'sourceLabel', 'connectionType', 'sourcePort', 'targetPort', 'source', 'resolution']); integer(item.ordinal, 'edge.ordinal'); if ('sourceNode' in item) nodeRef(item.sourceNode); if ('targetNode' in item) nodeRef(item.targetNode); text(item.sourceLabel, 'edge.sourceLabel', true); if ('targetLabel' in item) text(item.targetLabel, 'edge.targetLabel', true); text(item.connectionType, 'edge.connectionType', true); integer(item.sourcePort, 'edge.sourcePort'); integer(item.targetPort, 'edge.targetPort'); member(closed(item.source, ['pointer', 'occurrencePath', 'astNodeId', 'span'], 'edge.source')); enumValue(item.resolution, ['RESOLVED', 'AMBIGUOUS', 'UNRESOLVED'], 'edge.resolution'); }

function closed(value: unknown, allowed: readonly string[], path: string | readonly string[]): PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be a record`);
  const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) throw new TypeError(`${path} has unsafe shape`);
  const item: PlainRecord = Object.create(null); const names = Object.getOwnPropertyNames(value);
  for (const name of names) { if (!allowed.includes(name)) throw new TypeError(`${path} has unknown property`); const descriptor = Object.getOwnPropertyDescriptor(value, name); if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError(`${path}.${name} is not data`); item[name] = descriptor.value; }
  const required = typeof path === 'string' && allowed === FINDING_KEYS ? FINDING_KEYS : Array.isArray(path) ? path : allowed;
  for (const name of required) if (!Object.prototype.hasOwnProperty.call(item, name)) throw new TypeError(`${path} is missing ${name}`);
  return item;
}
function dense(value: unknown): unknown[] { if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) throw new TypeError('Expected dense array'); const length = Object.getOwnPropertyDescriptor(value, 'length'); if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_ARRAY) throw new TypeError('Unsafe array'); const names = Object.getOwnPropertyNames(value); if (names.length !== length.value + 1 || names.some((name) => name !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= length.value))) throw new TypeError('Unsafe array'); const result: unknown[] = []; for (let index = 0; index < length.value; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor || !('value' in descriptor)) throw new TypeError('Sparse array'); result.push(descriptor.value); } return result; }
function refs(value: unknown, path: string): void { const values = dense(value); const seen = new Set<string>(); for (const item of values) { digest(item, path); if (seen.has(item as string)) throw new TypeError(`Duplicate ${path}`); seen.add(item as string); } }
function integers(value: unknown, path: string): void { const values = dense(value); for (const item of values) integer(item, path); }
function digest(value: unknown, path: string): asserts value is string { if (typeof value !== 'string' || !DIGEST.test(value)) throw new TypeError(`${path} must be a digest`); }
function idText(value: unknown, path: string): asserts value is string { text(value, path, false); }
function text(value: unknown, path: string, allowEmpty: boolean): asserts value is string { if (typeof value !== 'string' || !allowEmpty && value.length === 0 || value.length > 4096 || value.includes('\0') || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new TypeError(`${path} must be safe text`); for (let index = 0; index < value.length; index += 1) { const code = value.charCodeAt(index); if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(index + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${path} has invalid text`); index += 1; } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError(`${path} has invalid text`); } }
function integer(value: unknown, path: string, min = 0): asserts value is number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new TypeError(`${path} must be a safe integer`); }
function enumValue(value: unknown, values: readonly string[], path: string): void { if (typeof value !== 'string' || !values.includes(value)) throw new TypeError(`${path} has an invalid enum`); }
function compareFindings(left: PreparedFinding, right: PreparedFinding): number { return SEVERITIES.indexOf(left.finding.severity) - SEVERITIES.indexOf(right.finding.severity) || compareStrings(left.finding.ruleId, right.finding.ruleId) || compareStrings(left.subjectKey, right.subjectKey) || compareStrings(left.finding.findingId, right.finding.findingId); }
function compareStrings(left: string, right: string): number { const a = Array.from(left, (char) => char.codePointAt(0)!); const b = Array.from(right, (char) => char.codePointAt(0)!); for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] - b[index]; return a.length - b.length; }
