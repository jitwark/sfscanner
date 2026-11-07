import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeSection, sha256 } from './release-artifacts.mjs';
import { deriveIdentity, releaseIdFrom, sealIdentity } from './release-identity.mjs';

/**
 * The release identity is what stops a release being assembled from artifacts that
 * describe different things, so these cases are the disagreements it must refuse: a
 * dataset bundle from another corpus generation, a shard whose bytes moved, and a site
 * that does not state where it is going.
 */
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const commit = 'b'.repeat(40);
let workRoot = '';

const CORPUS = { schemaVersion: 'manifest-v1', totalEntries: 2, metadata: { corpusId: 'data', generatedAt: '2026-01-02T03:04:05.000Z', corpusSha256: 'a'.repeat(64), scannerVersion: 'scanner-test-1' } };
const ANALYTICS = { total: 2, rights: { redistributable: 1, linkOnly: 1 } };
const SQLITE = Buffer.from('not a real sqlite file\n');
const SHARDS = Buffer.from('{"relation":"workflows"}\n');
const TREE = { commit: commit.repeat(1), clean: true, dirty: false, dirtyFiles: [] };
const TOOLS = { node: 'v22.0.0', npm: '10.0.0', lockfile: { path: 'package-lock.json', sha256: 'f'.repeat(64), byteSize: 10, lockfileVersion: 3 } };
const INPUTS = { path: 'pipeline/.work/official-bodies-snapshot.json', sha256: 'e'.repeat(64), byteSize: 10, algorithm: 'sha256', inventoryDigest: `sha256:${'d'.repeat(64)}`, fileCount: 2, totalBytes: 20 };
const OPTIONAL = [{ name: 'npm-tarball', package: 'sfscanner', status: 'prepared-only', reason: 'drill' }];

