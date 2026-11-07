import type { Entry } from '@hub/contracts';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3, PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4, type PublicDataProjectionV4, type PublicReleaseMetadataV4 } from '@hub/contracts/public-data-model';
import { buildPublicProjection, type PublicProjectionOptions } from './public-projection.js';
import { validateSafeSidecar } from './preflight-sidecar.js';
import type { SafePrerequisites } from './preflight-safe-builder.js';
import { assertPublicProjection } from './public-export-validation.js';
import { withholdLegacyReferenceTokens } from './v4-legacy-reference-privacy.js';

export function buildPublicProjectionV4(entries: readonly Entry[], options: Omit<PublicProjectionOptions, 'release'> & {
  release: PublicReleaseMetadataV4; preflight: readonly SafePrerequisites[]; inventorySha256: string;
}): PublicDataProjectionV4 {
  if (options.release.schemaVersion !== PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4) throw new Error('V4 projection requires V4 release metadata');
  validateSafeSidecar(options.preflight, options.inventorySha256, entries.map((entry) => entry.id));
  const legacy = buildPublicProjection(entries, { ...options, linkOnly: true,
    release: { ...options.release, schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3 } });
  const ids = new Set(legacy.workflows.map((row) => row.workflowId));
  const selected = options.preflight.filter((record) => ids.has(record.coverage.workflowId));
  const projection: PublicDataProjectionV4 = {
    ...legacy, ...withholdLegacyReferenceTokens(legacy), schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4,
    release: options.release, releases: [options.release],
    preflightCoverage: selected.map((record) => record.coverage),
    preflightEvidence: selected.flatMap((record) => record.evidence),
  };
  assertPublicProjection(projection);
  return projection;
}
