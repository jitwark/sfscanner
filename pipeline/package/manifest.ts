import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST_SCHEMA_VERSION } from '@hub/contracts/release-manifest';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { parseScannerResultSchemaVersion } from '@hub/contracts';
import { scannerSidecarArtifacts, type ScannerSidecarPolicy } from './scanner-sidecars.js';
import { validateReleaseTimestamp, type ReleaseMetadata } from './release-metadata.js';

export type ManifestArtifact = {
  path: string;
  byteSize: number;
  sha256: string;
  entryCount?: number;
  entryRange?: [number, number];
  offsets?: number[];
  lengths?: number[];
  encoding?: 'identity';
};

/**
 * What the manifest needs in order to stamp a file: where it lives, plus any count
 * the artifact itself measures. `WrittenArtifactInfo` — everything the packager
 * writes — and the declared scanner sidecars — inputs it does not write — both
 * satisfy this, so ownership can be expressed without inventing an `entryCount`
 * for a file whose records the packager does not own.
 */
export type ManifestArtifactSource = {
  relativePath: string;
  absolutePath?: string;
  entryCount?: number;
  entryRange?: [number, number];
  offsets?: number[];
  lengths?: number[];
  encoding?: 'identity';
};

export type Manifest = {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  generatedAt: string;
  totalEntries: number;
  artifacts: ManifestArtifact[];
  catalogueShards: Record<string, number>;
  metadata?: ReleaseMetadata;
};

export type BuildManifestResult = {
  manifest: Manifest;
  manifestSha256: string;
};

export type BuildManifestOptions = {
  /**
   * Whether a declared scanner sidecar that is not on disk fails the build.
   * Defaults to `'required'`: `manifest.artifacts` is the only thing
   * `check:data-sync` treats as owned, so a dropped record is a gate that passes
   * over a release missing an artifact. Only a caller building a manifest that is
   * not a release manifest passes `'optional'`, and it has to say so by name.
   */
  scannerSidecars?: ScannerSidecarPolicy;
};

function validateEntryScannerIdentity(value: unknown, artifactPath: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const security = (value as Record<string, unknown>).security;
  if (!security || typeof security !== 'object' || Array.isArray(security)) return;

  const candidate = security as Record<string, unknown>;
  const legacyFallback = candidate.scannerVersion === 'unscanned' ||
    candidate.scannerVersion === 'not-scanned' || candidate.analysisStatus === 'INDETERMINATE';
  if (candidate.schemaVersion === undefined && legacyFallback) return;

  try {
    if (candidate.schemaVersion !== 'scanner-result-v2') parseScannerResultSchemaVersion(candidate.schemaVersion);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed catalogue artifact ${artifactPath}: ${message}`, { cause: error });
  }
}

export function buildManifest(
  outputDir: string,
  artifactInfos: ManifestArtifactSource[],
  generatedAt: string,
  metadata?: ReleaseMetadata,
  options: BuildManifestOptions = {},
): BuildManifestResult {
  const timestamp = validateReleaseTimestamp(generatedAt);
  if (metadata && metadata.generatedAt !== timestamp) throw new Error('Manifest and release metadata clocks must match');
  const artifacts: ManifestArtifact[] = [];
  const catalogueShards: Record<string, number> = {};
  let totalEntries = 0;

  // The packager's own writes first, then the declared scanner sidecars. A sidecar
  // the caller already listed is not listed twice; a missing one fails the build
  // unless the caller said, by name, that this is not a release manifest.
  const writtenPaths = new Set(artifactInfos.map((info) => info.relativePath.replace(/\\/g, '/')));
  const sidecars = scannerSidecarArtifacts(outputDir, options.scannerSidecars ?? 'required')
    .filter((sidecar) => !writtenPaths.has(sidecar.relativePath));
  const sources: ManifestArtifactSource[] = [...artifactInfos, ...sidecars];

  const orderedInfos = [...sources].sort((left, right) =>
    compareCanonicalStrings(left.relativePath.replace(/\\/g, '/'), right.relativePath.replace(/\\/g, '/')),
  );
  for (const info of orderedInfos) {
    const fullPath = info.absolutePath || path.join(outputDir, info.relativePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Artifact file missing on disk: ${fullPath}`);
    }

    const fileBuf = fs.readFileSync(fullPath);
    const sha256 = crypto.createHash('sha256').update(fileBuf).digest('hex');
    const byteSize = fileBuf.length;

    const isCatalogueArtifact = /^catalogue-.*\.json$/.test(info.relativePath);
    const catalogueMatch = /^catalogue-(\d+)\.json$/.exec(info.relativePath);
    if (isCatalogueArtifact) {
      if (!catalogueMatch) {
        throw new Error(`Malformed catalogue artifact path: ${info.relativePath}`);
      }
      let parsedEntries: unknown;
      try {
        parsedEntries = JSON.parse(fileBuf.toString('utf8'));
      } catch (error) {
        throw new Error(`Malformed catalogue artifact ${info.relativePath}: invalid JSON`, { cause: error });
      }
      if (!Array.isArray(parsedEntries)) {
        throw new Error(`Malformed catalogue artifact ${info.relativePath}: expected an array`);
      }
      const shard = Number(catalogueMatch[1]);
      for (const entry of parsedEntries) {
        validateEntryScannerIdentity(entry, info.relativePath);
        if (!entry || typeof entry !== 'object' || typeof (entry as { id?: unknown }).id !== 'string' || !(entry as { id: string }).id) {
          throw new Error(`Malformed catalogue artifact ${info.relativePath}: entry missing id`);
        }
        const id = (entry as { id: string }).id;
        if (catalogueShards[id] !== undefined) {
          throw new Error(`Duplicate catalogue entry ID: ${id}`);
        }
        catalogueShards[id] = shard;
      }
      totalEntries += parsedEntries.length;
    }

    const item: ManifestArtifact = {
      path: info.relativePath.replace(/\\/g, '/'),
      byteSize,
      sha256,
    };

    if (info.entryCount !== undefined) item.entryCount = info.entryCount;
    if (info.entryRange) item.entryRange = info.entryRange;
    if (info.offsets) item.offsets = info.offsets;
    if (info.lengths) item.lengths = info.lengths;
    if (info.encoding) item.encoding = info.encoding;

    artifacts.push(item);
  }

  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: timestamp,
    totalEntries,
    artifacts,
    catalogueShards,
    ...(metadata ? { metadata } : {}),
  };

  const manifestPath = path.join(outputDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const manifestBuf = fs.readFileSync(manifestPath);
  const manifestSha256 = crypto.createHash('sha256').update(manifestBuf).digest('hex');

  return {
    manifest,
    manifestSha256,
  };
}
