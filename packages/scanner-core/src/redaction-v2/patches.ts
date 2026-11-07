// DEVELOPMENT-ONLY / UNWIRED: no production caller and not exported from @hub/scanner-core (P1-4
// unclaim 2026-09-17; reconfirmed by task 5.2a on 2026-09-24, which removed every shipped claim of
// this capability). Do not cite as a shipped guarantee, and do not wire it without a v2-admission
// decision. Successor owner: scanner maintainer (Phase 5 track t1) —
// docs/audit/2026-09-16-fix/PHASE1-LEDGER.md.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { classifySecretValue } from '../secret-classifier';
import { PROVIDER_TOKEN_PATTERNS, redactionPattern } from '../provider-token-patterns';
import type { SourceMemberRefV2 } from '../source/source-types';

export const REDACTION_REPLACEMENT = '[REDACTED]';
export type RedactionComponent = 'SCALAR' | 'URL_USERINFO' | 'URL_PATH_SEGMENT' | 'URL_QUERY_VALUE' | 'EXPRESSION_LITERAL' | 'CODE_LITERAL';
export type RedactionClassification = 'CREDENTIAL' | 'TOKEN' | 'PASSWORD' | 'PRIVATE_KEY' | 'GENERIC_SECRET';
export type RedactionCandidateV2 = Readonly<{ start: number; end: number; kind: string; component?: RedactionComponent; classification?: string; source?: SourceMemberRefV2; contextKey?: string }>;
export type RedactionPatchV2 = Readonly<{ patchId: string; source: SourceMemberRefV2; region: { startUtf16Offset: number; endUtf16Offset: number }; component: RedactionComponent; classification: RedactionClassification; certainty: 'VERIFIED_COMPONENT' | 'UNCERTAIN_SCALAR_FALLBACK'; replacement: typeof REDACTION_REPLACEMENT }>;
export type RedactionError = Readonly<{ code: 'REDACTION_LIMIT_EXCEEDED' | 'REDACTION_PATCH_CONFLICT' | 'REDACTION_VERIFICATION_FAILED'; observed?: number; maximum?: number }>;
export type RedactionFailure = Readonly<{ ok: false; artifact: null; patches: readonly []; error: RedactionError }>;
export type RedactionResult = Readonly<{ ok: true; artifact: { text: string; utf8Bytes: number }; patches: readonly RedactionPatchV2[]; verification: { reparsed: true; rescanned: true; idempotent: true; residualCanariesPassed: true } }> | RedactionFailure;
export type RedactionInputV2 = Readonly<{ text: string; candidates: readonly RedactionCandidateV2[]; maxPatches: number; maxArtifactBytes: number; source?: SourceMemberRefV2 }>;
export type PatchApplicationResult = Readonly<{ ok: true; artifact: string }> | RedactionFailure;

const empty = Object.freeze([]) as readonly [];
const components: Record<RedactionComponent, true> = { SCALAR: true, URL_USERINFO: true, URL_PATH_SEGMENT: true, URL_QUERY_VALUE: true, EXPRESSION_LITERAL: true, CODE_LITERAL: true };
const classes: Record<RedactionClassification, true> = { CREDENTIAL: true, TOKEN: true, PASSWORD: true, PRIVATE_KEY: true, GENERIC_SECRET: true };
const fallbackSource = Object.freeze({ pointer: '', occurrencePath: Object.freeze([]), astNodeId: '0'.repeat(64), span: null });
const fail = (code: RedactionError['code'], observed?: number, maximum?: number): RedactionFailure => Object.freeze({ ok: false, artifact: null, patches: empty, error: Object.freeze({ code, ...(observed === undefined ? {} : { observed }), ...(maximum === undefined ? {} : { maximum }) }) });
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;
const boundary = (value: string, offset: number): boolean => offset === 0 || offset === value.length || (value.charCodeAt(offset) & 0xfc00) !== 0xdc00;
const decoded = (value: string): string => value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

export function createRedactionPatches(input: RedactionInputV2): RedactionResult {
  try {
    if (!input || typeof input.text !== 'string' || !Array.isArray(input.candidates) || !Number.isSafeInteger(input.maxPatches) || input.maxPatches < 0 || !Number.isSafeInteger(input.maxArtifactBytes) || input.maxArtifactBytes < 0) return fail('REDACTION_PATCH_CONFLICT');
    const patches: RedactionPatchV2[] = [];
    for (let index = 0; index < input.candidates.length; index += 1) {
      if (index >= input.maxPatches) return fail('REDACTION_LIMIT_EXCEEDED', index + 1, input.maxPatches);
      const patch = makePatch(input.text, input.candidates[index], input.source);
      if (patch === undefined) return fail('REDACTION_PATCH_CONFLICT', index + 1, input.maxPatches);
      patches.push(patch);
    }
    const ordered = orderPatches(input.text, patches);
    if (ordered === undefined) return fail('REDACTION_PATCH_CONFLICT');
    const applied = applyRedactionPatches(input.text, ordered, input.maxArtifactBytes);
    if (!applied.ok) return applied;
    if (hasResidualSecret(input.text, applied.artifact, ordered)) return fail('REDACTION_VERIFICATION_FAILED');
    const replay = applyRedactionPatches(applied.artifact, ordered);
    if (!replay.ok || replay.artifact !== applied.artifact || hasResidualSecret(applied.artifact, applied.artifact, [])) return fail('REDACTION_VERIFICATION_FAILED');
    return Object.freeze({ ok: true, artifact: Object.freeze({ text: applied.artifact, utf8Bytes: utf8Bytes(applied.artifact) }), patches: Object.freeze(ordered), verification: Object.freeze({ reparsed: true, rescanned: true, idempotent: true, residualCanariesPassed: true }) });
  } catch {
    return fail('REDACTION_PATCH_CONFLICT');
  }
}

