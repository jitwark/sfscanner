/**
 * One immutable release identity, derived from the artifacts rather than typed in:
 * the scanner version, the corpus manifest and its hash, the published dataset's
 * declared format hashes, the public data schema, the commit, the rights note and the
 * destination. Every component is read from an artifact and reconciled against its
 * neighbours, so a release cannot be assembled from a corpus and a dataset bundle that
 * describe different things.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fail, jsonFile, record, sha256 } from './release-artifacts.mjs';
import { artifactEntry, assertDescriptorBindings, sourceLabel } from './release-identity-bindings.mjs';

export const IDENTITY_SCHEMA = 'release-identity-v1';
/** The rollback unit is the whole release: site and data are promoted and restored together. */
export const ROLLBACK_UNIT = 'site+data+export';
/**
 * The released families, with the provenance and rights scope each one carries. `site`
 * is the published pages, `data` is the catalogue and search metadata whose bodies are
 * never redistributed, and `export` is the redistributable-only projection. Keeping the
 * table here rather than at each call site is what stops a release being described with
 * rights it does not have.
 */
export const RELEASE_FAMILIES = Object.freeze([
  Object.freeze({ name: 'site', provenance: 'next-static-export', rightsScope: 'published-site-pages' }),
  Object.freeze({ name: 'data', provenance: 'corpus-regeneration-output', rightsScope: 'public-catalogue-and-search-metadata' }),
  Object.freeze({ name: 'export', provenance: 'public-dataset-projection', rightsScope: 'redistributable-only-projection' }),
]);
const DIGEST = /^[a-f0-9]{64}$/u;

/** The scanner's own version lives in one source constant; read it as text, as the legal gate does. */
export async function readScannerVersion(repoRoot) {
  const source = await readFile(path.join(repoRoot, 'packages', 'scanner-core', 'src', 'scanner-version.ts'), 'utf8');
  const version = source.match(/SCANNER_VERSION\s*=\s*'([^']+)'/u)?.[1];
  if (!version) fail('scanner version authority does not declare SCANNER_VERSION');
  return version;
}

/** The exported site carries its own canonical origin in robots.txt; that is the destination. */
async function siteOrigin(siteDirectory) {
  const robots = await readFile(path.join(siteDirectory, 'robots.txt'), 'utf8');
  const url = robots.match(/^Sitemap:\s*(\S+)\/sitemap\.xml\s*$/mu)?.[1];
  if (!url) fail('the exported site does not declare a sitemap origin, so the release destination is unknown');
  return url;
}

async function firebaseHosting(repoRoot) {
  const config = await jsonFile(path.join(repoRoot, 'firebase.json'), 'firebase hosting configuration');
  const hosting = record(config) ? config.hosting : undefined;
  if (!record(hosting) || typeof hosting.public !== 'string') fail('firebase hosting configuration declares no public directory');
  const headers = Array.isArray(hosting.headers) ? hosting.headers : [];
  const global = headers.find((entry) => record(entry) && entry.source === '**');
  const robots = record(global) && Array.isArray(global.headers) ? global.headers.find((header) => record(header) && header.key === 'X-Robots-Tag') : undefined;
  return {
    publicDirectory: hosting.public,
    cleanUrls: hosting.cleanUrls === true,
    trailingSlash: hosting.trailingSlash === true,
    edgeRobotsHeader: record(robots) && typeof robots.value === 'string' ? robots.value : null,
  };
}

