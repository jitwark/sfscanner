import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluate, resolveDatasetDir, resolveSourceDataDir } from './check-web-release-parity.mjs';

const gateScript = fileURLToPath(new URL('./check-web-release-parity.mjs', import.meta.url));
const SITE_URL = 'https://owner.github.io/repo';
const temporary = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">';

/**
 * A minimal but complete release-shaped export: one page, one hashed asset, a
 * robots file and a sitemap that both name the configured origin.
 */
function releaseExport({ pageHtml, robots, sitemap } = {}) {
  const out = mkdtempSync(join(tmpdir(), 'hub-parity-'));
  temporary.push(out);
  mkdirSync(join(out, '_next', 'static'), { recursive: true });
  writeFileSync(join(out, '_next', 'static', 'a.js'), '');
  mkdirSync(join(out, 'data'), { recursive: true });
  writeFileSync(join(out, 'data', 'facets.json'), '{"facets":[]}');
  writeFileSync(join(out, 'data', 'manifest.json'), JSON.stringify({ artifacts: [{ path: 'facets.json', byteSize: 13 }] }));
  writeFileSync(join(out, 'index.html'), pageHtml ?? `<!doctype html><html><head><title>Home</title><link rel="canonical" href="${SITE_URL}/"/><meta property="og:url" content="${SITE_URL}/"/>${CSP}</head><body><script src="/repo/_next/static/a.js"></script></body></html>`);
  writeFileSync(join(out, 'robots.txt'), robots ?? `User-agent: *\nDisallow: /repo/library/?*\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  writeFileSync(join(out, 'sitemap.xml'), sitemap ?? `<?xml version="1.0"?><urlset><url><loc>${SITE_URL}/</loc></url></urlset>`);
  return out;
}

const violationsOf = (out) => evaluate({ outDir: out, siteUrl: SITE_URL, basePath: '/repo' }).violations.join('\n');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function temporaryDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

/** A dataset bundle dir; omit `bundle` to leave `public-release.json` absent. */
function datasetDirOf(bundle) {
  const dir = temporaryDir('hub-dataset-');
  if (bundle !== undefined) writeFileSync(join(dir, 'public-release.json'), bundle);
  return dir;
}

/** A source corpus dir holding the `manifest.json` that a bundle digest names. */
function sourceCorpus(manifestText) {
  const dir = temporaryDir('hub-source-');
  writeFileSync(join(dir, 'manifest.json'), manifestText);
  return dir;
}

/** An export whose shipped manifest was restamped, its bundle, and the corpus it names. */
function datasetFixture({ source, siteManifest, bundle }) {
  const outDir = releaseExport();
  writeFileSync(join(outDir, 'data', 'manifest.json'), siteManifest);
  return { outDir, datasetDir: datasetDirOf(bundle), sourceDataDir: sourceCorpus(source) };
}

const datasetViolationsOf = (fixture) => evaluate({ siteUrl: SITE_URL, basePath: '/repo', ...fixture }).violations.join('\n');
const datasetBundle = (source, workflows, sourceManifestSha256 = sha256(source)) =>
  JSON.stringify({ releaseId: 'dataset-rel-1', sourceManifestSha256, relations: { workflows } });

describe('web release parity gate', () => {
  it('accepts a clean release export', () => {
    expect(violationsOf(releaseExport())).toBe('');
  });

  it('rejects the dead origin in any emitted document', () => {
    const out = releaseExport({ pageHtml: `<!doctype html><html><head>${CSP}<link rel="canonical" href="https://owner.github.io/repo/"/></head><body><a href="https://n8n-community.com/x/">x</a></body></html>` });
    expect(violationsOf(out)).toMatch(/dead origin/);
  });

  it('rejects the private repository link and its label', () => {
    const out = releaseExport({ pageHtml: `<!doctype html><html><head>${CSP}<link rel="canonical" href="${SITE_URL}/"/></head><body><a href="https://github.com/jitwark/n8n-community">GitHub (private)</a></body></html>` });
    expect(violationsOf(out)).toMatch(/private repository link/);
    expect(violationsOf(out)).toMatch(/private label/);
  });

  it('rejects a canonical or structured URL that leaves the origin', () => {
    const out = releaseExport({ pageHtml: `<!doctype html><html><head>${CSP}<link rel="canonical" href="https://elsewhere.test/"/><script type="application/ld+json">{"url":"https://elsewhere.test/x"}</script></head><body></body></html>` });
    expect(violationsOf(out)).toMatch(/canonical https:\/\/elsewhere\.test\//);
    expect(violationsOf(out)).toMatch(/structured URL https:\/\/elsewhere\.test\/x/);
  });

  it('rejects canonical and structured URLs that are only prefix siblings of the base path', () => {
    const out = releaseExport({ pageHtml: `<!doctype html><html><head>${CSP}<link rel="canonical" href="https://owner.github.io/repository/"/><script type="application/ld+json">{"url":"https://owner.github.io/repo-evil"}</script></head><body></body></html>` });
    expect(violationsOf(out)).toMatch(/canonical https:\/\/owner\.github\.io\/repository\//);
    expect(violationsOf(out)).toMatch(/structured URL https:\/\/owner\.github\.io\/repo-evil/);
  });

  it('accepts the exact base path and its slash-boundary descendants', () => {
    const out = releaseExport({ pageHtml: `<!doctype html><html><head>${CSP}<link rel="canonical" href="${SITE_URL}/library/"/><meta property="og:url" content="${SITE_URL}/w/slug/"/></head><body></body></html>` });
    expect(violationsOf(out)).toBe('');
  });

  it('accepts same-origin URLs for a root deployment', () => {
    const root = 'https://owner.github.io';
    const out = releaseExport({
      pageHtml: `<!doctype html><html><head>${CSP}<link rel="canonical" href="${root}/library/"/></head><body></body></html>`,
      robots: `User-agent: *\nSitemap: ${root}/sitemap.xml\n`,
      sitemap: `<?xml version="1.0"?><urlset><url><loc>${root}/library/</loc></url></urlset>`,
    });
    expect(evaluate({ outDir: out, siteUrl: root, basePath: '' }).violations.join('\n')).toBe('');
  });

  it('treats a trailing-slash site URL the same way', () => {
    const out = releaseExport({ pageHtml: `<!doctype html><html><head>${CSP}<link rel="canonical" href="${SITE_URL}/library/"/><script type="application/ld+json">{"url":"https://owner.github.io/repo-evil"}</script></head><body></body></html>` });
    const violations = evaluate({ outDir: out, siteUrl: `${SITE_URL}/`, basePath: '/repo' }).violations.join('\n');
    expect(violations).not.toMatch(/canonical/);
    expect(violations).toMatch(/structured URL https:\/\/owner\.github\.io\/repo-evil/);
  });

  it('rejects a root-relative asset that lost the base path', () => {
    const out = releaseExport({ pageHtml: `<!doctype html><html><head>${CSP}<link rel="canonical" href="${SITE_URL}/"/></head><body><script src="/_next/static/a.js"></script></body></html>` });
    expect(violationsOf(out)).toMatch(/base path \/_next\/static\/a\.js/);
  });

  it('rejects a prefixed asset that does not exist on disk', () => {
    const out = releaseExport({ pageHtml: `<!doctype html><html><head>${CSP}<link rel="canonical" href="${SITE_URL}/"/></head><body><script src="/repo/_next/static/missing.js"></script></body></html>` });
    expect(violationsOf(out)).toMatch(/missing asset \/repo\/_next\/static\/missing\.js/);
  });

  it('rejects a page without a content security policy', () => {
    const out = releaseExport({ pageHtml: `<!doctype html><html><head><link rel="canonical" href="${SITE_URL}/"/></head><body></body></html>` });
    expect(violationsOf(out)).toMatch(/CSP missing/);
  });

  it('requires robots and a sitemap that name the configured origin', () => {
    const out = releaseExport({
      robots: 'User-agent: *\nSitemap: https://elsewhere.test/sitemap.xml\n',
      sitemap: '<?xml version="1.0"?><urlset><url><loc>https://elsewhere.test/</loc></url></urlset>',
    });
    expect(violationsOf(out)).toMatch(/robots Sitemap origin mismatch/);
    expect(violationsOf(out)).toMatch(/sitemap origin mismatch/);
  });

  it('rejects a manifest artifact that the export does not contain', () => {
    const out = releaseExport();
    writeFileSync(join(out, 'data', 'manifest.json'), JSON.stringify({
      artifacts: [
        { path: 'facets.json', byteSize: 13 },
        { path: 'scanner/v2-scan-evidence.ndjson', byteSize: 1 },
      ],
    }));
    expect(violationsOf(out)).toMatch(/declared artifact missing from out\/data: scanner\/v2-scan-evidence\.ndjson/);
  });

  it('rejects a manifest artifact path that escapes the export data directory', () => {
    const out = releaseExport();
    writeFileSync(join(out, 'data', 'manifest.json'), JSON.stringify({ artifacts: [{ path: '../index.html' }] }));
    expect(violationsOf(out)).toMatch(/escapes out\/data/);
  });

  it('reports a missing robots file and sitemap instead of passing quietly', () => {
    const out = releaseExport();
    rmSync(join(out, 'robots.txt'));
    rmSync(join(out, 'sitemap.xml'));
    expect(violationsOf(out)).toMatch(/robots\.txt missing/);
    expect(violationsOf(out)).toMatch(/sitemap\.xml missing/);
  });

  it('compares the bundle digest against the source manifest, not the restamped export copy', () => {
    const source = JSON.stringify({ totalEntries: 42 });
    const fixture = datasetFixture({ source, siteManifest: JSON.stringify({ totalEntries: 42, artifacts: [{ path: 'facets.json' }], pruned: true }), bundle: datasetBundle(source, 42) });
    expect(datasetViolationsOf(fixture)).toBe('');
  });
  it('skips dataset cross-check when datasetDir is null (website-only check)', () => {
    expect(evaluate({ outDir: releaseExport(), siteUrl: SITE_URL, basePath: '/repo', datasetDir: null }).violations).toEqual([]);
  });
  it('reports violation when datasetDir is provided but public-release.json is absent', () => {
    expect(datasetViolationsOf({ outDir: releaseExport(), datasetDir: datasetDirOf() })).toMatch(/dataset manifest missing/);
  });
  it('reports violation on source-manifest SHA mismatch between site and dataset', () => {
    const source = JSON.stringify({ totalEntries: 1 });
    const fixture = datasetFixture({ source, siteManifest: JSON.stringify({ totalEntries: 1, artifacts: [{ path: 'facets.json' }] }), bundle: datasetBundle(source, 1, '0'.repeat(64)) });
    expect(datasetViolationsOf(fixture)).toMatch(/source-manifest SHA mismatch/);
  });
  it('reports violation when the configured source data dir has no manifest.json', () => {
    const source = JSON.stringify({ totalEntries: 1 });
    const fixture = datasetFixture({ source, siteManifest: JSON.stringify({ totalEntries: 1 }), bundle: datasetBundle(source, 1) });
    expect(datasetViolationsOf({ ...fixture, sourceDataDir: temporaryDir('hub-source-empty-') })).toMatch(/source manifest missing or unreadable/);
  });
  it('reports violation on workflow count mismatch between site and dataset', () => {
    const source = JSON.stringify({ totalEntries: 100 });
    const fixture = datasetFixture({ source, siteManifest: JSON.stringify({ totalEntries: 100 }), bundle: datasetBundle(source, 99) });
    expect(datasetViolationsOf(fixture)).toMatch(/workflow count mismatch/);
  });
  it('reports violation on missing, negative, non-integer or string workflow count', () => {
    const source = JSON.stringify({ totalEntries: 4.5 });
    const fixture = datasetFixture({ source, siteManifest: JSON.stringify({ totalEntries: 4.5 }), bundle: datasetBundle(source, 4.5) });
    expect(datasetViolationsOf(fixture)).toMatch(/workflow count missing, negative or non-integer/);
  });
  it('reports violation on unreadable or malformed dataset JSON', () => {
    expect(datasetViolationsOf({ outDir: releaseExport(), datasetDir: datasetDirOf('not valid json {{{') })).toMatch(/dataset public-release\.json unreadable or malformed/);
  });
  it('reports violation when dataset bundle is present but lacks sourceManifestSha256', () => {
    expect(datasetViolationsOf({ outDir: releaseExport(), datasetDir: datasetDirOf(JSON.stringify({ releaseId: 'dataset-rel-1', relations: { workflows: 1 } })) })).toMatch(/source-manifest SHA missing or malformed/);
  });
});

describe('web release parity CLI & precedence', () => {
  it('enforces explicit CLI flag precedence over DATASET_BUNDLE_DIR', () => {
    expect(resolveDatasetDir(['--dataset-dir', 'cli-dir'], { DATASET_BUNDLE_DIR: 'env-dir' })).toBe('cli-dir');
    expect(resolveDatasetDir(['--dataset-dir', 'cli-dir'], { DATASET_BUNDLE_DIR: '' })).toBe('cli-dir');
    expect(resolveDatasetDir([], { DATASET_BUNDLE_DIR: 'env-dir' })).toBe('env-dir');
    expect(resolveDatasetDir([], { DATASET_BUNDLE_DIR: '   ' })).toBeNull();
    expect(resolveDatasetDir([], {})).toBeNull();
  });
  it('defaults the source data dir to data and honors --source-data-dir', () => {
    expect(resolveSourceDataDir([])).toBe('data');
    expect(resolveSourceDataDir(['--source-data-dir', 'corpus'])).toBe('corpus');
  });
  it('fails closed when release gate runs without NEXT_PUBLIC_SITE_URL', () => {
    const result = spawnSync(process.execPath, [gateScript], { env: { ...process.env, NEXT_PUBLIC_SITE_URL: '', NEXT_PUBLIC_BASE_PATH: '' }, encoding: 'utf8' });
    expect(result.status).toBe(1); expect(`${result.stdout}${result.stderr}`).toContain('NEXT_PUBLIC_SITE_URL');
  });
  it('refuses an origin whose path disagrees with the configured base path', () => {
    const result = spawnSync(process.execPath, [gateScript], { env: { ...process.env, NEXT_PUBLIC_SITE_URL: 'https://owner.github.io/other', NEXT_PUBLIC_BASE_PATH: '/repo' }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('does not match NEXT_PUBLIC_BASE_PATH');
  });
  it('fails closed when explicit --dataset-dir is absent even if DATASET_BUNDLE_DIR is empty', () => {
    const out = releaseExport();
    const result = spawnSync(process.execPath, [gateScript, '--out-dir', out, '--dataset-dir', 'nonexistent-dir-xyz'], { env: { ...process.env, NEXT_PUBLIC_SITE_URL: SITE_URL, NEXT_PUBLIC_BASE_PATH: '/repo', DATASET_BUNDLE_DIR: '' }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('dataset directory does not exist');
  });
  it('refuses when --dataset-dir points to an empty dir missing public-release.json', () => {
    const out = releaseExport();
    const emptyDatasetDir = mkdtempSync(join(tmpdir(), 'hub-dataset-cli-')); temporary.push(emptyDatasetDir);
    const result = spawnSync(process.execPath, [gateScript, '--out-dir', out, '--dataset-dir', emptyDatasetDir], { env: { ...process.env, NEXT_PUBLIC_SITE_URL: SITE_URL, NEXT_PUBLIC_BASE_PATH: '/repo' }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('dataset manifest missing');
  });
  it('succeeds on website-only check when --dataset-dir is omitted', () => {
    const out = releaseExport();
    const result = spawnSync(process.execPath, [gateScript, '--out-dir', out], { env: { ...process.env, NEXT_PUBLIC_SITE_URL: SITE_URL, NEXT_PUBLIC_BASE_PATH: '/repo' }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('web release parity');
  });
});
