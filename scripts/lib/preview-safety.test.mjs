import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findPreviewSafetyViolations } from './preview-safety.mjs';

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(html, script = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-preview-safety-'));
  directories.push(directory);
  fs.writeFileSync(path.join(directory, 'index.html'), html);
  fs.writeFileSync(path.join(directory, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  if (script) {
    fs.mkdirSync(path.join(directory, '_next', 'static'), { recursive: true });
    fs.writeFileSync(path.join(directory, '_next', 'static', 'app.js'), script);
  }
  return directory;
}

describe('preview output safety gate', () => {
  it('accepts a noindex page with no sitemap or telemetry', () => {
    const directory = fixture('<html><head><meta name="robots" content="noindex, nofollow, noarchive, nosnippet"></head><body></body></html>');

    expect(findPreviewSafetyViolations(directory)).toEqual([]);
  });

  it('rejects sitemap files, incomplete robots, and analytics markers', () => {
    const directory = fixture('<html><head><meta name="robots" content="noindex, nofollow"></head><body></body></html>', 'window.gtag({ measurementId: "G-EXAMPLE" });');
    fs.writeFileSync(path.join(directory, 'sitemap.xml'), 'stale');
    fs.writeFileSync(path.join(directory, 'robots.txt'), 'User-agent: *\nDisallow: /\nSitemap: https://example.invalid/sitemap.xml\n');

    expect(findPreviewSafetyViolations(directory)).toEqual(expect.arrayContaining([
      expect.stringContaining('robots.txt'),
      expect.stringContaining('sitemap.xml'),
      expect.stringContaining('noindex'),
      expect.stringContaining('telemetry marker'),
    ]));
  });

  it('does not treat catalogue content labels as telemetry code', () => {
    const directory = fixture('<html><head><meta name="robots" content="noindex, nofollow, noarchive, nosnippet">'
      + '</head><body><main><h1>Google Analytics and Mixpanel workflows</h1></main></body></html>');

    expect(findPreviewSafetyViolations(directory)).toEqual([]);
  });

  it('rejects HTML artifacts regardless of filename casing when noindex is missing', () => {
    const directory = fixture('<html><head></head><body></body></html>');
    fs.renameSync(path.join(directory, 'index.html'), path.join(directory, 'route.HTML'));

    expect(findPreviewSafetyViolations(directory)).toContain(
      'route.HTML: missing complete preview noindex robots directive',
    );
  });
});
