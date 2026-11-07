import { afterEach, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  readReadbackManifest,
  verifyAnonymousReadback,
  writeReadbackManifest,
} from '../pages-release-readback.mjs';
import {
  cleanupReadbackFixtures,
  createFixture,
  publicBytes,
  responder,
} from './pages-release-readback.test-support.mjs';

const PAGE_URL = 'https://owner.github.io/sfscanner/';
const ARCHIVE_SHA256 = 'a'.repeat(64);
afterEach(cleanupReadbackFixtures);

it('manifest generation and parsing bind every expected file to the release digest', async () => {
  const fixture = createFixture();
  const written = await writeReadbackManifest(fixture.source, fixture.manifestPath, ARCHIVE_SHA256);
  expect(written.files).toBe(3);
  expect(written.bytes).toBe(51);
  expect(written.sha256).toMatch(/^[a-f0-9]{64}$/u);
  const manifest = await readReadbackManifest(fixture.manifestPath, ARCHIVE_SHA256);
  expect(manifest.archiveSha256).toBe(ARCHIVE_SHA256);
  expect(manifest.files.map(({ path }) => path)).toEqual(['.nojekyll', 'assets/payload.txt', 'index.html']);
  await expect(
    readReadbackManifest(fixture.manifestPath, 'b'.repeat(64)),
  ).rejects.toThrow(/archive identity mismatch/u);
});

it('anonymous readback verifies exact public bytes with bounded concurrency and redirects', async () => {
  const fixture = createFixture();
  await writeReadbackManifest(fixture.source, fixture.manifestPath, ARCHIVE_SHA256);
  const manifest = await readReadbackManifest(fixture.manifestPath, ARCHIVE_SHA256);
  const bytes = publicBytes(fixture.source);
  let active = 0;
  let maximum = 0;
  const redirects = new Map([['index.html', () => {
    return new Response(null, { status: 302, headers: { location: '/sfscanner/' } });
  }], ['', (url, options) => {
    expect(new URL(url).pathname).toBe('/sfscanner/');
    return new Response(bytes.get('index.html'), { status: 200 });
  }]]);
  const fetchImpl = responder(bytes, redirects);
  const result = await verifyAnonymousReadback({
    pageUrl: PAGE_URL,
    manifest,
    concurrency: 2,
    retryDelay: async () => {},
    fetchImpl: async (url, options) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await fetchImpl(url, options);
      } finally {
        active--;
      }
    },
  });
  expect(result.files).toBe(3);
  expect(result.bytes).toBe(51);
  expect(result.transferredBytes).toBe(51);
  expect(maximum).toBeLessThanOrEqual(2);

  await expect(verifyAnonymousReadback({
    pageUrl: PAGE_URL,
    manifest,
    retryDelay: async () => {},
    fetchImpl: responder(bytes, new Map([
      ['index.html', () => new Response(null, { status: 302, headers: { location: '/other-project/index.html' } })],
    ])),
  })).rejects.toThrow(/redirect outside deployment base path/u);
});

it('anonymous readback retries only bounded transient failures', async () => {
  const fixture = createFixture();
  await writeReadbackManifest(fixture.source, fixture.manifestPath, ARCHIVE_SHA256);
  const manifest = await readReadbackManifest(fixture.manifestPath, ARCHIVE_SHA256);
  const bytes = publicBytes(fixture.source);
  let attempts = 0;
  const transient = new Map([['assets/payload.txt', () => {
    attempts++;
    return attempts === 1
      ? new Response('temporary', { status: 503 })
      : new Response(bytes.get('assets/payload.txt'), { status: 200 });
  }]]);
  const result = await verifyAnonymousReadback({
    pageUrl: PAGE_URL,
    manifest,
    maxAttempts: 2,
    retryDelay: async () => {},
    fetchImpl: responder(bytes, transient),
  });
  expect(result.files).toBe(3);
  expect(attempts).toBe(2);

  let failedAttempts = 0;
  await expect(verifyAnonymousReadback({
    pageUrl: PAGE_URL,
    manifest,
    maxAttempts: 3,
    concurrency: 1,
    retryDelay: async () => {},
    fetchImpl: responder(bytes, new Map([['.nojekyll', () => {
      failedAttempts++;
      return new Response('temporary', { status: 503 });
    }]])),
  })).rejects.toThrow(/attempts exhausted/u);
  expect(failedAttempts).toBe(3);
});

