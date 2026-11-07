export const MAX_BYTE_RANGE_BYTES = 512_000;

export type ByteRangeIndexEntry = {
  offset: number;
  length: number;
  sha256: string;
};

export type ByteRangeIndex = Record<string, ByteRangeIndexEntry>;

const HASH = /^[0-9a-f]{64}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Validates a per-shard byte index before a reader trusts its ranges or hashes. */
export function parseByteRangeIndex(value: unknown): ByteRangeIndex {
  const candidate = record(value);
  if (!candidate) throw new Error('Malformed byte-range index: expected an object');

  const parsed: ByteRangeIndex = {};
  for (const [id, raw] of Object.entries(candidate)) {
    const entry = record(raw);
    const offset = entry?.offset;
    const length = entry?.length;
    const sha256 = entry?.sha256;
    if (
      id.length === 0 || id.length > 1_024 || !entry ||
      typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
      typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0 || length > MAX_BYTE_RANGE_BYTES ||
      offset + length > Number.MAX_SAFE_INTEGER ||
      typeof sha256 !== 'string' || !HASH.test(sha256)
    ) {
      throw new Error(`Malformed byte-range index: invalid entry for ${id}`);
    }
    // Define rather than assign so a JSON "__proto__" key cannot mutate the
    // parsed index's prototype while retaining a normal object for callers.
    Object.defineProperty(parsed, id, {
      value: { offset, length, sha256 },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return parsed;
}
