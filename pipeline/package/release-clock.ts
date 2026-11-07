/** Resolve the immutable timestamp used by a reproducible package build. */
export function resolveReleaseTimestamp(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const raw = process.env.SOURCE_DATE_EPOCH;
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error('SOURCE_DATE_EPOCH must be a non-negative Unix timestamp');
  }
  return new Date(seconds * 1000).toISOString();
}