export function applyRedactionPatches(text: string, patches: readonly RedactionPatchV2[], maxArtifactBytes?: number): PatchApplicationResult {
  try {
    if (typeof text !== 'string' || !Array.isArray(patches)) return fail('REDACTION_PATCH_CONFLICT');
    if (alreadyRedacted(text, patches)) {
      if (maxArtifactBytes !== undefined && utf8Bytes(text) > maxArtifactBytes) return fail('REDACTION_LIMIT_EXCEEDED', utf8Bytes(text), maxArtifactBytes);
      return Object.freeze({ ok: true, artifact: text });
    }
    const ordered = orderPatches(text, patches);
    if (ordered === undefined) return fail('REDACTION_PATCH_CONFLICT');
    let artifact = text;
    for (let index = ordered.length - 1; index >= 0; index -= 1) { const patch = ordered[index]; artifact = artifact.slice(0, patch.region.startUtf16Offset) + REDACTION_REPLACEMENT + artifact.slice(patch.region.endUtf16Offset); }
    if (maxArtifactBytes !== undefined && (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 0 || utf8Bytes(artifact) > maxArtifactBytes)) return fail('REDACTION_LIMIT_EXCEEDED', utf8Bytes(artifact), maxArtifactBytes);
    return Object.freeze({ ok: true, artifact });
  } catch {
    return fail('REDACTION_PATCH_CONFLICT');
  }
}
function alreadyRedacted(text: string, patches: readonly RedactionPatchV2[]): boolean {
  let shift = 0;
  let previousEnd = -1;
  let ordered: RedactionPatchV2[];
  try { ordered = [...patches].sort((left, right) => left.region.startUtf16Offset - right.region.startUtf16Offset); } catch { return false; }
  for (const patch of ordered) {
    const start = patch?.region?.startUtf16Offset;
    const end = patch?.region?.endUtf16Offset;
    if (!patch || typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < previousEnd || patch.replacement !== REDACTION_REPLACEMENT || end <= start || start + shift < 0 || text.slice(start + shift, start + shift + REDACTION_REPLACEMENT.length) !== REDACTION_REPLACEMENT) return false;
    previousEnd = end;
    shift += REDACTION_REPLACEMENT.length - (end - start);
  }
  return true;
}
function makePatch(text: string, candidate: RedactionCandidateV2, source?: SourceMemberRefV2): RedactionPatchV2 | undefined {
  if (!candidate || !Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.end) || candidate.start < 0 || candidate.end <= candidate.start || candidate.end > text.length || !boundary(text, candidate.start) || !boundary(text, candidate.end) || typeof candidate.kind !== 'string') return undefined;
  const component = candidate.component ?? componentFor(candidate.kind);
  if (!component || !syntaxSafe(text.slice(candidate.start, candidate.end), component)) return undefined;
  const detected = classifySecretValue(decoded(text.slice(candidate.start, candidate.end)), candidate.contextKey);
  const classification = toClassification(candidate.classification ?? candidate.kind, detected?.kind);
  if (!classification || candidate.kind.toUpperCase() === 'UNKNOWN') return undefined;
  const certainty = component === 'SCALAR' ? 'UNCERTAIN_SCALAR_FALLBACK' : 'VERIFIED_COMPONENT';
  const owner = copySource(candidate.source ?? source ?? fallbackSource);
  const patchId = bytesToHex(sha256(new TextEncoder().encode(`redaction-patch-v2\0${owner.astNodeId}\0${candidate.start}\0${candidate.end}\0${component}\0${classification}`)));
  return Object.freeze({ patchId, source: owner, region: Object.freeze({ startUtf16Offset: candidate.start, endUtf16Offset: candidate.end }), component, classification, certainty, replacement: REDACTION_REPLACEMENT });
}

function copySource(input: SourceMemberRefV2): SourceMemberRefV2 {
  const span = input.span === null ? null : Object.freeze({ start: Object.freeze({ ...input.span.start }), end: Object.freeze({ ...input.span.end }) });
  return Object.freeze({ pointer: input.pointer, occurrencePath: Object.freeze([...input.occurrencePath]), astNodeId: input.astNodeId, span });
}

