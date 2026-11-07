import { expect, test, type APIRequestContext } from '@playwright/test';

/** Local harness evidence. GitHub Pages headers require checks against a deployed origin. */
const configuredBasePath = (process.env.PLAYWRIGHT_BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? '')
  .replace(/^\/+|\/+$/g, '');
const basePath = configuredBasePath ? `/${configuredBasePath}` : '';
const sitePath = (path: string) => `${basePath}${path}`;

type ManifestArtifact = {
  path: string;
  byteSize: number;
};

type ExportManifest = {
  artifacts?: Array<{ path?: unknown; byteSize?: unknown }>;
};

async function resolveRangeArtifact(request: APIRequestContext): Promise<ManifestArtifact> {
  const manifestResponse = await request.get(sitePath('/data/manifest.json'));
  expect(manifestResponse.status()).toBe(200);

  const manifest = (await manifestResponse.json()) as ExportManifest;
  const artifact = manifest.artifacts?.find(
    (candidate): candidate is ManifestArtifact =>
      typeof candidate.path === 'string' &&
      /^(charts|previews)\/[^/]+\.jsonl?$/.test(candidate.path) &&
      typeof candidate.byteSize === 'number' &&
      candidate.byteSize >= 32,
  );

  expect(artifact, 'manifest must expose a range-testable chart or preview artifact').toBeDefined();
  if (!artifact) throw new Error('No range-testable chart or preview artifact found in manifest');
  return artifact;
}

test('local harness serves project routes without inventing origin cache policy', async ({ request }) => {
  const htmlResponse = await request.get(sitePath('/'));
  expect(htmlResponse.status()).toBe(200);
  expect(htmlResponse.headers()['content-type']).toBe('text/html; charset=utf-8');
  expect(htmlResponse.headers()['cache-control']).toBeUndefined();

  const manifestResponse = await request.get(sitePath('/data/manifest.json'));
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()['content-type']).toBe('application/json; charset=utf-8');
  expect(manifestResponse.headers()['cache-control']).toBeUndefined();
});

test('local routing serves exported directory pages and returns the exported 404 for missing paths', async ({ request }) => {
  const scannerResponse = await request.get(sitePath('/scanner/'));
  expect(scannerResponse.status()).toBe(200);
  expect(scannerResponse.headers()['content-type']).toBe('text/html; charset=utf-8');

  const missingResponse = await request.get(sitePath('/phase-3-4-missing-route/'));
  expect(missingResponse.status()).toBe(404);
  expect(missingResponse.headers()['content-type']).toBe('text/html; charset=utf-8');

  if (basePath) expect((await request.get('/scanner/')).status()).toBe(404);
});

test('local range harness serves the requested bytes from a committed chart or preview artifact', async ({ request }) => {
  const artifact = await resolveRangeArtifact(request);
  const end = 31;
  const response = await request.get(sitePath(`/data/${artifact.path}`), {
    headers: { Range: `bytes=0-${end}` },
  });

  expect(response.status()).toBe(206);
  expect(response.headers()).toMatchObject({
    'accept-ranges': 'bytes',
    'content-length': String(end + 1),
  });

  const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers()['content-range'] ?? '');
  expect(contentRange).not.toBeNull();
  if (!contentRange) throw new Error('Range response omitted a valid Content-Range header');
  expect(Number(contentRange[1])).toBe(0);
  expect(Number(contentRange[2])).toBe(end);
  expect(Number(contentRange[3])).toBe(artifact.byteSize);
  expect((await response.body()).byteLength).toBe(end + 1);
});

test('local range harness rejects a byte range beyond the artifact', async ({ request }) => {
  const artifact = await resolveRangeArtifact(request);
  const response = await request.get(sitePath(`/data/${artifact.path}`), {
    headers: { Range: `bytes=${artifact.byteSize}-${artifact.byteSize}` },
  });

  expect(response.status()).toBe(416);
  expect(response.ok()).toBe(false);
  expect(response.headers()['content-range']).toBe(`bytes */${artifact.byteSize}`);
  expect((await response.body()).byteLength).toBe(0);
});
