import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditGeneratedAssets, renderMarkdown } from './check-generated-assets.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-assets-'));
  temporaryDirectories.push(directory);
  return directory;
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('generated asset integrity audit', () => {
  it('accepts a clean export and reports generated assets', () => {
    const root = fixture();
    write(root, 'index.html', '<!doctype html>');
    write(root, 'w/profile-investors-and-send-ai-investment-reports/index.html', 'route');
    write(root, '_next/static/app.js', 'console.log("ok");');
    write(root, 'og/og-generic-LOW.png', 'og');
    write(root, 'favicon.ico', 'icon');
    write(root, '_next/static/media/favicon.abc.ico', 'icon');

    const result = auditGeneratedAssets(root);

    expect(result.ok).toBe(true);
    expect(result.status).toBe('passed');
    expect(result.generatedAssets.og).toHaveLength(1);
    expect(result.generatedAssets.favicon).toHaveLength(2);
    expect(result.unsafeDuplicates).toEqual([]);
    expect(renderMarkdown(result)).toContain('Generated OG assets: 1');
  });

  it('rejects source maps and explicit debug artifacts', () => {
    const root = fixture();
    write(root, '_next/static/chunks/app.js.map', '{}');
    write(root, '_next/static/media/scan.worker.ts', 'export {};');
    write(root, 'debug/coverage.log', 'debug');

    const result = auditGeneratedAssets(root);

    expect(result.ok).toBe(false);
    expect(result.forbiddenArtifacts.map(({ kind, path: file }) => `${kind}:${file}`)).toEqual([
      'debug-artifact:debug/coverage.log',
      'source-file:_next/static/media/scan.worker.ts',
      'source-map:_next/static/chunks/app.js.map',
    ]);
  });

  it('rejects exact duplicate content when it is not a safe framework copy', () => {
    const root = fixture();
    write(root, '_next/static/chunks/one.js', 'same bytes');
    write(root, '_next/static/chunks/two.js', 'same bytes');

    const result = auditGeneratedAssets(root);

    expect(result.ok).toBe(false);
    expect(result.unsafeDuplicates).toHaveLength(1);
    expect(result.unsafeDuplicates[0].paths).toEqual([
      '_next/static/chunks/one.js',
      '_next/static/chunks/two.js',
    ]);
  });

  it('accepts duplicate webpack route wrapper chunks', () => {
    const root = fixture();
    const page = '(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[230],{8802:(e,s,_)=>{Promise.resolve().then(_.t.bind(_,9568,23))}},e=>{e.O(0,[9568],()=>e(e.s=8802)),_N_E=e.O()}]);';
    write(root, '_next/static/chunks/app/about/page-abc123.js', page);
    write(root, '_next/static/chunks/app/privacy/page-abc123.js', page);

    const result = auditGeneratedAssets(root);

    expect(result.ok).toBe(true);
    expect(result.unsafeDuplicates).toEqual([]);
    expect(result.duplicates[0].policy).toBe('Webpack route wrapper chunks');
  });

  it('rejects symlinked artifacts instead of silently skipping them', () => {
    const root = fixture();
    write(root, '_next/static/chunks/app.js', 'bundle');
    const map = path.join(root, '_next/static/chunks/app.js.map');
    try {
      fs.symlinkSync('app.js', map, 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error.code)) return;
      throw error;
    }

    const result = auditGeneratedAssets(root);

    expect(result.ok).toBe(false);
    expect(result.sourceMaps).toEqual([{ path: '_next/static/chunks/app.js.map', kind: 'source-map' }]);
  });

  it('does not trust a route-shaped filename without wrapper content', () => {
    const root = fixture();
    write(root, '_next/static/chunks/app/about/page-abc123.js', 'same route wrapper');
    write(root, '_next/static/chunks/app/privacy/page-abc123.js', 'same route wrapper');

    const result = auditGeneratedAssets(root);

    expect(result.ok).toBe(false);
    expect(result.unsafeDuplicates).toHaveLength(1);
  });

  it('fails closed when the supplied export directory is absent', () => {
    const root = path.join(os.tmpdir(), `missing-generated-assets-${process.pid}`);

    const result = auditGeneratedAssets(root);

    expect(result).toMatchObject({ ok: false, status: 'failed', filesScanned: 0 });
    expect(renderMarkdown(result)).toMatch(/absent|not found/i);
  });
});
