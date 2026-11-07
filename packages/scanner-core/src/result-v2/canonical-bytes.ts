const encoder = new TextEncoder();

/** Encode secureflow-canonical-json-v1 as deterministic UTF-8 bytes. */
export function canonicalBytesV1(value: unknown): Uint8Array {
  return encoder.encode(encodeValue(value, new Set<object>()));
}

function encodeValue(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return encodeString(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Invalid canonical JSON number');
      return JSON.stringify(Object.is(value, -0) ? 0 : value) as string;
    case 'object': break;
    default: throw new TypeError('Invalid canonical JSON value');
  }
  if (seen.has(value)) throw new TypeError('Cyclic canonical JSON value');
  seen.add(value);
  try {
    return Array.isArray(value) ? encodeArray(value, seen) : encodeObject(value, seen);
  } finally {
    seen.delete(value);
  }
}

function encodeArray(value: readonly unknown[], seen: Set<object>): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('Non-plain canonical JSON array');
  const names = ownNames(value);
  const length = dataDescriptor(value, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new TypeError('Invalid array length');
  if (names.length !== length + 1 || names.some((name) => name !== 'length' && !isArrayIndex(name, length))) {
    throw new TypeError('Unsafe array properties');
  }
  const items: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) throw new TypeError('Sparse canonical JSON array');
    items.push(encodeValue(descriptor.value, seen));
  }
  return `[${items.join(',')}]`;
}

function encodeObject(value: object, seen: Set<object>): string {
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(value); } catch { throw new TypeError('Unsafe canonical JSON object'); }
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Non-plain canonical JSON object');
  const names = ownNames(value);
  names.sort(compareCodePointStrings);
  const entries: string[] = [];
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError('Unsafe canonical JSON property');
    }
    entries.push(`${encodeString(name)}:${encodeValue(descriptor.value, seen)}`);
  }
  return `{${entries.join(',')}}`;
}
function ownNames(value: object): string[] {
  let names: string[];
  let symbols: symbol[];
  try {
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch { throw new TypeError('Unsafe canonical JSON object'); }
  if (symbols.length !== 0) throw new TypeError('Symbol-bearing canonical JSON object');
  return names;
}

function dataDescriptor(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !('value' in descriptor)) throw new TypeError('Accessor in canonical JSON value');
  return descriptor.value;
}

function isArrayIndex(name: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(name)) return false;
  const index = Number(name);
  return Number.isSafeInteger(index) && index < length;
}

function encodeString(value: string): string {
  let output = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) output += '\\"';
    else if (code === 0x5c) output += '\\\\';
    else if (code === 0x08) output += '\\b';
    else if (code === 0x09) output += '\\t';
    else if (code === 0x0a) output += '\\n';
    else if (code === 0x0c) output += '\\f';
    else if (code === 0x0d) output += '\\r';
    else if (code < 0x20) output += `\\u${code.toString(16).padStart(4, '0')}`;
    else if (code >= 0xd800 && code <= 0xdfff) {
      const next = value.charCodeAt(index + 1);
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { output += value[index] + value[index + 1]; index += 1; }
      else output += `\\u${code.toString(16).padStart(4, '0')}`;
    } else output += value[index];
  }
  return `${output}"`;
}

function compareCodePointStrings(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}
