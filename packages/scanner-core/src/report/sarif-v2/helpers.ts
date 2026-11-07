import { validateScannerResultV2, type ScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import type { SourceSpanV2, SubjectV2 } from '@hub/contracts/scanner-v2-source';
import type { BatchSarifEnvelopeV2, BatchSarifInputV2, SarifV2Limits } from './output';

export type Bounds = { rules: number; results: number; notifications: number; taxonomies: number; taxa: number; tags: number; flows: number; steps: number };
export type NotifItem = { code: string; level: 'warning' | 'error'; location?: Record<string, unknown>; locKey: string; id?: string; label?: string };
export type BatchId = {
  engineId: string; engineVersion: string; engineBuildDigest: string;
  profileId: string; profileVersion: string;
  rulesetId: string; rulesetVersion: string; rulesetDigest: string; rulesetSig: string;
  semanticsId: string; semanticsVersion: string; semanticsDigest: string;
  targetContextDigest: string; targetEdition: string; targetDeployment: string; targetRole: string; targetTaskRunner: string;
  limitsSchemaVersion: string; limitsDigest: string;
};
export type InputIdentity = { rawUri: unknown; label: string };

export const FALLBACK: Bounds = { rules: 1024, results: 5000, notifications: 256, taxonomies: 8, taxa: 512, tags: 32, flows: 512, steps: 100 };
export const SEV_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
export const LEVELS: Record<string, 'error' | 'warning' | 'note'> = { CRITICAL: 'error', HIGH: 'error', MEDIUM: 'warning', LOW: 'note', INFO: 'note' };
export const ALLOWED_ERRORS = new Set<string>(['UTF8_DECODING_FAILED', 'INVALID_JSON', 'MALFORMED_WORKFLOW', 'WORKFLOW_TOO_LARGE', 'WORKFLOW_TOO_COMPLEX', 'INPUT_READ_FAILED', 'SCAN_TIMEOUT', 'SCAN_CANCELLED', 'INVALID_CONFIG', 'UNKNOWN_CONFIGURATION_KEY', 'PROFILE_NOT_ADMITTED', 'SEMANTIC_CATALOGUE_INVALID', 'SEMANTIC_CATALOGUE_AMBIGUOUS', 'RULE_PACK_INVALID', 'RULE_PACK_UNTRUSTED', 'TOOL_INVARIANT_FAILED', 'SERIALIZATION_FAILED', 'OUTPUT_WRITE_FAILED']);
export const prop = (v: unknown, k: string): unknown => {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || !Object.prototype.hasOwnProperty.call(v, k)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(v, k);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};
export const inv = (): never => { throw new TypeError('Invalid SARIF input'); };

function closed(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || Object.getOwnPropertySymbols(value).length) return inv();
  const out = value as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(out)) {
    const descriptor = Object.getOwnPropertyDescriptor(out, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || !allowed.includes(key)) return inv();
  }
  return out;
}
function dense(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) return inv();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1) return inv();
  for (const name of names) {
    if (name === 'length') continue;
    if (!/^(?:0|[1-9]\d*)$/.test(name) || Number(name) >= value.length) return inv();
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return inv();
  }
  return value as readonly unknown[];
}
function validateLimitObject(value: unknown): SarifV2Limits | undefined {
  if (value === undefined) return undefined;
  const object = closed(value, ['maxRules', 'maxResults', 'maxNotifications', 'maxTaxonomies', 'maxTaxa', 'maxTags', 'maxFlows', 'maxTraceSteps']);
  for (const key of Object.keys(object)) if (!Number.isSafeInteger(object[key]) || (object[key] as number) < 0) return inv();
  return object as SarifV2Limits;
}

export function checkResult(r: unknown): ScannerResultV2 {
  const v = validateScannerResultV2(r);
  if (!v.ok) return inv();
  return v.result;
}
export function inputIdentity(value: unknown): InputIdentity {
  const item = closed(value, ['input', 'uri', 'label', 'result', 'status', 'ok', 'error', 'rawWorkflow']);
  const nested = prop(item, 'input');
  const nestedObject = nested === undefined ? undefined : closed(nested, ['label', 'uri']);
  const uri = typeof prop(item, 'uri') === 'string' ? prop(item, 'uri') : prop(nestedObject, 'uri');
  const labelValue = typeof prop(item, 'label') === 'string' ? prop(item, 'label') : prop(nestedObject, 'label');
  const label = typeof labelValue === 'string' ? labelValue : typeof uri === 'string' ? uri : '';
  return { rawUri: uri ?? label, label };
}
export function extractItems(input: BatchSarifInputV2): { items: readonly unknown[]; repoRoot?: string; selRoot?: string; limits?: SarifV2Limits } {
  if (!input || typeof input !== 'object') return inv();
  if (Array.isArray(input)) return { items: dense(input) };
  const env = closed(input, ['items', 'results', 'input', 'result', 'repositoryRoot', 'selectionRoot', 'limits']) as BatchSarifEnvelopeV2;
  const limits = validateLimitObject(env.limits);
  if (env.repositoryRoot !== undefined && !safePath(env.repositoryRoot)) return inv();
  if (env.selectionRoot !== undefined && !safePath(env.selectionRoot)) return inv();
  const nested = env.input === undefined ? undefined : inputIdentity({ input: env.input });
  const items = env.items !== undefined ? dense(env.items) : env.results !== undefined ? dense(env.results) : (env.result && nested) ? [{ label: nested.label, uri: nested.rawUri, result: env.result, status: 'COMPLETED' }] : undefined;
  if (!items) return inv();
  return { items: items as readonly unknown[], repoRoot: env.repositoryRoot, selRoot: env.selectionRoot, limits };
}

