/**
 * What a release section must actually contain. The section already binds every byte by
 * digest; this proves the *set* of bound bytes is the set the artifacts themselves
 * declare, so "every catalogue / search / Excel / SQLite / NDJSON / public-dataset byte"
 * is checked against the corpus manifest and the dataset bundle rather than asserted in
 * prose. A file the manifest declares and the release does not carry, or a file the
 * release carries and nothing declares, is a mismatch either way.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fail, jsonFile } from './release-artifacts.mjs';
import { inspectNoindex, NOINDEX_ROBOTS } from './release-staging.mjs';

function byPath(section, name) {
  if (!section || !Array.isArray(section.artifacts)) fail(`the ${name} section carries no artifact list`);
  return new Map(section.artifacts.map((artifact) => [artifact.path, artifact]));
}

/** Exact set equality, both directions, with the first divergence named. */
function assertSamePaths(actual, expected, name, label) {
  const missing = [...expected].filter((entry) => !actual.has(entry)).sort();
  const extra = [...actual.keys()].filter((entry) => !expected.has(entry)).sort();
  if (missing.length > 0) fail(`the ${name} section is missing ${String(missing.length)} ${label} file(s) the release must carry: ${missing.slice(0, 3).join(', ')}`);
  if (extra.length > 0) fail(`the ${name} section carries ${String(extra.length)} file(s) nothing declares: ${extra.slice(0, 3).join(', ')}`);
}

/**
 * The staged site is the only section whose published bytes differ from its source, so
 * the coverage check is what proves the transform left every page carrying the noindex
 * directive and replaced the sitemap-pointing robots.txt.
 */
export async function assertSiteCoverage(section, stagedSiteDirectory) {
  const artifacts = byPath(section, 'site');
  if (!artifacts.has('robots.txt')) fail('the site section carries no robots.txt, so the destination is unbound');
  const html = [...artifacts.keys()].filter((entry) => entry.endsWith('.html'));
  if (html.length === 0) fail('the site section carries no HTML page');
  const noindex = await inspectNoindex(stagedSiteDirectory);
  if (noindex.missingMeta.length > 0) fail(`${String(noindex.missingMeta.length)} staged page(s) are indexable: ${noindex.missingMeta.slice(0, 3).join(', ')}`);
  if (!noindex.robotsIsDisallowAll) fail('the staged robots.txt does not disallow every agent');
  const robots = await readFile(path.join(stagedSiteDirectory, 'robots.txt'), 'utf8');
  if (robots !== NOINDEX_ROBOTS) fail('the staged robots.txt is not the snapshot disallow-all file');
  return Object.freeze({ htmlFiles: html.length, noindex: true });
}

/** The corpus manifest enumerates every released corpus byte except itself. */
export async function assertDataCoverage(section, stagedDataDirectory) {
  const artifacts = byPath(section, 'data');
  const manifest = await jsonFile(path.join(stagedDataDirectory, 'manifest.json'), 'corpus manifest');
  if (!Array.isArray(manifest.artifacts)) fail('the corpus manifest enumerates no release artifacts');
  const declared = new Set(['manifest.json']);
  for (const entry of manifest.artifacts) {
    if (typeof entry.path !== 'string' || !Number.isSafeInteger(entry.byteSize) || !/^[a-f0-9]{64}$/u.test(String(entry.sha256))) {
      fail('the corpus manifest has an invalid artifact record');
    }
    declared.add(entry.path);
    const record = artifacts.get(entry.path);
    if (record === undefined) continue;
    if (record.sha256 !== entry.sha256 || record.byteSize !== entry.byteSize) {
      fail(`staged corpus file ${entry.path} does not match the digest the corpus manifest declares`);
    }
  }
  assertSamePaths(artifacts, declared, 'data', 'corpus');
  return Object.freeze({ declaredFiles: declared.size, catalogued: true });
}

/** The dataset bundle declares its formats, documentation and NDJSON shards; all of them ship. */
export async function assertExportCoverage(section, stagedExportDirectory) {
  const artifacts = byPath(section, 'export');
  const manifest = await jsonFile(path.join(stagedExportDirectory, 'public-release.json'), 'published dataset manifest');
  const declared = new Set(['public-release.json']);
  for (const [name, format] of Object.entries(manifest.formats ?? {})) {
    if (typeof format.path !== 'string') fail(`the published dataset declares no ${name} path`);
    if (name !== 'ndjson') {
      declared.add(format.path);
      const record = artifacts.get(format.path);
      if (record === undefined) continue;
      if (record.sha256 !== format.sha256 || record.byteSize !== format.byteSize) fail(`staged ${name} bytes do not match the dataset manifest`);
    }
  }
  const ndjson = manifest.formats?.ndjson;
  if (typeof ndjson?.path !== 'string') fail('the published dataset declares no ndjson directory');
  const shardManifest = await jsonFile(path.join(stagedExportDirectory, ndjson.path, 'public-release.json'), 'published dataset ndjson manifest');
  if (!Array.isArray(shardManifest.files) || shardManifest.files.length === 0) fail('the published dataset lists no ndjson shards');
  declared.add(`${ndjson.path}/public-release.json`);
  for (const shard of shardManifest.files) {
    if (typeof shard.path !== 'string') fail('the ndjson shard manifest has an invalid record');
    declared.add(`${ndjson.path}/${shard.path}`);
    const record = artifacts.get(`${ndjson.path}/${shard.path}`);
    if (record === undefined) continue;
    if (record.sha256 !== shard.sha256 || record.byteSize !== shard.byteSize) fail(`staged ndjson shard ${shard.path} does not match its own record`);
  }
  for (const key of ['schemaPath', 'dictionaryPath', 'releaseNotesPath', 'examplePath']) {
    const value = manifest.documentation?.[key];
    if (typeof value !== 'string') fail(`the published dataset declares no documentation ${key}`);
    declared.add(value);
  }
  assertSamePaths(artifacts, declared, 'export', 'dataset');
  return Object.freeze({ declaredFiles: declared.size, shards: shardManifest.files.length, relations: Object.keys(manifest.relations ?? {}).length });
}
