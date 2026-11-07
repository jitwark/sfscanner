import type { ScannerLimitsV2 } from '@hub/contracts';
import { isParsedSourceDocument } from '../source/source-document-provenance';
export function validateSourceDocument(value: unknown, limits: ScannerLimitsV2): boolean {
  try {
    if (!isParsedSourceDocument(value) || !record(value) || !exactKeys(value, DOCUMENT_KEYS)) return false;
    const document = value as Record<string, unknown>;
    if (!hex(document.rawSha256) || !Number.isSafeInteger(document.utf8Bytes) || (document.utf8Bytes as number) < 0 || (document.utf8Bytes as number) > limits.maxBytes) return false;
    if (document.bom !== 'NONE' && document.bom !== 'UTF8') return false;
    if (!Number.isSafeInteger(document.duplicateCount) || (document.duplicateCount as number) < 0 || (document.duplicateCount as number) > limits.maxDuplicateKeys ||
        !Number.isSafeInteger(document.syntaxNodeCount) || (document.syntaxNodeCount as number) < 0 || (document.syntaxNodeCount as number) > limits.maxSyntaxNodes) return false;
    const state = {
      seen: new Set<object>(), refs: new Map<string, { owner: object; ref: object }>(), units: 0, syntaxNodes: 1,
      duplicates: 0, spans: 0, depth: 0, utf8Bytes: document.utf8Bytes as number,
      maxMembers: limits.maxMembersAndElements, maxSyntaxNodes: limits.maxSyntaxNodes,
      maxDuplicateKeys: limits.maxDuplicateKeys, maxStoredSourceSpans: limits.maxStoredSourceSpans,
    };
    const pending: Array<{ value: unknown; depth: number }> = [{ value: document.root, depth: 1 }];
    while (pending.length > 0) {
      const current = pending.pop()!;
      state.depth = Math.max(state.depth, current.depth);
      if (current.depth > limits.maxDocumentDepth) return false;
      if (!validateValue(current.value, current.depth, pending, state)) return false;
      if (state.units > limits.maxMembersAndElements || state.syntaxNodes > limits.maxSyntaxNodes || state.spans > limits.maxStoredSourceSpans) return false;
    }
    return state.duplicates === document.duplicateCount && state.syntaxNodes === document.syntaxNodeCount;
  } catch {
    return false;
  }
}

function validateValue(value: unknown, depth: number, pending: Array<{ value: unknown; depth: number }>, state: ValidationState): boolean {
  if (!record(value)) return false;
  if (state.seen.has(value)) return false;
  state.seen.add(value);
  const candidate = value as Record<string, unknown>;
  if (!valueKind(candidate.kind) || !exactKeys(candidate, VALUE_KEYS[candidate.kind])) return false;
  if (!validateRef(candidate.ref, state, value)) return false;
  if (candidate.kind === 'NULL') { if (!addSyntax(state, 1)) return false; return candidate.lexeme === 'null' && candidate.value === null; }
  if (candidate.kind === 'BOOLEAN') { if (!addSyntax(state, 1)) return false; return typeof candidate.lexeme === 'string' && typeof candidate.value === 'boolean'; }
  if (candidate.kind === 'STRING') { if (!addSyntax(state, 1)) return false; return typeof candidate.lexeme === 'string' && typeof candidate.value === 'string'; }
  if (candidate.kind === 'NUMBER') { if (!addSyntax(state, 1)) return false; return typeof candidate.lexeme === 'string' && typeof candidate.value === 'number' && Number.isFinite(candidate.value); }
  if (candidate.kind === 'ARRAY') {
    if (!containerBudget(state, candidate.items, 1)) return false;
    state.syntaxNodes += 1 + candidate.items.length;
    state.units += candidate.items.length;
    for (let index = candidate.items.length - 1; index >= 0; index -= 1) pending.push({ value: candidate.items[index], depth: depth + 1 });
    return true;
  }
  if (candidate.kind !== 'OBJECT' || !containerBudget(state, candidate.members, 2)) return false;
  state.syntaxNodes += 1 + candidate.members.length * 2;
  state.units += candidate.members.length;
  const names = new Set<string>();
  for (let index = candidate.members.length - 1; index >= 0; index -= 1) {
    const member = candidate.members[index];
    if (!record(member) || !exactKeys(member, MEMBER_KEYS) || !record(member.value) || member.ref !== (member.value as Record<string, unknown>).ref ||
        typeof member.nameLexeme !== 'string' || typeof member.name !== 'string' || !Number.isSafeInteger(member.occurrence) || (member.occurrence as number) < 0 ||
        !validateRef(member.ref, state, member.value)) return false;
    if (names.has(member.name)) {
      state.duplicates += 1;
      if (state.duplicates > state.maxDuplicateKeys) return false;
    }
    names.add(member.name);
    pending.push({ value: member.value, depth: depth + 1 });
  }
  return true;
}

