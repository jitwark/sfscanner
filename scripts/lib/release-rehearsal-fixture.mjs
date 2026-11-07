/**
 * Two complete local release generations — site, corpus and dataset — for the rollback
 * rehearsal and the verify regression. They are built here rather than read from
 * `app/out` and `outputs/` because the point of the rehearsal is that the *site and the
 * corpus both change* between the two releases: a drill that shares its site and data
 * bytes cannot prove that a rollback restores them together.
 *
 * The shape is the real one, deliberately: `robots.txt` declares a sitemap origin, pages
 * carry `<head>`, one page is a deep link, one asset is content-addressed like
 * `_next/static`, and the corpus and dataset declare the counts and digests a release
 * reconciles against. `rehearsal.invalid` is the destination on purpose — a drill must
 * not be mistakable for a real release.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './release-artifacts.mjs';
import { INVENTORY_ALGORITHM, INVENTORY_SCHEMA_VERSION, inventoryDigest } from './published-secret-input-inventory.mjs';

const ORIGIN = 'https://rehearsal.invalid';
const SCANNER_VERSION = 'scanner-beta-1';
const BODY_FILES = Object.freeze(['official__1_drill-alpha.json', 'official__2_drill-beta.json']);
const PEPPER = 'release-rehearsal-pepper';

/** The prior and current generations differ in every released family, not only the dataset. */
export const GENERATIONS = Object.freeze({
  prior: Object.freeze({ generatedAt: '2026-09-24T00:00:00.000Z', corpusId: 'drill-prior', marker: 'generation-prior', siteRev: 11 }),
  current: Object.freeze({ generatedAt: '2026-09-25T00:00:00.000Z', corpusId: 'drill-current', marker: 'generation-current', siteRev: 12 }),
});

const bytesOf = (text) => Buffer.from(text, 'utf8');
const jsonBytes = (value) => bytesOf(`${JSON.stringify(value, null, 2)}\n`);

