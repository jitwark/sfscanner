export const MAX_ARTIFACT_CHARS = 25 * 1024 * 1024;
export const MAX_CATALOGUE_ARTIFACT_CHARS = 64 * 1024 * 1024;
export const MAX_SEARCH_ARTIFACT_CHARS = MAX_ARTIFACT_CHARS;
export const MAX_SEARCH_INDEX_DOCUMENTS = 50_000;
export const MAX_ID_CHARS = 256;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).some((key) => DANGEROUS_KEYS.has(key)) ? null : candidate;
}

export function count(value: unknown, max = MAX_SEARCH_INDEX_DOCUMENTS): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

export function text(value: unknown, max = 16_384): value is string {
  return typeof value === 'string' && value.length <= max;
}

export function parseJsonObject(json: string, label: string): Record<string, unknown> {
  if (typeof json !== 'string' || json.length > MAX_ARTIFACT_CHARS) {
    throw new Error(`Malformed ${label}: payload is too large`);
  }
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error(`Malformed ${label}: invalid JSON`); }
  const parsed = record(value);
  if (!parsed) throw new Error(`Malformed ${label}: expected an object`);
  return parsed;
}