type ValidationState = {
  seen: Set<object>;
  refs: Map<string, { owner: object; ref: object }>;
  units: number;
  syntaxNodes: number;
  duplicates: number;
  spans: number;
  depth: number;
  utf8Bytes: number;
  maxMembers: number;
  maxSyntaxNodes: number;
  maxDuplicateKeys: number;
  maxStoredSourceSpans: number;
};

function validateRef(value: unknown, state: ValidationState, owner: object): boolean {
  if (!record(value) || !exactKeys(value, REF_KEYS)) return false;
  const ref = value as Record<string, unknown>;
  if (typeof ref.pointer !== 'string' || (ref.pointer !== '' && !ref.pointer.startsWith('/')) || !dense(ref.occurrencePath) ||
      ref.occurrencePath.length > 10_000 || ref.occurrencePath.some((part) => !Number.isSafeInteger(part) || (part as number) < 0) || !hex(ref.astNodeId)) return false;
  const prior = state.refs.get(ref.astNodeId as string);
  if (ref.span === null) {
    if (prior !== undefined) return prior.owner === owner && prior.ref === value;
    state.refs.set(ref.astNodeId as string, { owner, ref: value });
    return true;
  }
  if (!record(ref.span) || !exactKeys(ref.span, SPAN_KEYS) || !position((ref.span as Record<string, unknown>).start) || !position((ref.span as Record<string, unknown>).end)) return false;
  const span = ref.span as Record<string, Record<string, unknown>>;
  const start = span.start;
  const end = span.end;
  if ((end.utf16Offset as number) < (start.utf16Offset as number) ||
      (end.utf8ByteOffset as number) < (start.utf8ByteOffset as number) ||
      (end.line as number) < (start.line as number) ||
      ((end.line as number) === (start.line as number) && (end.column as number) < (start.column as number)) ||
      (start.utf8ByteOffset as number) > state.utf8Bytes || (end.utf8ByteOffset as number) > state.utf8Bytes) return false;
  if (prior !== undefined) return prior.owner === owner && prior.ref === value;
  if (state.spans >= state.maxStoredSourceSpans) return false;
  state.refs.set(ref.astNodeId as string, { owner, ref: value });
  state.spans += 1;
  return true;
}

function addSyntax(state: ValidationState, amount: number): boolean {
  if (amount > state.maxSyntaxNodes - state.syntaxNodes) return false;
  state.syntaxNodes += amount;
  return true;
}

function containerBudget(state: ValidationState, value: unknown, syntaxMultiplier: number): value is readonly unknown[] {
  if (!Array.isArray(value) || !Number.isSafeInteger(value.length) || value.length < 0) return false;
  if (value.length > state.maxMembers - state.units) return false;
  const syntax = 1 + value.length * syntaxMultiplier;
  if (syntax > state.maxSyntaxNodes - state.syntaxNodes || !dense(value)) return false;
  return true;
}

function position(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, POSITION_KEYS)) return false;
  return ['line', 'column', 'utf16Offset', 'utf8ByteOffset'].every((key) => Number.isSafeInteger((value as Record<string, unknown>)[key]) && ((value as Record<string, unknown>)[key] as number) >= (key === 'line' || key === 'column' ? 1 : 0));
}

function dense(value: unknown): value is readonly unknown[] {
  try {
    if (!Array.isArray(value) || !Object.isFrozen(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) return false;
    for (const name of Object.getOwnPropertyNames(value)) {
      if (name === 'length') continue;
      const index = Number(name);
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== name ||
          !descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
    }
    for (let index = 0; index < value.length; index += 1) if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
    return true;
  } catch {
    return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.isFrozen(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function hex(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }

const DOCUMENT_KEYS = ['rawSha256', 'utf8Bytes', 'bom', 'root', 'duplicateCount', 'syntaxNodeCount'];
const MEMBER_KEYS = ['nameLexeme', 'name', 'occurrence', 'ref', 'value'];
const REF_KEYS = ['pointer', 'occurrencePath', 'astNodeId', 'span'];
const SPAN_KEYS = ['start', 'end'];
const POSITION_KEYS = ['line', 'column', 'utf16Offset', 'utf8ByteOffset'];
const VALUE_KEYS = {
  NULL: ['kind', 'lexeme', 'value', 'ref'], BOOLEAN: ['kind', 'lexeme', 'value', 'ref'],
  NUMBER: ['kind', 'lexeme', 'value', 'ref'], STRING: ['kind', 'lexeme', 'value', 'ref'],
  ARRAY: ['kind', 'ref', 'items'], OBJECT: ['kind', 'ref', 'members'],
} as const;

function valueKind(value: unknown): value is keyof typeof VALUE_KEYS {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VALUE_KEYS, value);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.getOwnPropertyNames(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}
