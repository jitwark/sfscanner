/**
 * Serialize JSON-compatible values with locale-independent object ordering.
 * Arrays retain their input order; they are never treated as sets.
 */
export function canonicalizeJson(value: unknown): string {
  return encodeCanonical(value, new Set<object>());
}

/** Encode the canonical representation using the platform's UTF-8 encoder. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalizeJson(value));
}

function encodeCanonical(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot encode non-finite number as canonical JSON');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new TypeError(`Cannot encode ${typeof value} as canonical JSON`);
  }
  if (seen.has(value)) throw new TypeError('Cannot encode cyclic value as canonical JSON');
  seen.add(value);

  try {
    if (Array.isArray(value)) return encodeArray(value, seen);
    return encodeObject(value as Record<string, unknown>, seen);
  } finally {
    seen.delete(value);
  }
}

function encodeArray(value: readonly unknown[], seen: Set<object>): string {
  const values = Array.from({ length: value.length }, (_, index) => {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new TypeError('Cannot encode sparse array as canonical JSON');
    }
    return encodeCanonical(value[index], seen);
  });
  return `[${values.join(',')}]`;
}

function encodeObject(value: Record<string, unknown>, seen: Set<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Cannot encode a non-plain object as canonical JSON');
  }
  if (Object.getOwnPropertySymbols(value).some((symbol) =>
    Object.prototype.propertyIsEnumerable.call(value, symbol))) {
    throw new TypeError('Cannot encode symbol properties as canonical JSON');
  }

  const pairs = Object.keys(value)
    .sort(compareCanonicalStrings)
    .map((key) => `${JSON.stringify(key)}:${encodeCanonical(value[key], seen)}`);
  return `{${pairs.join(',')}}`;
}

function compareCanonicalStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
