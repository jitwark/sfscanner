import { resolveReleaseTimestamp } from '../../pipeline/package/release-clock.ts';
import { validateReleaseTimestamp } from '../../pipeline/package/release-metadata.ts';

export const SCHEMA_VERSION = 'scanner-result-v1';

export function isLegacyFallback(security) {
  return security.scannerVersion === 'unscanned' ||
    security.scannerVersion === 'not-scanned' || security.analysisStatus === 'INDETERMINATE';
}

export function migrateEntry(entry, artifactPath, lineNumber) {
  const security = entry?.security;
  if (!security || typeof security !== 'object' || Array.isArray(security) || isLegacyFallback(security)) return false;
  if (security.schemaVersion !== undefined && security.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported scanner schema in ${artifactPath}${lineNumber ? `:${lineNumber}` : ''}`);
  }
  if (security.schemaVersion === SCHEMA_VERSION) return false;
  security.schemaVersion = SCHEMA_VERSION;
  return true;
}

/**
 * This migration hand-edits packaged catalogue content outside the normal
 * `buildManifest` path (`pipeline/package/manifest.ts`), so nothing else
 * forces `manifest.generatedAt` to move when it rewrites entries — that gap
 * is how commit 66b3a4f rewrote every catalogue shard's bytes without the
 * homepage's "rebuilt" date changing. Requiring an explicit release
 * timestamp up front, before any file is touched, is what makes omitting it
 * impossible: by the time this script knows whether anything actually
 * changed, it has already started rewriting catalogue shards on disk, so
 * validating only afterward could leave the corpus and manifest.json's
 * recorded byte sizes/hashes out of sync. This mirrors the same fail-closed
 * contract `run-enrichment.ts` enforces for a full package build — an
 * explicit `--generated-at` or `SOURCE_DATE_EPOCH`, never the wall clock.
 */
export function requireMigrationTimestamp(explicit) {
  const resolved = resolveReleaseTimestamp(explicit);
  if (!resolved) {
    throw new Error(
      'This migration hand-edits packaged catalogue content, so manifest.generatedAt must be able ' +
      'to move with it. Pass --generated-at <ISO timestamp> or set SOURCE_DATE_EPOCH; the release ' +
      'clock is never read from the wall clock.',
    );
  }
  return validateReleaseTimestamp(resolved);
}

/** Only a real content change earns a new generatedAt; a true no-op leaves the field alone. */
export function nextGeneratedAt({ previousGeneratedAt, changed, timestamp }) {
  return changed ? timestamp : previousGeneratedAt;
}
