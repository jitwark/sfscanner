import type { ExportProjection } from './export-version.js';
import { buildReleaseBundle, defaultPublicReleaseWriters, type PublicReleaseBundle, type PublicReleaseWriters } from './bundle-builder.js';
import { promoteReleaseBundle } from './bundle-promotion.js';

export type { PublicReleaseBundle, PublicReleaseWriters };

/**
 * Write a complete, multi-format public release bundle (NDJSON, SQLite,
 * Excel, documentation, manifest) and publish it to `outputDir` atomically:
 * the bundle is built in full in a sibling staging directory and validated
 * there, then promoted into place with a single visibility swap so
 * `outputDir` is never observed in a mixed old/new state. See
 * `bundle-promotion.ts` for the Windows-safe swap and previous-bundle
 * preservation, and `bundle-builder.ts` for the writer sequence.
 *
 * `writers` is test-only: production callers should never pass it. It lets
 * the atomicity tests inject a failure after a specific writer boundary.
 */
export function writePublicRelease(projection: ExportProjection, outputDir: string, writers: PublicReleaseWriters = defaultPublicReleaseWriters): PublicReleaseBundle {
  return promoteReleaseBundle(outputDir, (stagingDir) => buildReleaseBundle(projection, stagingDir, writers));
}
