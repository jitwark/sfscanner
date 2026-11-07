/**
 * Re-stamp `data/manifest.json` from the bytes on disk, through the same two
 * production functions a full package build uses: `buildReleaseMetadata`
 * (which composes `hashReleaseDirectory` for `metadata.corpusSha256`) and
 * `buildManifest` (the writer).
 *
 * Why this exists: commit `423b369` rewrote five catalogue shards (the P3-1a
 * stamp) and did not re-stamp the manifest that describes them, so
 * `check:corpus` / `check:release` failed and `metadata.corpusSha256` still
 * described the parent tree. This repairs the descriptions of already-committed
 * bytes; it must not change a single byte of any other artifact.
 *
 * The artifact inventory (paths, entryCount, entryRange, offsets, lengths,
 * encoding) is carried forward from the existing manifest — those records are
 * what the packager measured, and re-deriving them here would be a second
 * source of truth. Only byteSize/sha256 are recomputed, from disk, by
 * `buildManifest` itself. No hash is written by hand.
 *
 * `generatedAt` is deliberately left alone: `nextGeneratedAt`
 * (`scripts/lib/scanner-result-schema-migration.mjs`) moves the field only when
 * corpus content changed, and nothing here does — the bytes are identical
 * before and after except `manifest.json` describing them.
 *
 * Usage: node --import tsx scripts/restamp-release-manifest.ts [dataDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildManifest, type ManifestArtifactSource } from '../pipeline/package/manifest.js';
import { buildReleaseMetadata, hashReleaseDirectory } from '../pipeline/package/release-metadata.js';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.resolve(process.argv[2] ?? path.join(root, 'data'));
const manifestPath = path.join(dataDir, 'manifest.json');
const previousBytes = fs.readFileSync(manifestPath);
const previous = JSON.parse(previousBytes.toString('utf8'));
const previousMetadata = previous.metadata;
if (!previousMetadata) throw new Error(`${manifestPath} has no metadata block to carry forward`);

/** The packager's own record of what each artifact contains; sizes/hashes come from disk. */
const sources: ManifestArtifactSource[] = (previous.artifacts ?? []).map((artifact: Record<string, unknown>) => ({
  relativePath: String(artifact.path),
  ...(artifact.entryCount !== undefined ? { entryCount: artifact.entryCount as number } : {}),
  ...(artifact.entryRange !== undefined ? { entryRange: artifact.entryRange as [number, number] } : {}),
  ...(artifact.offsets !== undefined ? { offsets: artifact.offsets as number[] } : {}),
  ...(artifact.lengths !== undefined ? { lengths: artifact.lengths as number[] } : {}),
  ...(artifact.encoding !== undefined ? { encoding: artifact.encoding as 'identity' } : {}),
}));

const metadata = buildReleaseMetadata({
  outputDir: dataDir,
  corpusId: previousMetadata.corpusId,
  sanitizerVersion: previousMetadata.sanitizerVersion,
  scannerVersion: previousMetadata.scannerVersion,
  ...(previousMetadata.promptVersion ? { promptVersion: previousMetadata.promptVersion } : {}),
  ...(previousMetadata.promptSha256 ? { promptSha256: previousMetadata.promptSha256 } : {}),
  ...(previousMetadata.descriptionSchemaVersion ? { descriptionSchemaVersion: previousMetadata.descriptionSchemaVersion } : {}),
  ...(previousMetadata.model ? { model: previousMetadata.model } : {}),
  ...(previousMetadata.compatibilityTarget ? { compatibilityTarget: previousMetadata.compatibilityTarget } : {}),
  ...(previousMetadata.producingCommit ? { producingCommit: previousMetadata.producingCommit } : {}),
  generatedAt: previous.generatedAt,
});

const { manifest, manifestSha256 } = buildManifest(dataDir, sources, previous.generatedAt, metadata);

// Fail closed: this script exists to repair hash descriptions, nothing else. If the
// production writer produced any other difference, the tree is not what this repair
// assumes, so put the committed bytes back rather than shipping an unexplained change.
const restore = (reason: string): never => {
  fs.writeFileSync(manifestPath, previousBytes);
  throw new Error(`${reason} — previous manifest restored, nothing shipped`);
};

const before: Record<string, Record<string, unknown>> = {};
for (const artifact of previous.artifacts ?? []) before[String(artifact.path)] = artifact;
if (manifest.artifacts.length !== Object.keys(before).length) {
  restore(`artifact count changed: ${Object.keys(before).length} -> ${manifest.artifacts.length}`);
}
const restamped: string[] = [];
for (const artifact of manifest.artifacts) {
  const old = before[artifact.path];
  if (!old) restore(`unexpected artifact added: ${artifact.path}`);
  if (old.byteSize !== artifact.byteSize || old.sha256 !== artifact.sha256) restamped.push(artifact.path);
  for (const key of ['entryCount', 'entryRange', 'offsets', 'lengths', 'encoding'] as const) {
    if (JSON.stringify(old[key]) !== JSON.stringify(artifact[key])) {
      restore(`${artifact.path}: ${key} moved`);
    }
  }
}
if (JSON.stringify(previous.catalogueShards) !== JSON.stringify(manifest.catalogueShards)) restore('catalogueShards map moved');
if (previous.totalEntries !== manifest.totalEntries) restore('totalEntries moved');
if (previous.generatedAt !== manifest.generatedAt) restore('generatedAt moved');

const corpusSha256 = hashReleaseDirectory(dataDir);
if (manifest.metadata?.corpusSha256 !== corpusSha256) {
  restore(`metadata.corpusSha256 ${manifest.metadata?.corpusSha256} != hashReleaseDirectory ${corpusSha256}`);
}

console.log(`manifest            ${path.relative(root, manifestPath)}`);
console.log(`manifest sha256     ${manifestSha256}`);
console.log(`artifacts           ${manifest.artifacts.length} (${restamped.length} re-stamped)`);
for (const artifact of manifest.artifacts) {
  if (!restamped.includes(artifact.path)) continue;
  console.log(`  ${artifact.path}: ${before[artifact.path].byteSize} -> ${artifact.byteSize} bytes`);
}
console.log(`corpusSha256        ${previousMetadata.corpusSha256} -> ${corpusSha256}`);
console.log(`generatedAt         ${manifest.generatedAt} (unchanged)`);