async function writeTree(workRoot, overrides = {}) {
  const dataSource = path.join(workRoot, 'data');
  const exportSource = path.join(workRoot, 'export');
  const siteSource = path.join(workRoot, 'site');
  for (const directory of [dataSource, path.join(exportSource, 'ndjson'), siteSource]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(dataSource, 'manifest.json'), `${JSON.stringify({ ...CORPUS, ...overrides.corpus ?? {} })}\n`);
  await writeFile(path.join(dataSource, 'analytics.json'), `${JSON.stringify({ ...ANALYTICS, ...overrides.analytics ?? {} })}\n`);
  await writeFile(path.join(siteSource, 'robots.txt'), overrides.robots ?? 'User-agent: *\nDisallow: /w/view*\n\nSitemap: https://example.test/sitemap.xml\n');
  await writeFile(path.join(siteSource, 'index.html'), '<html><head><meta name="robots" content="noindex, nofollow"/></head></html>');
  await writeFile(path.join(exportSource, 'schema.json'), `${JSON.stringify({ schemaVersion: 'public-data-model-v1' })}\n`);
  await writeFile(path.join(exportSource, 'release.sqlite'), SQLITE);
  await writeFile(path.join(exportSource, 'public-release.json'), `${JSON.stringify({
    schemaVersion: 'public-data-model-v1',
    releaseId: 'release-2026-01-02',
    relations: { workflows: overrides.workflows ?? 2 },
    formats: {
      ndjson: { path: 'ndjson', files: 1 },
      sqlite: { path: 'release.sqlite', byteSize: SQLITE.length, sha256: sha256(SQLITE) },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(exportSource, 'ndjson', 'workflows.ndjson'), SHARDS);
  await writeFile(path.join(exportSource, 'ndjson', 'public-release.json'), `${JSON.stringify({
    schemaVersion: 'public-data-model-v1',
    releaseId: overrides.shardReleaseId ?? 'release-2026-01-02',
    files: [{ relation: 'workflows', path: 'workflows.ndjson', byteSize: SHARDS.length, sha256: overrides.shardSha256 ?? sha256(SHARDS), rowCount: overrides.shardRowCount ?? 2 }],
  }, null, 2)}\n`);
  return { dataSource, exportSource, siteSource };
}

async function deriveWithSections(overrides = {}) {
  const sources = await writeTree(workRoot, overrides);
  const sections = {
    site: await describeSection(sources.siteSource, 'fixture-artifact-v1'),
    data: await describeSection(sources.dataSource, 'fixture-artifact-v1'),
    export: await describeSection(sources.exportSource, 'fixture-artifact-v1'),
  };
  const identity = await deriveIdentity({
    repoRoot, ...sources, sections, tree: TREE, tools: TOOLS, inputs: INPUTS, optionalArtifacts: OPTIONAL,
    noindex: { meta: '<meta name="robots" content="noindex, nofollow"/>', htmlFiles: 1, robotsIsDisallowAll: true },
  });
  return { identity, sections };
}

async function derive(overrides = {}) {
  return (await deriveWithSections(overrides)).identity;
}

beforeAll(async () => {
  workRoot = await mkdtemp(path.join(os.tmpdir(), 'release-identity-'));
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe('release identity', () => {
  it('derives the corpus, rights and destination facts the release record binds', async () => {
    const { identity, sections } = await deriveWithSections();
    expect(identity.corpus).toMatchObject({ manifestSchemaVersion: 'manifest-v1', totalEntries: 2, corpusId: 'data', generatedAt: '2026-01-02T03:04:05.000Z' });
    expect(identity.corpus.corpusSha256).toBe('a'.repeat(64));
    expect(identity.scanner).toEqual({ version: 'scanner-beta-1', corpusScanVersion: 'scanner-test-1' });
    expect(identity.rights).toMatchObject({ redistributable: 1, linkOnly: 1, total: 2 });
    expect(identity.rights.note).toContain('1 redistributable');
    expect(identity.destination).toMatchObject({ siteUrl: 'https://example.test', provider: 'firebase-hosting', publicDirectory: 'app/out' });
    expect(identity.destination.edgeRobotsHeader).toBe('index, follow');
    expect(identity.tree).toMatchObject({ commit, clean: true });
    expect(identity.tools).toEqual(TOOLS);
    expect(identity.inputs).toEqual(INPUTS);
    expect(identity.optionalArtifacts).toEqual(OPTIONAL);
    expect(identity.artifacts).toMatchObject([
      { name: 'site', provenance: 'next-static-export', rightsScope: 'published-site-pages', rollbackUnit: 'site+data+export', artifactCount: expect.any(Number), byteSize: expect.any(Number) },
      { name: 'data', provenance: 'corpus-regeneration-output', rightsScope: 'public-catalogue-and-search-metadata' },
      { name: 'export', provenance: 'public-dataset-projection', rightsScope: 'redistributable-only-projection' },
    ]);
    expect(identity.artifacts.map((entry) => entry.sha256)).toEqual([sections.site.sha256, sections.data.sha256, sections.export.sha256]);
    expect(identity.artifacts[0].artifactCount).toBe(sections.site.artifacts.length);
    expect(releaseIdFrom(sealIdentity(identity, { site: '1'.repeat(64), data: '2'.repeat(64), export: '3'.repeat(64) }))).toMatch(/^release-2026-01-02-[0-9a-f]{12}$/u);
  });

  it('refuses a dataset bundle that describes a different corpus generation', async () => {
    await expect(derive({ workflows: 11 })).rejects.toThrow(/describes 11 workflows but the corpus holds 2/u);
  });

  it('refuses a shard whose bytes no longer match their own record', async () => {
    await expect(derive({ shardSha256: 'c'.repeat(64) })).rejects.toThrow(/ndjson shard does not match its own record/u);
  });

  it('refuses a rights split that does not add up to the catalogue total', async () => {
    await expect(derive({ analytics: { rights: { redistributable: 1, linkOnly: 2 } } })).rejects.toThrow(/rights split does not add up/u);
  });

  it('refuses a site that does not declare where it is published', async () => {
    await expect(derive({ robots: 'User-agent: *\nDisallow: /\n' })).rejects.toThrow(/destination is unknown/u);
  });

  it('changes the release ID when a released section changes and is stable otherwise', async () => {
    const identity = sealIdentity(await derive(), { site: '1'.repeat(64), data: '2'.repeat(64), export: '3'.repeat(64) });
    const same = sealIdentity(await derive(), { site: '1'.repeat(64), data: '2'.repeat(64), export: '3'.repeat(64) });
    const moved = sealIdentity(identity, { site: '1'.repeat(64), data: '2'.repeat(64), export: '4'.repeat(64) });
    expect(releaseIdFrom(same)).toBe(releaseIdFrom(identity));
    expect(releaseIdFrom(moved)).not.toBe(releaseIdFrom(identity));
  });
});
