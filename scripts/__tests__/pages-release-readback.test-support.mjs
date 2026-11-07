import { expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporaryRoots = [];

export function cleanupReadbackFixtures() {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
}

export function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pages-release-readback-'));
  temporaryRoots.push(root);
  const source = path.join(root, 'source');
  mkdirSync(path.join(source, 'assets'), { recursive: true });
  writeFileSync(path.join(source, 'index.html'), '<!doctype html><title>public identity</title>\n');
  writeFileSync(path.join(source, '.nojekyll'), '');
  writeFileSync(path.join(source, 'assets', 'payload.txt'), Buffer.from([0, 1, 2, 3, 255]));
  return { root, source, manifestPath: path.join(root, 'readback.json') };
}

export function publicBytes(source) {
  return new Map([
    ['.nojekyll', readFileSync(path.join(source, '.nojekyll'))],
    ['assets/payload.txt', readFileSync(path.join(source, 'assets', 'payload.txt'))],
    ['index.html', readFileSync(path.join(source, 'index.html'))],
  ]);
}

function publicUrl(url) {
  const parsed = new URL(url);
  expect(parsed.origin).toBe('https://owner.github.io');
  expect(parsed.pathname).toMatch(/^\/sfscanner\//u);
  return parsed.pathname.slice('/sfscanner/'.length).split('/').map(decodeURIComponent).join('/');
}

export function responder(bytes, overrides = new Map()) {
  return async (url, options) => {
    expect(options.redirect).toBe('manual');
    expect(options.signal).toBeTruthy();
    expect(new Headers(options.headers).has('authorization')).toBe(false);
    expect(new Headers(options.headers).has('cookie')).toBe(false);
    const relative = publicUrl(url);
    if (overrides.has(relative)) return overrides.get(relative)(url, options);
    const body = bytes.get(relative);
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200 });
  };
}
