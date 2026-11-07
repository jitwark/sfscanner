import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, '../app/qa/check-seo.mjs');
const SITE_URL = 'https://example.test';
const HUB_PREFIXES = ['integrations/slack', 'tags/ai', 'triggers/webhook', 'grades/ai-ready', 'complexity/simple'];
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function run(mode, directory, env = {}) {
  return spawnSync(process.execPath, [script, directory], {
    // An ambient origin must never leak into a case: every case states its mode.
    env: { ...process.env, NEXT_PUBLIC_BUILD_MODE: mode, NEXT_PUBLIC_SITE_URL: '', ...env },
    encoding: 'utf8',
  });
}

const DESCRIPTION = 'A descriptive sentence long enough for a search snippet and short enough to fit.';

function page({ title, description = DESCRIPTION, robots = 'index, follow', canonical, jsonLd }) {
  return '<!doctype html><html><head>'
    + `<title>${title}</title>`
    + `<meta name="description" content="${description}"/>`
    + `<meta name="robots" content="${robots}"/>`
    + '<link rel="stylesheet" href="/_next/static/css/app.css"/>'
    + (canonical ? `<link rel="canonical" href="${canonical}"/>` : '')
    + (jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : '')
    + '</head><body><main><h1>Page</h1></main></body></html>';
}

/**
 * A real two-tier export: the home page plus one page per hub prefix, each with
 * the metadata the audit measures. `configured` writes the origin-bearing
 * fields; `hubUrl` lets a no-origin export opt into the violation under test.
 */
function fixtureExport({ configured = false, hubUrl = configured } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-seo-export-'));
  temporaryDirectories.push(directory);
  const emit = (relative, html) => {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
  };
  emit('index.html', page({
    title: 'n8n-secureflow',
    canonical: configured ? `${SITE_URL}/` : undefined,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebSite',
          name: 'n8n-secureflow',
          ...(configured ? { url: `${SITE_URL}/`, potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${SITE_URL}/library/?q={q}` } } } : {}),
        },
        { '@type': 'Organization', name: 'n8n-secureflow', ...(configured ? { url: `${SITE_URL}/` } : {}) },
      ],
    },
  }));
  for (const prefix of HUB_PREFIXES) {
    emit(`${prefix}/index.html`, page({
      title: `${prefix} workflows`,
      canonical: configured ? `${SITE_URL}/${prefix}/` : undefined,
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [{
          '@type': 'CollectionPage',
          name: `${prefix} n8n Workflows`,
          description: `Collection of n8n workflow templates for ${prefix}.`,
          ...(hubUrl ? { url: `${SITE_URL}/${prefix}/` } : {}),
        }],
      },
    }));
  }
  return directory;
}

describe('check-seo sitemap requirement', () => {
  it('accepts preview with no origin', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-seo-preview-'));
    temporaryDirectories.push(directory);

    const preview = run('preview', directory);

    expect(preview.status).toBe(0);
    expect(preview.stderr).not.toContain('sitemap.xml missing');
  });

  it('accepts a production local build with no origin when pages omit site URLs', () => {
    const result = run('production', fixtureExport());

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('missing canonical');
    expect(`${result.stdout}${result.stderr}`).not.toContain('CollectionPage missing url');
  });

  it('requires a sitemap for a configured production build', () => {
    const result = run('production', fixtureExport({ configured: true }), { NEXT_PUBLIC_SITE_URL: SITE_URL });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('sitemap.xml missing in output directory');
    expect(result.stderr).not.toContain('missing canonical');
  });

  it('rejects a no-origin page that emits a canonical', () => {
    const result = run('production', fixtureExport({ configured: true }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('canonical must be omitted');
  });

  it('rejects a configured page without a canonical', () => {
    const result = run('production', fixtureExport(), { NEXT_PUBLIC_SITE_URL: SITE_URL });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing canonical');
  });

  it('rejects a no-origin hub page that emits a CollectionPage url', () => {
    const result = run('production', fixtureExport({ configured: false, hubUrl: true }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be omitted without NEXT_PUBLIC_SITE_URL');
  });

  it('requires the complete preview robots directive on every HTML page', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-seo-robots-'));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, 'index.html'), page({ title: 'Preview', robots: 'noindex, nofollow' }));

    const preview = run('preview', directory);

    expect(preview.status).toBe(1);
    expect(preview.stderr).toContain('robots directive');
  });

  it('accepts the complete preview robots directive on a valid HTML page', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-seo-valid-preview-'));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, 'index.html'), page({
      title: 'Preview',
      robots: 'noindex, nofollow, noarchive, nosnippet',
    }));

    const preview = run('preview', directory);

    expect(preview.status).toBe(0);
    expect(preview.stderr).not.toContain('preview robots directive');
  });

  it('rejects canonical and JSON-LD metadata in preview output', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-seo-preview-metadata-'));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, 'index.html'), page({
      title: 'Preview',
      robots: 'noindex, nofollow, noarchive, nosnippet',
      canonical: `${SITE_URL}/`,
      jsonLd: { '@type': 'WebPage' },
    })
      .replace('</head>', '<meta property="og:url" content="https://example.test/"/>'
        + '<meta property="og:image" content="https://example.test/og.png"/>'
        + '<meta name="twitter:image" content="https://example.test/og.png"/></head>'));

    const preview = run('preview', directory);

    expect(preview.status).toBe(1);
    expect(preview.stderr).toContain('canonical');
    expect(preview.stderr).toContain('Open Graph');
    expect(preview.stderr).toContain('Twitter image');
    expect(preview.stderr).toContain('JSON-LD');
  });
});
