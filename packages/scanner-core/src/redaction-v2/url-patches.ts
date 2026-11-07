// DEVELOPMENT-ONLY / UNWIRED: no production caller and not exported from @hub/scanner-core (P1-4
// unclaim 2026-09-17; reconfirmed by task 5.2a on 2026-09-24, which removed every shipped claim of
// this capability). Do not cite as a shipped guarantee, and do not wire it without a v2-admission
// decision. Successor owner: scanner maintainer (Phase 5 track t1) —
// docs/audit/2026-09-16-fix/PHASE1-LEDGER.md.
import { classifySecretValue } from '../secret-classifier';
import { PROVIDER_TOKEN_PATTERNS, redactionPattern } from '../provider-token-patterns';
import type { SourceMemberRefV2 } from '../source/source-types';
import type { RedactionCandidateV2 } from './patches';

const components = { userinfo: 'URL_USERINFO', path: 'URL_PATH_SEGMENT', query: 'URL_QUERY_VALUE', scalar: 'SCALAR' } as const;
const decode = (value: string): string => value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

export function createUrlRedactionCandidates(value: string, source?: SourceMemberRefV2): readonly RedactionCandidateV2[] {
  if (typeof value !== 'string' || value.length === 0) return Object.freeze([]);
  const candidates: RedactionCandidateV2[] = [];
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  const authorityStart = scheme ? scheme[0].length : -1;
  const authorityEnd = authorityStart >= 0 ? firstBoundary(value, authorityStart, '/?#') : -1;
  if (authorityStart < 0 || authorityEnd <= authorityStart || /[\s\\]/.test(value.slice(authorityStart, authorityEnd))) return Object.freeze(scalarCandidates(value, source));
  const authority = value.slice(authorityStart, authorityEnd);
  const at = authority.lastIndexOf('@');
  const host = authority.slice(at + 1);
  if (host.length === 0 || host.startsWith(':')) return Object.freeze(scalarCandidates(value, source));
  if (at >= 0) addUserinfo(value, authorityStart, authorityStart + at, candidates, source);
  const pathEnd = value.indexOf('?', authorityEnd) >= 0 ? value.indexOf('?', authorityEnd) : value.indexOf('#', authorityEnd) >= 0 ? value.indexOf('#', authorityEnd) : value.length;
  if (value[authorityEnd] === '/') addPath(value, authorityEnd + 1, pathEnd, candidates, source);
  const queryStart = value.indexOf('?', authorityEnd);
  if (queryStart >= 0) addQuery(value, queryStart + 1, value.indexOf('#', queryStart) >= 0 ? value.indexOf('#', queryStart) : value.length, candidates, source);
  return Object.freeze(candidates);
}

export const collectUrlRedactionCandidates = createUrlRedactionCandidates;

function addUserinfo(value: string, start: number, end: number, output: RedactionCandidateV2[], source?: SourceMemberRefV2): void {
  let cursor = end;
  const separator = value.lastIndexOf(':', end);
  if (separator >= start) { addIfSecret(value, separator + 1, end, components.userinfo, 'password', output, source); cursor = separator; }
  addIfSecret(value, start, cursor, components.userinfo, 'username', output, source);
}
function addPath(value: string, start: number, end: number, output: RedactionCandidateV2[], source?: SourceMemberRefV2): void {
  let cursor = start;
  while (cursor < end) {
    const slash = value.indexOf('/', cursor);
    const segmentEnd = slash < 0 || slash >= end ? end : slash;
    if (segmentEnd > cursor) addIfSecret(value, cursor, segmentEnd, components.path, 'path', output, source);
    cursor = segmentEnd + 1;
  }
}
function addQuery(value: string, start: number, end: number, output: RedactionCandidateV2[], source?: SourceMemberRefV2): void {
  let cursor = start;
  while (cursor <= end) {
    const amp = value.indexOf('&', cursor);
    const partEnd = amp < 0 || amp > end ? end : amp;
    const equals = value.indexOf('=', cursor);
    if (equals >= cursor && equals < partEnd) addIfSecret(value, equals + 1, partEnd, components.query, value.slice(cursor, equals), output, source);
    cursor = partEnd + 1;
    if (partEnd === end) break;
  }
}
function addIfSecret(value: string, start: number, end: number, component: RedactionCandidateV2['kind'], contextKey: string, output: RedactionCandidateV2[], source?: SourceMemberRefV2): void {
  if (end <= start) return;
  const raw = value.slice(start, end);
  const classification = classifySecretValue(decode(raw), contextKey);
  if (!classification) return;
  output.push(Object.freeze({ start, end, kind: component, classification: classification.kind, contextKey, ...(source ? { source } : {}) }));
}
function scalarCandidates(value: string, source?: SourceMemberRefV2): RedactionCandidateV2[] {
  const output: RedactionCandidateV2[] = [];
  for (const entry of PROVIDER_TOKEN_PATTERNS.filter((item) => item.surfaces.includes('redact'))) {
    const pattern = redactionPattern(entry);
    for (const match of value.matchAll(pattern)) { const start = match.index ?? -1; if (start >= 0 && match[0]) output.push(Object.freeze({ start, end: start + match[0].length, kind: components.scalar, classification: entry.kind, ...(source ? { source } : {}) })); }
  }
  return output.sort((left, right) => left.start - right.start || left.end - right.end);
}
function firstBoundary(value: string, start: number, delimiters: string): number {
  const indexes = [...delimiters].map((delimiter) => value.indexOf(delimiter, start)).filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : value.length;
}
