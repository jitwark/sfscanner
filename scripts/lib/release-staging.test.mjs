import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyNoindex, inspectNoindex, NOINDEX_META, NOINDEX_ROBOTS, stageSite, stageTree } from './release-staging.mjs';

/**
 * A review snapshot is only noindex if the bytes say so. These cases pin the two ways the
 * built site states its indexability — an existing directive that must be replaced, and no
 * directive at all — plus what `inspectNoindex` refuses to accept afterwards.
 */
let workRoot = '';

async function writeSite(files) {
  const source = await mkdtemp(path.join(workRoot, 'site-'));
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await writeFile(path.join(source, relative), content);
  }
  return source;
}

beforeAll(async () => {
  workRoot = await mkdtemp(path.join(os.tmpdir(), 'release-staging-'));
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe('staging a noindex snapshot', () => {
  it('replaces an existing robots directive instead of shipping both', () => {
    expect(applyNoindex('<head><meta name="robots" content="index, follow"/></head>')).toBe(`<head>${NOINDEX_META}</head>`);
  });

  it('inserts the directive when the document has none', () => {
    expect(applyNoindex('<html><head><title>t</title></head></html>')).toBe(`<html><head>${NOINDEX_META}<title>t</title></head></html>`);
  });

  it('refuses a document with no head to carry the signal', () => {
    expect(() => applyNoindex('<html><body>bare</body></html>')).toThrow(/head element/u);
  });

  it('rewrites the snapshot and leaves non-html bytes untouched', async () => {
    const source = await writeSite({
      'index.html': '<head><meta name="robots" content="index, follow"/></head>',
      'deep/page.html': '<head></head>',
      'robots.txt': 'User-agent: *\nDisallow: /library/?*\n\nSitemap: https://example.test/sitemap.xml\n',
      'app.js': 'globalThis.answer = 42;\n',
    });
    const destination = path.join(workRoot, 'staged');
    await stageSite(source, destination);
    const report = await inspectNoindex(destination);
    expect(report).toMatchObject({ htmlFiles: 2, missingMeta: [], robotsIsDisallowAll: true });
    expect(await readFile(path.join(destination, 'robots.txt'), 'utf8')).toBe(NOINDEX_ROBOTS);
    expect(await readFile(path.join(destination, 'app.js'), 'utf8')).toBe('globalThis.answer = 42;\n');
    expect(await readFile(path.join(source, 'robots.txt'), 'utf8')).toContain('Sitemap:');
    expect(report.meta).toBe(NOINDEX_META);
  });

  it('reports a html file that is not actually noindex', async () => {
    const source = await writeSite({ 'index.html': `<head>${NOINDEX_META}</head>`, 'other.html': '<head><meta name="robots" content="index, follow"/></head>' });
    const destination = path.join(workRoot, 'staged-partial');
    await stageTree(source, destination);
    const report = await inspectNoindex(destination);
    expect(report.missingMeta).toEqual(['other.html']);
  });
});
