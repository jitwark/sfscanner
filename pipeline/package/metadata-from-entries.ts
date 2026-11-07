import type { Entry } from '@hub/contracts';
import { buildReleaseMetadata } from './release-metadata.js';
import type { CompatibilityTarget } from './release-metadata.js';
import { SANITIZER_VERSION } from '../sanitize/version.js';

export type MetadataFromEntriesOptions = {
  /**
   * Build stamps that may legitimately coexist with one real engine version.
   *
   * The recorded `scannerVersion` on pre-regeneration results is such a stamp:
   * `c998701` is a git-abbreviation build stamp, not an engine identity, and it
   * stays on entries whose body is not available to rescan. A caller must name
   * it — the default is empty — because "two competing real versions" must keep
   * failing for every caller that has not deliberately declared one.
   */
  legacyScannerStamps?: readonly string[];
};

export function buildMetadataFromEntries(
  entries: Entry[],
  outputDir: string,
  compatibilityTarget: CompatibilityTarget,
  generatedAt: string,
  options: MetadataFromEntriesOptions = {},
): ReturnType<typeof buildReleaseMetadata> {
  const scannerVersions = [...new Set(entries.map((entry) => entry.security?.scannerVersion).filter((value): value is string => Boolean(value)))];
  // A release may mix one real scanner version with the explicit 'not-scanned'
  // marker on link-only entries that never had a body to scan, plus any build
  // stamp its caller declared by name. What it may never contain is 'unknown'
  // (an entry whose scan provenance was lost) or two competing real versions.
  const declared = new Set(options.legacyScannerStamps ?? []);
  const realVersions = scannerVersions.filter((version) => version !== 'not-scanned' && !declared.has(version));
  if (scannerVersions.includes('unknown')) {
    throw new Error('Release metadata requires a known scannerVersion; found unknown');
  }
  if (realVersions.length > 1) {
    throw new Error('Release metadata requires a known scannerVersion; found mixed');
  }
  const generatedProvenance = entries
    .filter((entry) => entry.descriptionSource === 'generated')
    .map((entry) => entry.descriptionProvenance)
    .filter((value): value is NonNullable<Entry['descriptionProvenance']> => Boolean(value));
  if (generatedProvenance.some((value) => value.source !== 'gemini' || !value.model || !value.promptVersion || !value.promptHash || !value.schemaVersion || !value.workflowHash || !value.generatedAt)) {
    throw new Error('Generated entries require complete Gemini provenance before packaging');
  }
  const promptVersions = [...new Set(generatedProvenance.map((value) => value.promptVersion).filter((value): value is string => Boolean(value)))];
  const promptHashes = [...new Set(generatedProvenance.map((value) => value.promptHash).filter((value): value is string => Boolean(value)))];
  const models = [...new Set(generatedProvenance.map((value) => value.model).filter((value): value is string => Boolean(value)))];
  const schemas = [...new Set(generatedProvenance.map((value) => value.schemaVersion).filter((value): value is string => Boolean(value)))];
  return buildReleaseMetadata({
    outputDir,
    corpusId: outputDir.split(/[\\/]/u).pop() ?? 'community-hub',
    sanitizerVersion: SANITIZER_VERSION,
    scannerVersion: realVersions.length === 1 ? realVersions[0]! : 'not-scanned',
    ...(promptVersions.length === 1 ? { promptVersion: promptVersions[0] } : {}),
    ...(promptHashes.length === 1 ? { promptSha256: promptHashes[0] } : {}),
    ...(models.length === 1 && promptVersions.length === 1 ? { model: models[0] } : {}),
    ...(schemas.length === 1 ? { descriptionSchemaVersion: schemas[0] } : {}),
    compatibilityTarget,
    generatedAt,
  });
}