async function writeBytes(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

/**
 * A verified input-inventory snapshot in the real record's shape. The two bodies are the
 * drill's own, and the digest is computed with the production function, so the drill
 * exercises the identical self-check the released snapshot does.
 */
export async function writeDrillSnapshot(snapshotPath) {
  const entries = BODY_FILES.map((name) => {
    const bytes = bytesOf(`{"drill":"${name}"}\n`);
    return { name, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const digest = inventoryDigest(entries);
  await writeBytes(snapshotPath, jsonBytes({
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    algorithm: INVENTORY_ALGORITHM,
    inventoryDigest: digest,
    fileCount: entries.length,
    totalBytes,
    files: entries,
  }));
  return Object.freeze({ path: snapshotPath, fileCount: entries.length, totalBytes, inventoryDigest: digest });
}

/**
 * One generation's site, corpus and dataset, plus the facts the rehearsal asserts after a
 * rollback: the deep link, the immutable asset it references, and the corpus identity.
 */
export async function writeGeneration(destination, generation) {
  const site = path.join(destination, 'site');
  const data = path.join(destination, 'data');
  const exportSource = path.join(destination, 'export');
  const assetPath = `_next/static/chunks/main-${sha256(bytesOf(`${PEPPER}:${generation.marker}`)).slice(0, 12)}.js`;
  const assetBytes = bytesOf(`/* ${generation.marker} */\nexport const rev = ${String(generation.siteRev)};\n`);
  const deepLink = 'workflows/alpha/index.html';
  const page = (title) => bytesOf(`<!doctype html><html><head><title>${title}</title><link rel="canonical" href="${ORIGIN}/workflows/alpha/"/></head><body data-marker="${generation.marker}"><script src="/${assetPath}"></script></body></html>\n`);

  await writeBytes(path.join(destination, 'generation.json'), jsonBytes({ marker: generation.marker, corpusId: generation.corpusId, deepLink, assetPath }));
  await writeBytes(path.join(site, 'robots.txt'), bytesOf(`User-agent: *\nDisallow: /w/view*\n\nSitemap: ${ORIGIN}/sitemap.xml\n`));
  await writeBytes(path.join(site, 'index.html'), page('Drill index'));
  await writeBytes(path.join(site, '404.html'), page('Drill not found'));
  await writeBytes(path.join(site, deepLink), page('Drill workflow alpha'));
  await writeBytes(path.join(site, assetPath), assetBytes);

  const catalogue = jsonBytes({ corpusId: generation.corpusId, entries: [{ id: 'alpha' }, { id: 'beta' }] });
  const searchIndex = jsonBytes({ corpusId: generation.corpusId, documentCount: 2 });
  const semanticIndex = jsonBytes({ corpusId: generation.corpusId, vectors: 2 });
  const analytics = jsonBytes({ total: 2, rights: { redistributable: 1, linkOnly: 1 }, corpusId: generation.corpusId });
  const manifest = jsonBytes({
    schemaVersion: 'manifest-v1',
    generatedAt: generation.generatedAt,
    totalEntries: 2,
    catalogueShards: { alpha: 0 },
    artifacts: [
      { path: 'analytics.json', byteSize: analytics.length, sha256: sha256(analytics), entryCount: 2 },
      { path: 'catalogue-0.json', byteSize: catalogue.length, sha256: sha256(catalogue), entryCount: 2, entryRange: [0, 1] },
      { path: 'search-index.json', byteSize: searchIndex.length, sha256: sha256(searchIndex) },
      { path: 'semantic-index.json', byteSize: semanticIndex.length, sha256: sha256(semanticIndex) },
    ],
    metadata: {
      corpusId: generation.corpusId,
      corpusSha256: sha256(bytesOf(`${PEPPER}:corpus:${generation.corpusId}`)),
      scannerVersion: SCANNER_VERSION,
      generatedAt: generation.generatedAt,
    },
  });
  await writeBytes(path.join(data, 'manifest.json'), manifest);
  await writeBytes(path.join(data, 'analytics.json'), analytics);
  await writeBytes(path.join(data, 'catalogue-0.json'), catalogue);
  await writeBytes(path.join(data, 'search-index.json'), searchIndex);
  await writeBytes(path.join(data, 'semantic-index.json'), semanticIndex);

  const releaseId = `dataset-${generation.corpusId}`;
  const sqlite = bytesOf(`SQLite format 3\0${generation.marker}\n`);
  const excel = bytesOf(`PK\u0003\u0004${generation.marker}\n`);
  const shard = jsonBytes({ relation: 'workflows', corpusId: generation.corpusId, rows: 2 });
  await writeBytes(path.join(exportSource, 'release.sqlite'), sqlite);
  await writeBytes(path.join(exportSource, 'release.xlsx'), excel);
  await writeBytes(path.join(exportSource, 'ndjson', 'workflows.ndjson'), shard);
  await writeBytes(path.join(exportSource, 'ndjson', 'public-release.json'), jsonBytes({
    schemaVersion: 'public-data-model-v1',
    releaseId,
    files: [{ relation: 'workflows', path: 'workflows.ndjson', byteSize: shard.length, sha256: sha256(shard), rowCount: 2 }],
  }));
  await writeBytes(path.join(exportSource, 'schema.json'), jsonBytes({ schemaVersion: 'public-data-model-v1', corpusId: generation.corpusId }));
  await writeBytes(path.join(exportSource, 'data-dictionary.json'), jsonBytes({ generation: generation.marker, relations: 2 }));
  await writeBytes(path.join(exportSource, 'release-notes.md'), bytesOf(`# Release notes (${generation.marker})\n`));
  await writeBytes(path.join(exportSource, 'examples.json'), jsonBytes({ generation: generation.marker }));
  await writeBytes(path.join(exportSource, 'public-release.json'), jsonBytes({
    schemaVersion: 'public-data-model-v1',
    releaseId,
    relations: { workflows: 2, findings: 1 },
    formats: {
      ndjson: { path: 'ndjson', manifestPath: 'ndjson/public-release.json', files: 1 },
      sqlite: { path: 'release.sqlite', byteSize: sqlite.length, sha256: sha256(sqlite) },
      excel: { path: 'release.xlsx', byteSize: excel.length, sha256: sha256(excel) },
    },
    documentation: { schemaPath: 'schema.json', dictionaryPath: 'data-dictionary.json', releaseNotesPath: 'release-notes.md', examplePath: 'examples.json' },
  }));

  return Object.freeze({
    site, data, export: exportSource,
    marker: generation.marker, corpusId: generation.corpusId, deepLink, assetPath, assetBytes,
  });
}