it('anonymous readback rejects wrong bytes, unsafe redirects, and excess bytes', async () => {
  const fixture = createFixture();
  await writeReadbackManifest(fixture.source, fixture.manifestPath, ARCHIVE_SHA256);
  const manifest = await readReadbackManifest(fixture.manifestPath, ARCHIVE_SHA256);
  const bytes = publicBytes(fixture.source);
  const changedIndex = Buffer.from(bytes.get('index.html'));
  changedIndex[0] ^= 0xff;

  await expect(verifyAnonymousReadback({
    pageUrl: PAGE_URL,
    manifest,
    retryDelay: async () => {},
    fetchImpl: responder(new Map(bytes).set('index.html', changedIndex)),
  })).rejects.toThrow(/public bytes mismatch/u);

  await expect(verifyAnonymousReadback({
    pageUrl: PAGE_URL,
    manifest,
    retryDelay: async () => {},
    fetchImpl: responder(new Map(bytes).set('.nojekyll', Buffer.from('unexpected'))),
  })).rejects.toThrow(/public size mismatch/u);

  await expect(verifyAnonymousReadback({
    pageUrl: PAGE_URL,
    manifest,
    maxRedirects: 1,
    retryDelay: async () => {},
    fetchImpl: responder(bytes, new Map([
      ['index.html', () => new Response(null, { status: 302, headers: { location: '/sfscanner/' } })],
      ['', () => new Response(null, { status: 302, headers: { location: '/sfscanner/again' } })],
      ['again', () => new Response(bytes.get('index.html'), { status: 200 })],
    ])),
  })).rejects.toThrow(/redirect limit exceeded/u);

  await expect(verifyAnonymousReadback({
    pageUrl: PAGE_URL,
    manifest,
    retryDelay: async () => {},
    fetchImpl: responder(bytes, new Map([
      ['index.html', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } })],
    ])),
  })).rejects.toThrow(/redirect outside deployment base path/u);

  await expect(verifyAnonymousReadback({
    pageUrl: PAGE_URL,
    manifest,
    maxTransferBytes: 20,
    retryDelay: async () => {},
    fetchImpl: responder(bytes),
  })).rejects.toThrow(/transfer budget exceeded/u);
});

it('charges interrupted attempt bytes before accepting a bounded exact retry', async () => {
  const fixture = createFixture();
  const large = Buffer.alloc(5 * 1024 * 1024, 7);
  const partial = large.subarray(0, 4 * 1024 * 1024 + 1);
  writeFileSync(path.join(fixture.source, 'assets', 'large.bin'), large);
  await writeReadbackManifest(fixture.source, fixture.manifestPath, ARCHIVE_SHA256);
  const manifest = await readReadbackManifest(fixture.manifestPath, ARCHIVE_SHA256);
  const bytes = publicBytes(fixture.source).set('assets/large.bin', large);
  let attempts = 0;
  let partialDelivered = false;
  const interrupted = new ReadableStream({
    pull(controller) {
      if (!partialDelivered) {
        partialDelivered = true;
        controller.enqueue(partial);
      } else controller.error(Object.assign(new Error('simulated reset'), { code: 'ECONNRESET' }));
    },
  });
  const result = await verifyAnonymousReadback({
    pageUrl: PAGE_URL,
    manifest,
    maxAttempts: 2,
    retryDelay: async () => {},
    fetchImpl: responder(bytes, new Map([['assets/large.bin', () => {
      attempts++;
      return attempts === 1
        ? new Response(interrupted, { status: 200 })
        : new Response(large, { status: 200 });
    }]])),
  });
  expect(attempts).toBe(2);
  expect(result.transferredBytes).toBe(manifest.totals.bytes + partial.length);
});

it('accepts only exact archive-bound bytes for a custom 404.html status', async () => {
  const fixture = createFixture();
  const custom404 = Buffer.from('<!doctype html><title>not found</title>\n');
  writeFileSync(path.join(fixture.source, '404.html'), custom404);
  await writeReadbackManifest(fixture.source, fixture.manifestPath, ARCHIVE_SHA256);
  const manifest = await readReadbackManifest(fixture.manifestPath, ARCHIVE_SHA256);
  const bytes = publicBytes(fixture.source).set('404.html', custom404);
  await expect(verifyAnonymousReadback({
    pageUrl: PAGE_URL, manifest, retryDelay: async () => {}, fetchImpl: responder(bytes),
  })).resolves.toMatchObject({ files: 4 });
  await expect(verifyAnonymousReadback({
    pageUrl: PAGE_URL,
    manifest,
    retryDelay: async () => {},
    fetchImpl: responder(bytes, new Map([
      ['404.html', () => new Response(custom404, { status: 404 })],
    ])),
  })).resolves.toMatchObject({ files: 4 });
  const wrong404 = Buffer.from(custom404);
  wrong404[0] ^= 0xff;
  await expect(verifyAnonymousReadback({
    pageUrl: PAGE_URL,
    manifest,
    retryDelay: async () => {},
    fetchImpl: responder(bytes, new Map([
      ['404.html', () => new Response(wrong404, { status: 404 })],
    ])),
  })).rejects.toThrow(/public bytes mismatch for 404\.html/u);
  await expect(verifyAnonymousReadback({
    pageUrl: PAGE_URL,
    manifest,
    retryDelay: async () => {},
    fetchImpl: responder(bytes, new Map([
      ['index.html', () => new Response(bytes.get('index.html'), { status: 404 })],
    ])),
  })).rejects.toThrow(/public HTTP 404 for index\.html/u);
});
