export const MANIFEST_SCHEMA_VERSION = 'manifest-v1' as const;

export type ReleaseManifestArtifact = {
  path: string;
  byteSize: number;
  sha256: string;
  entryCount?: number;
  entryRange?: [number, number];
  offsets?: number[];
  lengths?: number[];
  encoding?: 'identity';
};

export type ReleaseManifest = {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  generatedAt: string;
  totalEntries: number;
  catalogueShards: Record<string, number>;
  artifacts: ReleaseManifestArtifact[];
};

const HASH = /^[0-9a-f]{64}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseArtifact(value: unknown, index: number): ReleaseManifestArtifact {
  const candidate = record(value);
  const invalid = (reason: string): never => {
    throw new Error(`Malformed manifest: invalid artifact ${index}: ${reason}`);
  };
  if (!candidate) throw new Error(`Malformed manifest: invalid artifact ${index}: expected an object`);

  const artifactPath = candidate.path;
  if (
    typeof artifactPath !== 'string' || artifactPath.length === 0 || artifactPath.includes('\\') ||
    artifactPath.startsWith('/') || artifactPath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) invalid('path must be a normalized relative path');
  const parsedPath = artifactPath as string;
  const byteSize = candidate.byteSize;
  if (!safeCount(byteSize)) invalid('byteSize must be a non-negative safe integer');
  const parsedByteSize = byteSize as number;
  const sha256 = candidate.sha256;
  if (typeof sha256 !== 'string' || !HASH.test(sha256)) invalid('sha256 must be a lowercase SHA-256 hex digest');
  const parsedSha256 = sha256 as string;
  const encoding = candidate.encoding;
  if (encoding !== undefined && encoding !== 'identity') invalid('encoding is unsupported');
  const entryCount = candidate.entryCount;
  if (entryCount !== undefined && !safeCount(entryCount)) invalid('entryCount must be a non-negative safe integer');

  let entryRange: [number, number] | undefined;
  const rawEntryRange = candidate.entryRange;
  if (rawEntryRange !== undefined) {
    if (!Array.isArray(rawEntryRange) || rawEntryRange.length !== 2) invalid('entryRange is invalid');
    const range = rawEntryRange as unknown[];
    const start = range[0];
    const end = range[1];
    if (!safeCount(start) || !safeCount(end) || start > end) invalid('entryRange is invalid');
    entryRange = [start as number, end as number];
  }

  let offsets: number[] | undefined;
  let lengths: number[] | undefined;
  const rawOffsets = candidate.offsets;
  const rawLengths = candidate.lengths;
  if (rawOffsets !== undefined || rawLengths !== undefined) {
    if (!Array.isArray(rawOffsets) || !Array.isArray(rawLengths) || rawOffsets.length !== rawLengths.length) {
      invalid('offsets and lengths must be same-sized arrays');
    }
    const offsetValues = rawOffsets as unknown[];
    const lengthValues = rawLengths as unknown[];
    offsets = offsetValues.map((offset, item) => {
      const length = lengthValues[item];
      if (!safeCount(offset) || !safeCount(length) || length <= 0 ||
        offset + length > Number.MAX_SAFE_INTEGER || offset + length > parsedByteSize) {
        invalid(`invalid byte range at item ${item}`);
      }
      return offset as number;
    });
    lengths = lengthValues.map((length, item) => {
      if (!safeCount(length) || length <= 0) invalid(`invalid byte length at item ${item}`);
      return length as number;
    });
  }
  const parsedEntryCount = entryCount === undefined ? undefined : entryCount as number;

  return {
    path: parsedPath,
    byteSize: parsedByteSize,
    sha256: parsedSha256,
    ...(parsedEntryCount !== undefined ? { entryCount: parsedEntryCount } : {}),
    ...(entryRange ? { entryRange } : {}),
    ...(offsets ? { offsets } : {}),
    ...(lengths ? { lengths } : {}),
    ...(encoding ? { encoding: 'identity' as const } : {}),
  };
}

/** Validates the release manifest before any browser reader trusts its paths or ranges. */
export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const candidate = record(value);
  if (!candidate) throw new Error('Malformed manifest: expected an object');
  if (candidate.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Malformed manifest: unsupported schemaVersion ${String(candidate.schemaVersion)}`);
  }
  if (typeof candidate.generatedAt !== 'string' || !Number.isFinite(Date.parse(candidate.generatedAt))) {
    throw new Error('Malformed manifest: generatedAt must be an ISO date');
  }
  if (!safeCount(candidate.totalEntries)) throw new Error('Malformed manifest: totalEntries must be a non-negative safe integer');
  if (!Array.isArray(candidate.artifacts)) throw new Error('Malformed manifest: artifacts must be an array');
  const artifacts = candidate.artifacts.map(parseArtifact);
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
    throw new Error('Malformed manifest: duplicate artifact path');
  }

  const rawShards = record(candidate.catalogueShards);
  if (!rawShards) throw new Error('Malformed manifest: catalogueShards index is required');
  const catalogueShards: Record<string, number> = {};
  for (const [id, shard] of Object.entries(rawShards)) {
    if (!id || !safeCount(shard)) throw new Error(`Malformed manifest: invalid shard for ${id}`);
    catalogueShards[id] = shard;
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: candidate.generatedAt,
    totalEntries: candidate.totalEntries,
    catalogueShards,
    artifacts,
  };
}
