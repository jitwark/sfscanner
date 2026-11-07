import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, 'measure-budgets.mjs');
const roots = [];

async function createFixture({ homeHref, libraryHref, assets }) {
  const root = await mkdtemp(join(tmpdir(), 'measure-budgets-'));
  roots.push(root);

  const scripts = join(root, 'scripts');
  const out = join(root, 'app', 'out');
  await mkdir(scripts, { recursive: true });
  await mkdir(join(out, 'library'), { recursive: true });
  await mkdir(join(out, 'data'), { recursive: true });
  await copyFile(SCRIPT, join(scripts, 'measure-budgets.mjs'));

  await writeFile(join(out, 'index.html'), `<link rel="stylesheet" href="${homeHref}">`);
  await writeFile(join(out, 'library', 'index.html'), `<script src="${libraryHref}"></script>`);
  await writeFile(join(out, 'data', 'search-index.json'), '{}');
  await writeFile(join(out, 'data', 'facets.json'), '{}');

  for (const { path, contents } of assets) {
    const file = join(out, path);
    await mkdir(resolve(file, '..'), { recursive: true });
    await writeFile(file, contents);
  }

  return root;
}

function run(root, basePath) {
  const output = join(root, 'snapshot.json');
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'measure-budgets.mjs'), '--out', output],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NEXT_PUBLIC_BASE_PATH: basePath },
    },
  );
  return {
    ...result,
    snapshot: result.status === 0 ? readFile(output, 'utf8') : Promise.resolve(null),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('measureBudgets asset resolution', () => {
  it('resolves base-path-prefixed URLs against the flat Next export', async () => {
    const css = 'body{color:#111}';
    const js = 'console.log("budget")';
    const root = await createFixture({
      homeHref: '/sfscanner/_next/static/css/b34ac3bd40901419.css',
      libraryHref: '/sfscanner/_next/static/chunks/main-app.js',
      assets: [
        { path: '_next/static/css/b34ac3bd40901419.css', contents: css },
        { path: '_next/static/chunks/main-app.js', contents: js },
      ],
    });

    const result = run(root, '/sfscanner');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('ENOENT');
    const snapshot = JSON.parse(await result.snapshot);
    expect(snapshot.routes['/']).toEqual({
      initialGzipBytes: gzipSync(Buffer.from(css)).length,
      assets: 1,
    });
    expect(snapshot.routes['/library/']).toEqual({
      initialGzipBytes: gzipSync(Buffer.from(js)).length,
      assets: 1,
    });
  });

  it('preserves root builds that emit unprefixed URLs', async () => {
    const css = 'body{background:#fff}';
    const root = await createFixture({
      homeHref: '/_next/static/css/root.css',
      libraryHref: '/_next/static/css/root.css',
      assets: [{ path: '_next/static/css/root.css', contents: css }],
    });

    const result = run(root, '');

    expect(result.status, result.stderr).toBe(0);
    const snapshot = JSON.parse(await result.snapshot);
    expect(snapshot.routes['/'].initialGzipBytes).toBe(gzipSync(Buffer.from(css)).length);
  });

  it.each([
    ['an external URL', 'https://cdn.example/_next/static/css/app.css', 'non-local asset reference'],
    ['a protocol-relative URL', '//cdn.example/_next/static/css/app.css', 'non-local asset reference'],
    ['a traversal path', '/sfscanner/_next/../../outside.js', 'escapes app/out'],
    ['a different prefix', '/other/_next/static/css/app.css', 'not under configured base path'],
    [
      'a doubled prefix',
      '/sfscanner/sfscanner/_next/static/css/app.css',
      'does not resolve under /_next',
    ],
  ])('refuses %s', async (_label, href, message) => {
    const root = await createFixture({
      homeHref: href,
      libraryHref: '/sfscanner/_next/static/css/app.css',
      assets: [{ path: '_next/static/css/app.css', contents: 'body{}' }],
    });

    const result = run(root, '/sfscanner');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
});