function componentFor(kind: string): RedactionComponent | undefined {
  const normalized = kind.toUpperCase().replaceAll('-', '_').replaceAll(' ', '_');
  return components[normalized as RedactionComponent] === true ? normalized as RedactionComponent : ['TOKEN', 'CREDENTIAL', 'PASSWORD', 'PRIVATE_KEY', 'GENERIC_SECRET'].includes(normalized) ? 'SCALAR' : undefined;
}
function toClassification(value: string, detected?: string): RedactionClassification | undefined {
  const normalized = value.toUpperCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (classes[normalized as RedactionClassification] === true) return normalized as RedactionClassification;
  const source = `${value} ${detected ?? ''}`.toLowerCase();
  if (source.includes('private') && source.includes('key')) return 'PRIVATE_KEY';
  if (source.includes('password')) return 'PASSWORD';
  if (source.includes('token') || source.includes('jwt') || source.includes('bearer') || source.includes('basic')) return 'TOKEN';
  if (source.includes('credential') || source.includes('authorization') || source.includes('cookie') || source.includes('api key')) return 'CREDENTIAL';
  return detected ? 'GENERIC_SECRET' : undefined;
}
function syntaxSafe(value: string, component: RedactionComponent): boolean {
  if (component.startsWith('URL_')) { const forbidden = component === 'URL_QUERY_VALUE' ? /[&#]/ : /[/?#]/; if (forbidden.test(value)) return false; }
  if ((component === 'EXPRESSION_LITERAL' || component === 'CODE_LITERAL') && (/^["'`]|["'`]$/.test(value) || value.includes('\n'))) return false;
  return true;
}
function orderPatches(text: string, patches: readonly RedactionPatchV2[]): RedactionPatchV2[] | undefined {
  if (!patches.every((patch) => patch && components[patch.component] === true && classes[patch.classification] === true && patch.replacement === REDACTION_REPLACEMENT && ['VERIFIED_COMPONENT', 'UNCERTAIN_SCALAR_FALLBACK'].includes(patch.certainty) && Number.isSafeInteger(patch.region?.startUtf16Offset) && Number.isSafeInteger(patch.region?.endUtf16Offset) && patch.region.startUtf16Offset >= 0 && patch.region.endUtf16Offset > patch.region.startUtf16Offset && patch.region.endUtf16Offset <= text.length && boundary(text, patch.region.startUtf16Offset) && boundary(text, patch.region.endUtf16Offset) && syntaxSafe(text.slice(patch.region.startUtf16Offset, patch.region.endUtf16Offset), patch.component))) return undefined;
  const ordered = [...patches].sort((left, right) => left.region.startUtf16Offset - right.region.startUtf16Offset || left.region.endUtf16Offset - right.region.endUtf16Offset || (left.classification < right.classification ? -1 : left.classification > right.classification ? 1 : 0));
  for (let index = 1; index < ordered.length; index += 1) if (ordered[index - 1].region.endUtf16Offset > ordered[index].region.startUtf16Offset) return undefined;
  return ordered;
}

export function hasResidualSecret(original: string, artifact: string, patches: readonly RedactionPatchV2[]): boolean {
  const decodedArtifact = decoded(artifact);
  for (const patch of patches) {
    const value = original.slice(patch.region.startUtf16Offset, patch.region.endUtf16Offset);
    const decodedValue = decoded(value);
    const forms = [value, decodedValue, uriEncoded(decodedValue), hex(decodedValue), base64(decodedValue), base64(decodedValue).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')];
    if (forms.some((form) => form.length >= 8 && (artifact.includes(form) || decodedArtifact.includes(form)))) return true;
  }
  for (const entry of PROVIDER_TOKEN_PATTERNS.filter((item) => item.surfaces.includes('redact'))) {
    const pattern = redactionPattern(entry);
    pattern.lastIndex = 0;
    if (pattern.test(artifact)) return true;
  }
  return /\b(?:sk_(?:live|test)_|ghp|github_pat|glpat|xox[baprs]-|AIza|AKIA|eyJ)[A-Za-z0-9_.-]*\[REDACTED\]/.test(artifact)
    || /\[REDACTED\][A-Za-z0-9_-]{8,}/.test(artifact)
    || /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(artifact);
}
function hex(value: string): string { return [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function uriEncoded(value: string): string { return [...new TextEncoder().encode(value)].map((byte) => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join(''); }
function base64(value: string): string { const bytes = [...new TextEncoder().encode(value)]; let output = ''; for (let index = 0; index < bytes.length; index += 3) { const n = (bytes[index] << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0); output += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charAt((n >>> 18) & 63) + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charAt((n >>> 12) & 63) + (index + 1 < bytes.length ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charAt((n >>> 6) & 63) : '=') + (index + 2 < bytes.length ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charAt(n & 63) : '='); } return output; }
