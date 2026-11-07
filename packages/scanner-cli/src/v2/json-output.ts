import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import { validateScannerResultV2, type ScannerResultV2, type TargetContextV3 } from '@hub/contracts/scanner-v2-result';
import { ADMITTED_PROFILE_V2, BUILTIN_LIMITS_AUTHORITY_V2, BUILTIN_RULESET_AUTHORITY_V2, BUILTIN_SEMANTICS_AUTHORITY_V2, CLI_TOOL_V2 } from './contracts';
import type { BatchErrorCodeV2, BatchItemV2, BatchResultV2 } from './batch-runner';
import {
  buildPreflightReadinessReport,
  type PreflightAnalysisSignalsV1,
  type PreflightFindingInputV1,
  type PreflightReadinessReportV1,
  type PreflightSeverityV1,
} from './preflight-readiness';
import { validateSupplyChainRequestV2, type SupplyChainRequestV2 } from './supply-chain-request';
export type ProjectionFormatV2 = 'json' | 'ndjson' | 'sarif' | 'table';
export type ProjectionSourceV2 = Readonly<{
  profile: 'BUILT_IN' | 'CONFIG' | 'CLI';
  rules: 'BUILT_IN' | 'CONFIG' | 'CLI';
  semantics: 'BUILT_IN' | 'CONFIG' | 'CLI';
  limits: 'BUILT_IN' | 'CONFIG' | 'CLI';
  target: 'DEFAULT' | 'CONFIG' | 'CLI';
  unsignedDevelopment: 'DEFAULT' | 'CONFIG' | 'CLI';
}>;
export type ProjectionOptionsV2 = Readonly<{
  format: ProjectionFormatV2;
  profile: string;
  failOn: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  requireComplete: boolean;
  concurrency: number;
  allowUnsignedDevelopmentRules: boolean;
  sources: ProjectionSourceV2;
  supplyChain?: SupplyChainRequestV2;
  target?: TargetContextV3;
  includeReadiness?: boolean;
}>;
type ArtifactV2 = Readonly<{ profile: { id: string; version: string }; ruleset: { id: string; version: string; digest: string; signatureStatus: 'VERIFIED' | 'UNVERIFIED' }; semantics: { id: string; version: string; digest: string }; target: ScannerResultV2['target']; limits: { schemaVersion: 'scanner-limits-v2'; digest: string } }>;
type CliErrorCodeV2 = BatchErrorCodeV2 | 'OUTPUT_WRITE_FAILED';
type CliErrorV2 = Readonly<{ kind: 'INPUT' | 'INCOMPLETE' | 'INTERNAL' | 'CANCELLED'; code: CliErrorCodeV2; message: string }>;
type CliItemV2 = Readonly<{ input: string; ok: true; result: ScannerResultV2; readiness?: PreflightReadinessReportV1 } | { input: string; ok: false; error: CliErrorV2 }>;
type SummaryV2 = Readonly<{ total: number; complete: number; degraded: number; indeterminate: number; inputErrors: number; internalErrors: number; cancelled: number; findings: number }>;
type BatchState = Readonly<{ ok: boolean; items: readonly BatchItemV2[]; code?: string; cancelled: boolean; concurrency: number }>;
export type CliEnvelopeV2 = Readonly<{ schemaVersion: 'n8n-scan-v2'; tool: Readonly<{ name: 'n8n-scan'; version: string; buildDigest: string }>; artifacts: ArtifactV2; invocation: Readonly<{ schema: 'v2'; format: 'json' | 'ndjson' | 'sarif' | 'table'; profile: string; failOn: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'; requireComplete: boolean; concurrency: number; allowUnsignedDevelopmentRules: boolean; sources: ProjectionSourceV2 }>; supplyChain?: SupplyChainRequestV2; results: readonly CliItemV2[]; summary: SummaryV2; exitReason: 'UNDER_THRESHOLD' | 'FINDING_THRESHOLD' | 'REQUIRE_COMPLETE' | 'ITEM_FAILURE' | 'USAGE' | 'INTERNAL' | 'CANCELLED' }>;
export type ProjectedBatchV2 = Readonly<{ envelope: CliEnvelopeV2; items: readonly CliItemV2[] }>;
export const DEFAULT_PROJECTION_OPTIONS: ProjectionOptionsV2 = Object.freeze({
  format: 'json',
  profile: ADMITTED_PROFILE_V2.id,
  failOn: 'INFO',
  requireComplete: false,
  concurrency: 1,
  allowUnsignedDevelopmentRules: false,
  sources: Object.freeze({
    profile: 'BUILT_IN',
    rules: 'BUILT_IN',
    semantics: 'BUILT_IN',
    limits: 'BUILT_IN',
    target: 'DEFAULT',
    unsignedDevelopment: 'DEFAULT',
  }),
});
const ERROR_CODES: Readonly<Record<string, true>> = Object.freeze({
  UTF8_DECODING_FAILED: true, INVALID_JSON: true, MALFORMED_WORKFLOW: true, WORKFLOW_TOO_LARGE: true,
  WORKFLOW_TOO_COMPLEX: true, INPUT_READ_FAILED: true, SCAN_TIMEOUT: true, SCAN_CANCELLED: true,
  INVALID_CONFIG: true, UNKNOWN_CONFIGURATION_KEY: true, PROFILE_NOT_ADMITTED: true,
  SEMANTIC_CATALOGUE_INVALID: true, SEMANTIC_CATALOGUE_AMBIGUOUS: true, RULE_PACK_INVALID: true,
  RULE_PACK_UNTRUSTED: true, TOOL_INVARIANT_FAILED: true, SERIALIZATION_FAILED: true, OUTPUT_WRITE_FAILED: true,
});
const TARGET = Object.freeze({ schemaVersion: 'scanner-target-v3' as const, edition: 'UNKNOWN' as const, deployment: 'UNKNOWN' as const, role: 'UNKNOWN' as const, taskRunner: 'UNKNOWN' as const, communityPackages: Object.freeze([]), configuration: Object.freeze([]), contextDigest: 'c900aec3eac8e0411670debe6236140548f3f9e098de7b227274bdcbec99b32e' });
const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({ UTF8_DECODING_FAILED: 'Input is not valid UTF-8.', INVALID_JSON: 'Input is not valid JSON.', MALFORMED_WORKFLOW: 'Input is not a valid workflow.', WORKFLOW_TOO_LARGE: 'Input exceeds the admitted size limit.', WORKFLOW_TOO_COMPLEX: 'Input exceeds the admitted complexity limit.', INPUT_READ_FAILED: 'Input could not be read.', SCAN_TIMEOUT: 'Scan timed out.', SCAN_CANCELLED: 'Scan was cancelled.', INVALID_CONFIG: 'Configuration is invalid.', UNKNOWN_CONFIGURATION_KEY: 'Configuration contains an unknown key.', PROFILE_NOT_ADMITTED: 'Profile is not admitted.', SEMANTIC_CATALOGUE_INVALID: 'Semantic catalogue is invalid.', SEMANTIC_CATALOGUE_AMBIGUOUS: 'Semantic catalogue is ambiguous.', RULE_PACK_INVALID: 'Rule pack is invalid.', RULE_PACK_UNTRUSTED: 'Rule pack is untrusted.', TOOL_INVARIANT_FAILED: 'Scanner invariant failed.', SERIALIZATION_FAILED: 'Serialization failed.', OUTPUT_WRITE_FAILED: 'Output could not be written.' });
const SECRET = /(?:api[ _-]*key|password|secret|credential|authorization|cookie|bearer|token)\s*[:=]|\b(?:sk[-_][\w-]+|AKIA[0-9A-Z]{16}|eyJ[\w-]{12,}\.[\w-]{8,})\b/i;
const ABSOLUTE = /^(?:[a-z][a-z\d+.-]*:|\/|\\|[a-z]:[\\/])/i;
const TRAVERSAL = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const NODE_POINTER = /^\/nodes\/(\d+)$/;

export function serializeEnvelopeV2(batch: BatchResultV2, options: ProjectionOptionsV2 = DEFAULT_PROJECTION_OPTIONS): string {
  const { supplyChain, ...rest } = options;
  const projection = Object.freeze({ ...rest, ...(supplyChain === undefined ? {} : { supplyChain }) });
  try { return canonicalizeJson(projectBatchV2(batch, projection).envelope); } catch { return canonicalizeJson(projectBatchV2({ ok: false, code: 'INVALID_CONFIG', message: 'Configuration is invalid.' }, projection).envelope); }
}

export function projectBatchV2(batch: BatchResultV2, options: ProjectionOptionsV2 | ProjectionFormatV2 = DEFAULT_PROJECTION_OPTIONS): ProjectedBatchV2 {
  const projection = typeof options === 'string' ? Object.freeze({ ...DEFAULT_PROJECTION_OPTIONS, format: options }) : options;
  const supplyChain = projection.supplyChain;
  if (supplyChain !== undefined && !validateSupplyChainRequestV2(supplyChain)) throw new TypeError('Supply-chain request metadata is invalid.');
  const state = readBatch(batch);
  const rawItems = state.ok ? state.items : [];
  const validResults = rawItems.map(readScannerResult).filter((value): value is ScannerResultV2 => value !== undefined);
  if (supplyChain !== undefined) {
    if (projection.target !== undefined && projection.target.contextDigest !== supplyChain.inventoryDigest) throw new TypeError('Supply-chain target identity mismatch');
    for (const result of validResults) {
      const facts = result.facts.filter((fact) => fact.kind === 'advisory.evaluation.v1');
      if (result.target.contextDigest !== supplyChain.inventoryDigest || facts.length !== 1
        || facts[0].properties.evaluationState !== supplyChain.evaluation.status
        || facts[0].properties.evaluationReason !== supplyChain.evaluation.reason) throw new TypeError('Supply-chain request and canonical evaluation disagree');
    }
  }
  const artifacts = Object.freeze(validResults.length ? artifact(validResults[0]!) : defaults(supplyChain === undefined ? undefined : projection.target));
  const items = Object.freeze(rawItems.map((item) => normalizeItem(item, artifacts, projection.target, projection.includeReadiness === true)));
  const summary = summarize(items);
  const envelope = Object.freeze({ schemaVersion: 'n8n-scan-v2' as const, tool: CLI_TOOL_V2, artifacts, invocation: invocation(projection), ...(supplyChain === undefined ? {} : { supplyChain }), results: items, summary, exitReason: exitReason(state, summary, items, projection) });
  return Object.freeze({ envelope, items });
}

function readBatch(input: unknown): BatchState {
  try {
    if (!input || typeof input !== 'object') return { ok: false, items: [], code: 'INVALID_CONFIG', cancelled: false, concurrency: 1 };
    const value = input as Record<string, unknown>;
    if (value.ok === false) return { ok: false, items: [], code: value.code === 'CANCELLED' ? 'CANCELLED' : 'INVALID_CONFIG', cancelled: value.code === 'CANCELLED', concurrency: 1 };
    if (value.ok !== true || !Array.isArray(value.items) || value.items.length > 100_000) return { ok: false, items: [], code: 'INVALID_CONFIG', cancelled: false, concurrency: 1 };
    for (let index = 0; index < value.items.length; index += 1) if (!Object.prototype.hasOwnProperty.call(value.items, index)) return { ok: false, items: [], code: 'INVALID_CONFIG', cancelled: false, concurrency: 1 };
    const concurrency = Number.isSafeInteger(value.concurrency) && (value.concurrency as number) > 0 ? Math.min(value.concurrency as number, 16) : 1;
    return { ok: true, items: value.items as BatchItemV2[], cancelled: value.cancelled === true, concurrency };
  } catch { return { ok: false, items: [], code: 'INVALID_CONFIG', cancelled: false, concurrency: 1 }; }
}

function readScannerResult(item: BatchItemV2): ScannerResultV2 | undefined {
  try {
    if (!item || typeof item !== 'object' || item.status !== 'COMPLETED' || !item.result || typeof item.result !== 'object' || item.result.ok !== true) return undefined;
    const checked = validateScannerResultV2(item.result.result);
    if (!checked.ok || checked.result.profile.id !== ADMITTED_PROFILE_V2.id || checked.result.profile.version !== ADMITTED_PROFILE_V2.version) return undefined;
    return freezeValue(checked.result);
  } catch { return undefined; }
}
function freezeValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object') {
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Object.getOwnPropertyNames(value)) freezeValue((value as Record<string, unknown>)[key], seen);
    Object.freeze(value);
  }
  return value;
}
function artifact(result: ScannerResultV2): ArtifactV2 { return Object.freeze({ profile: Object.freeze({ ...result.profile }), ruleset: Object.freeze({ ...result.ruleset }), semantics: Object.freeze({ ...result.semantics }), target: Object.freeze({ ...result.target, communityPackages: Object.freeze(result.target.communityPackages.map((item) => Object.freeze({ ...item }))), configuration: Object.freeze(result.target.configuration.map((item) => Object.freeze({ ...item }))) }), limits: Object.freeze({ schemaVersion: result.limits.schemaVersion, digest: result.limits.digest }) }); }
function defaults(target?: TargetContextV3): ArtifactV2 { return Object.freeze({ profile: Object.freeze({ id: ADMITTED_PROFILE_V2.id, version: ADMITTED_PROFILE_V2.version }), ruleset: Object.freeze({ ...BUILTIN_RULESET_AUTHORITY_V2 }), semantics: Object.freeze({ ...BUILTIN_SEMANTICS_AUTHORITY_V2 }), target: target ?? TARGET, limits: Object.freeze({ schemaVersion: BUILTIN_LIMITS_AUTHORITY_V2.schemaVersion, digest: BUILTIN_LIMITS_AUTHORITY_V2.digest }) }); }
function normalizeItem(raw: BatchItemV2, artifacts: ArtifactV2, target?: TargetContextV3, includeReadiness = false): CliItemV2 {
  let label: unknown;
  try { label = raw && typeof raw === 'object' ? raw.label : undefined; } catch { label = undefined; }
  const input = safeLabel(label);
  const result = readScannerResult(raw);
  if (result && sameIdentity(artifact(result), artifacts)) {
    const readiness = includeReadiness ? readinessFor(result, rawWorkflowOf(raw), target) : undefined;
    return Object.freeze({ input, ok: true as const, result, ...(readiness === undefined ? {} : { readiness }) });
  }
  const code = errorCode(raw, 'TOOL_INVARIANT_FAILED');
  return Object.freeze({ input, ok: false as const, error: error(code) });
}
const PREFLIGHT_SEVERITIES: Readonly<Record<string, PreflightSeverityV1>> = Object.freeze({ CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', INFO: 'info' });
function rawWorkflowOf(item: BatchItemV2): unknown {
  try { return item.rawWorkflow; } catch { return undefined; }
}
/**
 * Preflight admits only an export carrying its own node array. Anything else proves nothing about the
 * analyzed workflow, so no readiness report is produced from a substituted empty document.
 */
function workflowDocument(rawWorkflow: unknown): Readonly<{ document: unknown; nodeCount: number }> | undefined {
  if (typeof rawWorkflow !== 'object' || rawWorkflow === null) return undefined;
  if (!Object.prototype.hasOwnProperty.call(rawWorkflow, 'nodes') || !('nodes' in rawWorkflow)) return undefined;
  const nodes = rawWorkflow.nodes;
  return Array.isArray(nodes) ? Object.freeze({ document: rawWorkflow, nodeCount: nodes.length }) : undefined;
}
/**
 * Preflight readiness reasons about nodes, not about scanner stages: a node is unsupported only when a
 * diagnostic names it, so a degraded stage that named no node leaves every exported node supported. The
 * diagnostic carries its node as a source pointer (`/nodes/<index>`), never as a bare stage count. Support
 * is bounded by the exported node count because the readiness contract admits no more support than the
 * export can contain.
 */
function readinessSignals(result: ScannerResultV2, nodeCount: number): PreflightAnalysisSignalsV1 {
  const diagnosedNodes = new Set<string>();
  for (const { location } of result.analysis.diagnostics) {
    const match = NODE_POINTER.exec(location?.pointer ?? '');
    if (match !== null) diagnosedNodes.add(match[1]!);
  }
  const unsupportedNodes = Math.min(diagnosedNodes.size, nodeCount);
  return Object.freeze({
    supportedNodes: Math.max(0, nodeCount - unsupportedNodes),
    unsupportedNodes,
    unresolvedEdges: Math.max(0, result.workflow.edgeCount - result.workflow.resolvedEdgeCount),
    ambiguities: result.input.ambiguityCount,
    truncated: result.analysis.diagnostics.some(({ category }) => category === 'LIMIT'),
  });
}
function readinessFindings(result: ScannerResultV2): readonly PreflightFindingInputV1[] {
  return result.findings.map(({ ruleId, severity, subject }) => Object.freeze({
    ruleId, severity: PREFLIGHT_SEVERITIES[severity] ?? 'info', node: subject.kind === 'NODE' ? subject.node.name ?? null : null,
  }));
}
/** Only an exact declared version can select a pin; the export itself never proves the platform it runs on. */
function n8nVersionOf(result: ScannerResultV2, target?: TargetContextV3): string | undefined {
  const version = result.target.n8nVersion ?? target?.n8nVersion;
  return typeof version === 'string' ? version : undefined;
}
/**
 * Readiness never changes the scan verdict, so an unreadable export drops the report instead of failing the
 * item. An export without its own node array proves nothing, so it yields no report rather than an empty one.
 */
function readinessFor(result: ScannerResultV2, rawWorkflow: unknown, target?: TargetContextV3): PreflightReadinessReportV1 | undefined {
  try {
    const document = workflowDocument(rawWorkflow);
    if (document === undefined) return undefined;
    const n8nVersion = n8nVersionOf(result, target);
    return buildPreflightReadinessReport({
      workflow: document.document,
      analysis: readinessSignals(result, document.nodeCount),
      findings: readinessFindings(result),
      ...(n8nVersion === undefined ? {} : { n8nVersion }),
    });
  } catch { return undefined; }
}
function errorCode(item: BatchItemV2, fallback: BatchErrorCodeV2): CliErrorCodeV2 {
  try {
    const code = item && typeof item === 'object' && item.error && typeof item.error.code === 'string' ? item.error.code : undefined;
    if (code && ERROR_CODES[code] === true) return code as CliErrorCodeV2;
    if (item?.result && typeof item.result === 'object' && item.result.ok === false && ERROR_CODES[item.result.code] === true) return item.result.code;
    if (item?.status === 'TIMEOUT') return 'SCAN_TIMEOUT';
    if (item?.status === 'CANCELLED') return 'SCAN_CANCELLED';
  } catch { /* fail closed */ }
  return fallback;
}
function error(code: CliErrorCodeV2): CliErrorV2 { const kind = code === 'SCAN_CANCELLED' ? 'CANCELLED' : code === 'SCAN_TIMEOUT' ? 'INCOMPLETE' : code === 'TOOL_INVARIANT_FAILED' || code === 'SERIALIZATION_FAILED' || code === 'OUTPUT_WRITE_FAILED' ? 'INTERNAL' : 'INPUT'; return Object.freeze({ kind, code, message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.TOOL_INVARIANT_FAILED }); }
function sameIdentity(left: ArtifactV2, right: ArtifactV2): boolean { return canonicalizeJson(left) === canonicalizeJson(right); }
function safeLabel(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || SECRET.test(value)) return 'input';
    const normalized = value.replaceAll('\\', '/');
    if (ABSOLUTE.test(normalized) || TRAVERSAL.test(normalized)) return 'input';
    const clean = normalized.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return new TextEncoder().encode(clean).byteLength <= 16_384 ? clean : 'input';
  } catch { return 'input'; }
}
function summarize(items: readonly CliItemV2[]): SummaryV2 { let complete = 0; let degraded = 0; let indeterminate = 0; let inputErrors = 0; let internalErrors = 0; let cancelled = 0; let findings = 0; for (const item of items) { if (item.ok) { const status = item.result.analysis.status; if (status === 'COMPLETE') complete += 1; else if (status === 'DEGRADED') degraded += 1; else indeterminate += 1; findings += item.result.findings.length; } else if (item.error.kind === 'CANCELLED') cancelled += 1; else if (item.error.kind === 'INTERNAL') internalErrors += 1; else inputErrors += 1; } return Object.freeze({ total: items.length, complete, degraded, indeterminate, inputErrors, internalErrors, cancelled, findings }); }
const FINDING_SEVERITY: Readonly<Record<ProjectionOptionsV2['failOn'], number>> = Object.freeze({ CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 });
function invocation(options: ProjectionOptionsV2) {
  return Object.freeze({
    schema: 'v2' as const,
    format: options.format,
    profile: options.profile,
    failOn: options.failOn,
    requireComplete: options.requireComplete,
    concurrency: options.concurrency,
    allowUnsignedDevelopmentRules: options.allowUnsignedDevelopmentRules,
    sources: options.sources,
  });
}
function exitReason(state: BatchState, summary: SummaryV2, items: readonly CliItemV2[], options: ProjectionOptionsV2): CliEnvelopeV2['exitReason'] {
  if (!state.ok) return state.code === 'CANCELLED' ? 'CANCELLED' : 'USAGE';
  if (state.cancelled || summary.cancelled > 0) return 'CANCELLED';
  if (summary.internalErrors > 0) return 'INTERNAL';
  if (items.some((item) => item.ok && item.result.findings.some((finding) => typeof finding.severity === 'string' && FINDING_SEVERITY[finding.severity as ProjectionOptionsV2['failOn']] >= FINDING_SEVERITY[options.failOn]))) return 'FINDING_THRESHOLD';
  if (summary.degraded > 0 && options.requireComplete) return 'REQUIRE_COMPLETE';
  if (summary.indeterminate > 0 || summary.inputErrors > 0 || items.some((item) => !item.ok && item.error.kind === 'INCOMPLETE')) return 'ITEM_FAILURE';
  return 'UNDER_THRESHOLD';
}
