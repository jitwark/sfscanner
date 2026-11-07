import { canonicalizeJson } from '../canonical-json';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export type PatchOpV1 =
  | Readonly<{ op: 'test'; path: string; value: JsonValue }>
  | Readonly<{ op: 'add' | 'replace'; path: string; value: JsonValue }>
  | Readonly<{ op: 'remove'; path: string }>;

export type PatchCodeV1 = 'MALFORMED_PATCH' | 'UNSUPPORTED_OPERATION' | 'CONFLICTING_PATCH';
export type PatchFailureV1 = Readonly<{ ok: false; code: PatchCodeV1; path?: string }>;
export type PatchResultV1 = Readonly<{ ok: true; value: JsonValue }> | PatchFailureV1;
export type PatchValidationV1 = Readonly<{ ok: true; ops: readonly PatchOpV1[] }> | PatchFailureV1;

type MutableJson = null | boolean | number | string | MutableJson[] | { [key: string]: MutableJson };

const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;
const OPERATIONS: Readonly<Record<string, true>> = Object.freeze({ test: true, add: true, remove: true, replace: true });

export function decodeJsonPointer(pointer: string): string[] | undefined {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return undefined;
  const segments: string[] = [];
  for (const raw of pointer.slice(1).split('/')) {
    let segment = '';
    for (let index = 0; index < raw.length; index += 1) {
      const character = raw[index];
      if (character !== '~') {
        segment += character;
        continue;
      }
      const escaped = raw[index + 1];
      if (escaped === '0') segment += '~';
      else if (escaped === '1') segment += '/';
      else return undefined;
      index += 1;
    }
    segments.push(segment);
  }
  return segments;
}

export function validatePatch(patch: unknown): PatchValidationV1 {
  if (!Array.isArray(patch)) return { ok: false, code: 'MALFORMED_PATCH' };
  const ops: PatchOpV1[] = [];
  const writes: string[][] = [];
  for (const value of patch) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, code: 'MALFORMED_PATCH' };
    const entry = value as Record<string, unknown>;
    if (typeof entry.op !== 'string') return { ok: false, code: 'MALFORMED_PATCH' };
    if (OPERATIONS[entry.op] !== true) {
      return { ok: false, code: 'UNSUPPORTED_OPERATION', ...(typeof entry.path === 'string' ? { path: entry.path } : {}) };
    }
    if (typeof entry.path !== 'string') return { ok: false, code: 'MALFORMED_PATCH' };
    const segments = decodeJsonPointer(entry.path);
    if (!segments) return { ok: false, code: 'MALFORMED_PATCH', path: entry.path };
    if (entry.op === 'remove') {
      if (!exactKeys(entry, ['op', 'path']) || segments.length === 0) {
        return { ok: false, code: 'MALFORMED_PATCH', path: entry.path };
      }
      ops.push({ op: entry.op, path: entry.path });
    } else if (exactKeys(entry, ['op', 'path', 'value']) && isJsonValue(entry.value)) {
      if (entry.op === 'test') ops.push({ op: 'test', path: entry.path, value: entry.value });
      else if (entry.op === 'add' || entry.op === 'replace') ops.push({ op: entry.op, path: entry.path, value: entry.value });
      else return { ok: false, code: 'MALFORMED_PATCH', path: entry.path };
    } else {
      return { ok: false, code: 'MALFORMED_PATCH', path: entry.path };
    }
    if (entry.op !== 'test' && writes.some((write) => overlaps(write, segments))) {
      return { ok: false, code: 'CONFLICTING_PATCH', path: entry.path };
    }
    if (entry.op !== 'test') writes.push(segments);
  }
  return { ok: true, ops };
}

export function applyPatch(document: JsonValue, ops: readonly PatchOpV1[]): PatchResultV1 {
  let value = cloneJson(document);
  for (const op of ops) {
    const segments = decodeJsonPointer(op.path);
    if (!segments) return { ok: false, code: 'MALFORMED_PATCH', path: op.path };
    if (op.op === 'test') {
      const current = readAt(value, segments);
      if (current === undefined || !structuralEqual(current, op.value)) {
        return { ok: false, code: 'CONFLICTING_PATCH', path: op.path };
      }
      continue;
    }
    if (segments.length === 0) {
      if (op.op === 'remove') return { ok: false, code: 'MALFORMED_PATCH', path: op.path };
      value = cloneJson(op.value);
      continue;
    }
    const parent = readAt(value, segments.slice(0, -1));
    if (parent === undefined) return { ok: false, code: 'MALFORMED_PATCH', path: op.path };
    const key = segments.at(-1);
    if (key === undefined) return { ok: false, code: 'MALFORMED_PATCH', path: op.path };
    const failure = op.op === 'remove'
      ? removeMember(parent, key, op.path)
      : writeMember(parent, key, op.op, op.value, op.path);
    if (failure) return failure;
  }
  return { ok: true, value };
}

export function structuralEqual(left: JsonValue, right: JsonValue): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function writeMember(parent: MutableJson, key: string, op: 'add' | 'replace', value: JsonValue, path: string): PatchFailureV1 | undefined {
  if (Array.isArray(parent)) {
    if (op === 'add' && key === '-') {
      parent.push(cloneJson(value));
      return undefined;
    }
    if (!ARRAY_INDEX.test(key)) return { ok: false, code: 'MALFORMED_PATCH', path };
    const index = Number(key);
    if (op === 'add') {
      if (index > parent.length) return { ok: false, code: 'MALFORMED_PATCH', path };
      parent.splice(index, 0, cloneJson(value));
      return undefined;
    }
    if (index >= parent.length) return { ok: false, code: 'MALFORMED_PATCH', path };
    parent[index] = cloneJson(value);
    return undefined;
  }
  if (!isPlainObject(parent)) return { ok: false, code: 'MALFORMED_PATCH', path };
  if (op === 'replace' && !Object.prototype.hasOwnProperty.call(parent, key)) {
    return { ok: false, code: 'MALFORMED_PATCH', path };
  }
  defineMember(parent, key, cloneJson(value));
  return undefined;
}

function removeMember(parent: MutableJson, key: string, path: string): PatchFailureV1 | undefined {
  if (Array.isArray(parent)) {
    if (!ARRAY_INDEX.test(key)) return { ok: false, code: 'MALFORMED_PATCH', path };
    const index = Number(key);
    if (index >= parent.length) return { ok: false, code: 'MALFORMED_PATCH', path };
    parent.splice(index, 1);
    return undefined;
  }
  if (!isPlainObject(parent) || !Object.prototype.hasOwnProperty.call(parent, key)) {
    return { ok: false, code: 'MALFORMED_PATCH', path };
  }
  delete parent[key];
  return undefined;
}

function readAt(root: MutableJson, segments: readonly string[]): MutableJson | undefined {
  let current: MutableJson = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(segment)) return undefined;
      const index = Number(segment);
      if (index >= current.length) return undefined;
      current = current[index];
    } else if (isPlainObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function cloneJson(value: JsonValue): MutableJson {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  const record = value as Readonly<Record<string, JsonValue>>;
  const clone: Record<string, MutableJson> = {};
  for (const key of Object.keys(record)) defineMember(clone, key, cloneJson(record[key]));
  return clone;
}

function defineMember(target: Record<string, MutableJson>, key: string, value: MutableJson): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function isPlainObject(value: MutableJson): value is Record<string, MutableJson> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isJsonValue(value: unknown, seen: Set<object> = new Set()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index) || !isJsonValue(value[index], seen)) return false;
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!isJsonValue(record[key], seen)) return false;
    }
  }
  seen.delete(value);
  return true;
}
