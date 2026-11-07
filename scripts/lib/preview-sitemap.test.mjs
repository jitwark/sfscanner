import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writePreviewRobots } from './preview-sitemap.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('writePreviewRobots', () => {
  it('removes stale sitemaps and disallows every preview route', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-preview-sitemap-'));
    temporaryDirectories.push(directory);
    for (const file of ['sitemap.xml', 'sitemap-pages.xml', 'sitemap-workflows-1.xml', 'SITEMAP_INDEX.XML']) {
      fs.writeFileSync(path.join(directory, file), 'stale');
    }
    fs.mkdirSync(path.join(directory, 'public'));
    fs.writeFileSync(path.join(directory, 'public', 'sitemap.xml'), 'nested stale');
    fs.writeFileSync(path.join(directory, 'not-sitemap.xml'), 'keep');

    writePreviewRobots(directory);

    expect(fs.existsSync(path.join(directory, 'sitemap.xml'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'sitemap-pages.xml'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'sitemap-workflows-1.xml'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'SITEMAP_INDEX.XML'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'public', 'sitemap.xml'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'not-sitemap.xml'))).toBe(true);
    expect(fs.readFileSync(path.join(directory, 'robots.txt'), 'utf8')).toBe(
      'User-agent: *\nDisallow: /\n',
    );
  });
});