export function safePath(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0') && !/[\u0000-\u001f\u007f\ud800-\udfff]/.test(v) && !/^(?:[A-Za-z]:|[\\/]{1,2}|[A-Za-z][A-Za-z0-9+.-]*:)/.test(v) && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(v) && !/[?#]/.test(v);
}
export function safeUri(raw: unknown, repoRoot?: string, selRoot?: string): string | undefined {
  if (!safePath(raw)) return undefined;
  try {
    let p = raw.replaceAll('\\', '/').split('/').filter((part) => part && part !== '.').join('/');
    const roots = [repoRoot, selRoot].filter((r): r is string => r !== undefined);
    let matched = roots.length === 0;
    for (const root of roots) {
      if (!safePath(root)) return undefined;
      const base = root.replaceAll('\\', '/').split('/').filter((part) => part && part !== '.').join('/');
      if (!base) { matched = true; continue; }
      if (p === base) return undefined;
      if (p.startsWith(`${base}/`)) { p = p.slice(base.length + 1); matched = true; }
    }
    if (!matched) return undefined;
    const parts = p.split('/');
    return parts.length && !parts.some((part) => !part || part === '.' || part === '..' || /%2e/i.test(part)) ? parts.map(encodeURIComponent).join('/') : undefined;
  } catch { return undefined; }
}

export function readPos(v: unknown): SourceSpanV2['start'] | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const l = prop(v, 'line'); const c = prop(v, 'column'); const so = prop(v, 'utf16Offset'); const bo = prop(v, 'utf8ByteOffset');
  return (!Number.isSafeInteger(l) || (l as number) < 1 || !Number.isSafeInteger(c) || (c as number) < 1 || !Number.isSafeInteger(so) || (so as number) < 0 || !Number.isSafeInteger(bo) || (bo as number) < 0) ? undefined : { line: l as number, column: c as number, utf16Offset: so as number, utf8ByteOffset: bo as number };
}
export function readSpan(source: unknown): SourceSpanV2 | undefined {
  const span = prop(source, 'span');
  if (!span || typeof span !== 'object' || prop(span, 'verified') === false || prop(span, 'status') === 'UNVERIFIED') return undefined;
  const st = readPos(prop(span, 'start')); const en = readPos(prop(span, 'end'));
  return (!st || !en || en.utf16Offset <= st.utf16Offset || en.utf8ByteOffset <= st.utf8ByteOffset || en.line < st.line || (en.line === st.line && en.column <= st.column)) ? undefined : { start: st, end: en };
}
export function subjectKey(s: SubjectV2): string {
  if (s.kind === 'WORKFLOW') return 'WORKFLOW';
  if (s.kind === 'NODE') return `NODE:${s.node.identityDigest}`;
  if (s.kind === 'SOURCE') return `SOURCE:${s.source.astNodeId}`;
  return `EDGE:${s.edge.ordinal}:${s.edge.source.astNodeId}:${s.edge.connectionType}`;
}
export function subjectSpan(subj: SubjectV2): SourceSpanV2 | undefined {
  const owner = subj.kind === 'NODE' ? subj.node : subj.kind === 'EDGE' ? subj.edge : subj.kind === 'SOURCE' ? subj : undefined;
  return owner && prop(owner, 'source') ? readSpan(prop(owner, 'source')) : undefined;
}
export function physical(uri: string, s: SourceSpanV2): Record<string, unknown> {
  const charLength = s.end.utf16Offset - s.start.utf16Offset;
  return { physicalLocation: { artifactLocation: { uri }, region: { startLine: s.start.line, startColumn: s.start.column, endLine: s.end.line, endColumn: s.end.column, charOffset: s.start.utf16Offset, charLength } } };
}
export function freeze<T>(v: T, seen = new WeakSet<object>()): T {
  if (v && typeof v === 'object' && !seen.has(v as object)) { seen.add(v as object); for (const k of Object.getOwnPropertyNames(v)) freeze((v as Record<string, unknown>)[k], seen); Object.freeze(v); }
  return v;
}
export function sameId(a: BatchId, b: BatchId): boolean {
  return a.engineId === b.engineId && a.engineVersion === b.engineVersion && a.engineBuildDigest === b.engineBuildDigest && a.profileId === b.profileId && a.profileVersion === b.profileVersion && a.rulesetId === b.rulesetId && a.rulesetVersion === b.rulesetVersion && a.rulesetDigest === b.rulesetDigest && a.rulesetSig === b.rulesetSig && a.semanticsId === b.semanticsId && a.semanticsVersion === b.semanticsVersion && a.semanticsDigest === b.semanticsDigest && a.targetContextDigest === b.targetContextDigest && a.targetEdition === b.targetEdition && a.targetDeployment === b.targetDeployment && a.targetRole === b.targetRole && a.targetTaskRunner === b.targetTaskRunner && a.limitsSchemaVersion === b.limitsSchemaVersion && a.limitsDigest === b.limitsDigest;
}
