import type { LiteralValue } from './metadata-ast.js';

/**
 * Canonicalizes a statically resolved `version` value into semver strings.
 * A number is major.minor.patch with integer part as major, at most two
 * fractional digits as minor, and patch 0: `2` → `2.0.0`, `2.1` → `2.1.0`.
 * Exponent spelling, negatives, non-finite values, and more than two
 * fractional digits are rejected.
 */
export function canonicalVersions(value: LiteralValue): string[] | null {
  const items = value.kind === 'scalar' ? [value] : value.kind === 'array' ? value.items : [];
  if (items.length === 0) return null;

  const versions = new Set<string>();
  for (const item of items) {
    const canonical = canonicalVersion(item);
    if (canonical === null) return null;
    versions.add(canonical);
  }
  return [...versions].sort(compareSemver);
}

function canonicalVersion(value: LiteralValue): string | null {
  if (value.kind !== 'scalar' || typeof value.value !== 'number') return null;
  if (!Number.isFinite(value.value) || value.value < 0 || Object.is(value.value, -0)) return null;
  if (value.text !== undefined && /[eE]/.test(value.text)) return null;

  const text = String(value.value);
  if (/[eE]/.test(text)) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) return null;

  const fraction = match[2] ?? '';
  if (fraction.length > 2) return null;
  const major = Number(match[1]);
  const minor = fraction === '' ? 0 : Number(fraction);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
  return `${major}.${minor}.0`;
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  return (leftParts[0]! - rightParts[0]!)
    || (leftParts[1]! - rightParts[1]!)
    || (leftParts[2]! - rightParts[2]!)
    || (left < right ? -1 : left > right ? 1 : 0);
}
