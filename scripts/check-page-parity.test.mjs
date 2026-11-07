import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, 'check-page-parity.mjs');
const SITE_URL = 'https://example.test';
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** `canonical` is passed in, never hardcoded: the gate compares presence, not origin. */
function page({ preview, canonical }) {
  const robots = preview ? 'noindex, nofollow, noarchive, nosnippet' : 'index, follow';
  const canonicalLink = canonical ? `<link rel="canonical" href="${canonical}"/>` : '';
  const jsonLd = preview ? '' : '<script type="application/ld+json">{"@type":"WebPage"}</script>';
  return '<!doctype html><html><head><title>Example</title>'
    + `<meta name="robots" content="${robots}"/>`
    + '<meta name="description" content="A valid example page"/>'
    + '<link rel="stylesheet" href="/_next/static/css/app.css"/>'
    + canonicalLink + jsonLd
    + '</head><body><main><h1>Example</h1></main></body></html>';
}

function fixture({
  preview = false,
  canonical = preview ? '' : `${SITE_URL}/w/example/`,
  missingIndex = false,
  nonRegularIndex = false,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-page-parity-'));
  directories.push(directory);
  const detail = path.join(directory, 'w');
  for (const tier of ['next', 'lean']) {
    const pageDir = path.join(detail, tier);
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(path.join(pageDir, 'index.html'), page({ preview, canonical }));
    if (tier === 'next') fs.writeFileSync(path.join(pageDir, 'index.txt'), 'next');
  }
  if (missingIndex) fs.mkdirSync(path.join(detail, 'missing-index'));
  if (nonRegularIndex) fs.mkdirSync(path.join(detail, 'non-regular', 'index.html'), { recursive: true });
  return directory;
}

function run(directory, { preview = false, siteUrl = SITE_URL } = {}) {
  return spawnSync(process.execPath, [script, directory], {
    env: {
      ...process.env,
      NEXT_PUBLIC_BUILD_MODE: preview ? 'preview' : 'production',
      NEXT_PUBLIC_SITE_URL: siteUrl,
    },
    encoding: 'utf8',
  });
}

describe('detail page parity build-mode contract', () => {
  it('rejects a detail directory that has no index.html', () => {
    const result = run(fixture({ missingIndex: true }));

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('/w/missing-index/');
    expect(`${result.stdout}\n${result.stderr}`).toContain('index.html');
  });

  it('rejects an index.html entry that is not a regular file', () => {
    const result = run(fixture({ nonRegularIndex: true }));

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('/w/non-regular/');
    expect(`${result.stdout}\n${result.stderr}`).toContain('regular file');
  });

  it('accepts a local build that omits the canonical entirely', () => {
    const result = run(fixture({ canonical: '' }), { siteUrl: '' });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('canonical');
  });

  it('requires exactly one canonical when an origin is configured', () => {
    expect(run(fixture()).status).toBe(0);
  });

  it('rejects a configured page without a canonical', () => {
    const result = run(fixture({ canonical: '' }));

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('canonical');
  });

  it('rejects a no-origin page that still emits a canonical', () => {
    const result = run(fixture(), { siteUrl: '' });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('canonical');
  });

  it('accepts the intentional canonical and JSON-LD omission in preview output', () => {
    expect(run(fixture({ preview: true }), { preview: true }).status).toBe(0);
  });
});