/** The dataset's declared per-format hashes must describe the bytes that are about to ship. */
async function reconcileExportBytes(exportDirectory, exportManifest) {
  const formats = record(exportManifest) ? exportManifest.formats : undefined;
  if (!record(formats)) fail('the published dataset declares no formats');
  for (const [name, format] of Object.entries(formats)) {
    if (!record(format) || typeof format.path !== 'string' || format.sha256 === undefined) continue;
    if (!DIGEST.test(format.sha256) || !Number.isSafeInteger(format.byteSize)) fail(`the published dataset's ${name} record is invalid`);
    const bytes = await readFile(path.join(exportDirectory, format.path)).catch(() => null);
    if (bytes === null) fail(`the published dataset's ${name} file is missing: ${format.path}`);
    if (bytes.length !== format.byteSize || sha256(bytes) !== format.sha256) fail(`the published dataset's ${name} bytes do not match its own record`);
  }

  const ndjson = record(formats.ndjson) ? formats.ndjson : undefined;
  if (!record(ndjson) || typeof ndjson.path !== 'string' || !Number.isSafeInteger(ndjson.files)) fail('the published dataset declares no ndjson record');
  const shardDirectory = path.join(exportDirectory, ndjson.path);
  const manifest = await jsonFile(path.join(shardDirectory, 'public-release.json'), 'published dataset ndjson manifest');
  if (manifest.releaseId !== exportManifest.releaseId || manifest.schemaVersion !== exportManifest.schemaVersion) {
    fail('the ndjson shard manifest describes a different release than the dataset manifest');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== ndjson.files) {
    fail(`the published dataset declares ${String(ndjson.files)} ndjson files but lists ${String(manifest.files?.length)}`);
  }
  const shipped = (await readdir(shardDirectory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.ndjson')).length;
  if (shipped !== ndjson.files) fail(`the published dataset declares ${String(ndjson.files)} ndjson files but ships ${String(shipped)}`);
  for (const shard of manifest.files) {
    if (!record(shard) || typeof shard.path !== 'string' || !DIGEST.test(shard.sha256) || !Number.isSafeInteger(shard.rowCount)) fail('the ndjson shard manifest has an invalid record');
    const bytes = await readFile(path.join(shardDirectory, shard.path)).catch(() => null);
    if (bytes === null || bytes.length !== shard.byteSize || sha256(bytes) !== shard.sha256) fail(`the ${String(shard.relation)} ndjson shard does not match its own record`);
  }
  const workflows = manifest.files.find((shard) => shard.relation === 'workflows');
  if (!workflows || workflows.rowCount !== exportManifest.relations.workflows) fail('the ndjson workflow shard disagrees with the dataset relation count');
}

export async function deriveIdentity({ repoRoot, siteSource, dataSource, exportSource, sections, noindex, tree, tools, inputs, optionalArtifacts }) {
  assertDescriptorBindings({ tree, tools, inputs, optionalArtifacts });
  if (!record(noindex) || typeof noindex.meta !== 'string' || !Number.isSafeInteger(noindex.htmlFiles) || noindex.robotsIsDisallowAll !== true) {
    fail('the release identity needs the staged site\'s verified noindex facts');
  }
  if (!record(sections)) fail('the release identity needs the released sections to describe their provenance');
  const sources = { site: siteSource, data: dataSource, export: exportSource };
  const artifacts = RELEASE_FAMILIES.map((family) => artifactEntry({ ...family, rollbackUnit: ROLLBACK_UNIT, source: sourceLabel(repoRoot, sources[family.name]), section: sections[family.name] }));
  const { value: manifest, bytes: manifestBytes } = await jsonFile(path.join(dataSource, 'manifest.json'), 'corpus manifest', true);
  const metadata = record(manifest) ? manifest.metadata : undefined;
  if (!record(metadata) || !DIGEST.test(String(metadata.corpusSha256)) || typeof metadata.generatedAt !== 'string' ||
    typeof metadata.corpusId !== 'string' || !Number.isSafeInteger(manifest.totalEntries)) {
    fail('the corpus manifest does not carry a complete release identity');
  }
  const analytics = await jsonFile(path.join(dataSource, 'analytics.json'), 'corpus analytics');
  const rights = record(analytics) ? analytics.rights : undefined;
  if (!record(rights) || !Number.isSafeInteger(rights.redistributable) || !Number.isSafeInteger(rights.linkOnly)) fail('corpus analytics declares no rights split');
  if (analytics.total !== manifest.totalEntries) fail(`corpus analytics counts ${String(analytics.total)} entries but the manifest counts ${String(manifest.totalEntries)}`);
  if (rights.redistributable + rights.linkOnly !== analytics.total) fail('the rights split does not add up to the catalogue total');

  const exportManifest = await jsonFile(path.join(exportSource, 'public-release.json'), 'published dataset manifest');
  const relations = record(exportManifest) ? exportManifest.relations : undefined;
  if (!record(relations) || !Number.isSafeInteger(relations.workflows)) fail('the published dataset declares no workflow count');
  if (relations.workflows !== manifest.totalEntries) {
    fail(`the published dataset describes ${String(relations.workflows)} workflows but the corpus holds ${String(manifest.totalEntries)} entries`);
  }
  const exportSchema = await jsonFile(path.join(exportSource, 'schema.json'), 'published dataset schema');
  if (exportSchema.schemaVersion !== exportManifest.schemaVersion) fail('the published dataset schema disagrees with its own manifest');
  await reconcileExportBytes(exportSource, exportManifest);

  const hosting = await firebaseHosting(repoRoot);
  const scannerVersion = await readScannerVersion(repoRoot);
  return Object.freeze({
    schemaVersion: IDENTITY_SCHEMA,
    tree: Object.freeze({ commit: tree.commit, clean: tree.clean, dirty: tree.dirty, dirtyFiles: Object.freeze([...tree.dirtyFiles]) }),
    tools: Object.freeze({ node: tools.node, npm: tools.npm, lockfile: Object.freeze({ ...tools.lockfile }) }),
    inputs: Object.freeze({ ...inputs }),
    artifacts: Object.freeze(artifacts),
    optionalArtifacts: Object.freeze(optionalArtifacts.map((artifact) => Object.freeze({ ...artifact }))),
    scanner: Object.freeze({ version: scannerVersion, corpusScanVersion: metadata.scannerVersion ?? null }),
    corpus: Object.freeze({
      manifestSchemaVersion: manifest.schemaVersion,
      corpusId: metadata.corpusId,
      generatedAt: metadata.generatedAt,
      totalEntries: manifest.totalEntries,
      corpusSha256: metadata.corpusSha256,
      manifestSha256: sha256(manifestBytes),
    }),
    exportManifest: Object.freeze({ schemaVersion: exportManifest.schemaVersion, releaseId: exportManifest.releaseId, relations: Object.freeze({ ...relations }), formats: exportManifest.formats }),
    rights: Object.freeze({
      note: `${manifest.totalEntries} catalogue entries: ${rights.redistributable} redistributable workflow bodies and ${rights.linkOnly} link-only entries whose bodies are never redistributed.`,
      redistributable: rights.redistributable,
      linkOnly: rights.linkOnly,
      total: analytics.total,
      evidence: Object.freeze(['data/manifest.json', 'data/analytics.json', 'DATA-LICENSE.md', 'THIRD_PARTY_NOTICES.md']),
    }),
    destination: Object.freeze({
      provider: 'firebase-hosting',
      publicDirectory: hosting.publicDirectory,
      siteUrl: await siteOrigin(siteSource),
      cleanUrls: hosting.cleanUrls,
      trailingSlash: hosting.trailingSlash,
      edgeRobotsHeader: hosting.edgeRobotsHeader,
      noindex: true,
    }),
    noindex: Object.freeze({
      meta: noindex.meta,
      htmlFiles: noindex.htmlFiles,
      robotsIsDisallowAll: noindex.robotsIsDisallowAll,
      verifiedBy: 'scripts/lib/release-staging.mjs#inspectNoindex',
    }),
  });
}

/** A release ID is content-addressed: it changes when any released byte or identity input changes. */
export function sealIdentity(identity, sectionHashes) {
  const sections = Object.freeze({ ...sectionHashes });
  for (const [name, hash] of Object.entries(sections)) if (!DIGEST.test(String(hash))) fail(`section ${name} has no digest to seal`);
  const digest = sha256(Buffer.from(JSON.stringify({ ...identity, sections }), 'utf8'));
  return Object.freeze({ ...identity, sections, digest });
}

export function releaseIdFrom(identity) {
  const day = String(identity.corpus.generatedAt).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) fail('the corpus manifest carries no release date');
  return `release-${day}-${identity.digest.slice(0, 12)}`;
}

/**
 * The release record. `rollbackIdentity` names the unit a rollback restores and the
 * release that was active before it, so the descriptor states what "go back" means
 * without a reader having to infer it from the ledger. Every section is listed, because
 * restoring the site without the corpus it serves is a different release, not a rollback.
 */
export function releaseRecord({ identity, releaseId, sequence, schemas, sections, previousRelease }) {
  if (previousRelease !== null && (!record(previousRelease) || typeof previousRelease.releaseId !== 'string' || !Number.isSafeInteger(previousRelease.sequence))) {
    fail('a release record needs a previous-release pointer or an explicit null');
  }
  const restore = Object.keys(sections).sort();
  const declared = RELEASE_FAMILIES.map((family) => family.name).sort();
  if (restore.length !== declared.length || restore.some((name, index) => name !== declared[index])) {
    fail(`a release must carry every rollback unit member: expected ${declared.join('+')}, got ${restore.join('+') || 'none'}`);
  }
  return Object.freeze({
    schemaVersion: schemas.release,
    artifactSchemaVersion: schemas.artifact,
    releaseId,
    sequence,
    verified: true,
    verification: Object.freeze({ status: 'verified', method: 'staged-section-hashes-v1', evidence: 'trusted-release-ledger.json' }),
    rollbackIdentity: Object.freeze({
      schemaVersion: 'release-rollback-identity-v1',
      unit: ROLLBACK_UNIT,
      restore: Object.freeze(restore),
      releaseId,
      sequence,
      previousReleaseId: previousRelease === null ? null : previousRelease.releaseId,
      previousSequence: previousRelease === null ? null : previousRelease.sequence,
    }),
    identity,
    ...sections,
  });
}
