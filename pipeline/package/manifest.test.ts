import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest, type ManifestArtifactSource } from './manifest.js';
import { SCANNER_SIDECAR_PATHS } from './scanner-sidecars.js';
import type { WrittenArtifactInfo } from './write-artifacts.js';

const TEST_DIR = path.join(process.cwd(), 'pipeline', '.work', 'test-manifest-temp');
const GENERATED_AT = '2026-08-13T12:00:00.000Z';

/**
 * Most fixtures here build a manifest for a scratch directory, not a release tree,
 * so they declare no scanner sidecars — by name, because a release manifest is
 * required to declare them and would otherwise fail. Release ownership of the
 * declared sidecars is covered by the tests at the end of this describe block.
 */
function buildScratchManifest(dir: string, infos: ManifestArtifactSource[], generatedAt: string) {
  return buildManifest(dir, infos, generatedAt, undefined, { scannerSidecars: 'optional' });
}

/** Stage every declared sidecar, as `data/` ships them, with distinct bytes per path. */
function stageDeclaredSidecars(dir: string): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const relativePath of SCANNER_SIDECAR_PATHS) {
    const body = `${JSON.stringify({ path: relativePath })}\n`;
    fs.mkdirSync(path.dirname(path.join(dir, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(dir, relativePath), body, 'utf8');
    bodies.set(relativePath, body);
  }
  return bodies;
}

describe('manifest', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('builds manifest from files on disk and hashes exact bytes', () => {
    const dummyFile1 = path.join(TEST_DIR, 'catalogue-0.json');
    const dummyFile2 = path.join(TEST_DIR, 'search-index.json');

    const content1 = JSON.stringify([{ id: '1' }]);
    const content2 = '{"index":"dummy"}';

    fs.writeFileSync(dummyFile1, content1, 'utf8');
    fs.writeFileSync(dummyFile2, content2, 'utf8');

    const infos: WrittenArtifactInfo[] = [
      { relativePath: 'catalogue-0.json', absolutePath: dummyFile1, entryCount: 1, entryRange: [0, 0] },
      { relativePath: 'search-index.json', absolutePath: dummyFile2, entryCount: 1 },
    ];

    const timestamp = '2026-08-13T12:00:00.000Z';
    const { manifest, manifestSha256 } = buildScratchManifest(TEST_DIR, infos, timestamp);

    expect(manifest.generatedAt).toBe(timestamp);
    expect(manifest.totalEntries).toBe(1);
    expect(manifest.artifacts.length).toBe(2);

    for (const art of manifest.artifacts) {
      const filePath = path.join(TEST_DIR, art.path);
      expect(fs.existsSync(filePath)).toBe(true);

      const actualBytes = fs.readFileSync(filePath);
      const expectedSha256 = crypto.createHash('sha256').update(actualBytes).digest('hex');

      expect(art.sha256).toBe(expectedSha256);
      expect(art.byteSize).toBe(actualBytes.length);
    }

    const manifestOnDisk = path.join(TEST_DIR, 'manifest.json');
    expect(fs.existsSync(manifestOnDisk)).toBe(true);

    const manifestBuf = fs.readFileSync(manifestOnDisk);
    const expectedManifestSha256 = crypto.createHash('sha256').update(manifestBuf).digest('hex');
    expect(manifestSha256).toBe(expectedManifestSha256);
  });

  it('indexes every catalogue entry to the shard containing it', () => {
    const shard0 = path.join(TEST_DIR, 'catalogue-0.json');
    const shard1 = path.join(TEST_DIR, 'catalogue-1.json');
    fs.writeFileSync(shard0, JSON.stringify([{ id: 'zz-workflow' }]), 'utf8');
    fs.writeFileSync(shard1, JSON.stringify([{ id: '0001-workflow' }]), 'utf8');

    const { manifest } = buildScratchManifest(TEST_DIR, [
      { relativePath: 'catalogue-0.json', absolutePath: shard0, entryCount: 1 },
      { relativePath: 'catalogue-1.json', absolutePath: shard1, entryCount: 1 },
    ], GENERATED_AT);

    expect(manifest.catalogueShards).toEqual({
      'zz-workflow': 0,
      '0001-workflow': 1,
    });
  });

  it('rejects duplicate IDs across catalogue shards', () => {
    const shard0 = path.join(TEST_DIR, 'catalogue-0.json');
    const shard1 = path.join(TEST_DIR, 'catalogue-1.json');
    fs.writeFileSync(shard0, JSON.stringify([{ id: 'duplicate' }]), 'utf8');
    fs.writeFileSync(shard1, JSON.stringify([{ id: 'duplicate' }]), 'utf8');

    expect(() => buildScratchManifest(TEST_DIR, [
      { relativePath: 'catalogue-0.json', absolutePath: shard0, entryCount: 1 },
      { relativePath: 'catalogue-1.json', absolutePath: shard1, entryCount: 1 },
    ], GENERATED_AT)).toThrow(/duplicate.*duplicate/i);
  });

  it('rejects malformed catalogue entries', () => {
    const shard = path.join(TEST_DIR, 'catalogue-0.json');
    fs.writeFileSync(shard, JSON.stringify([{ title: 'missing id' }]), 'utf8');

    expect(() => buildScratchManifest(TEST_DIR, [
      { relativePath: 'catalogue-0.json', absolutePath: shard, entryCount: 1 },
    ], GENERATED_AT)).toThrow(/malformed.*id/i);
  });

  it('serializes artifact metadata in locale-independent path order', () => {
    const first = path.join(TEST_DIR, 'z.json');
    const second = path.join(TEST_DIR, 'a.json');
    fs.writeFileSync(first, '{}', 'utf8');
    fs.writeFileSync(second, '{}', 'utf8');

    const { manifest } = buildScratchManifest(TEST_DIR, [
      { relativePath: 'z.json', absolutePath: first, entryCount: 0 },
      { relativePath: 'a.json', absolutePath: second, entryCount: 0 },
    ], GENERATED_AT);

    expect(manifest.artifacts.map((artifact) => artifact.path)).toEqual(['a.json', 'z.json']);
  });

  it('owns every declared scanner sidecar with the size and hash measured from disk', () => {
    const shard = path.join(TEST_DIR, 'catalogue-0.json');
    const index = path.join(TEST_DIR, 'search-index.json');
    fs.writeFileSync(shard, JSON.stringify([{ id: 'workflow-1' }]), 'utf8');
    fs.writeFileSync(index, '{"documentCount":0}', 'utf8');
    const sidecarBodies = stageDeclaredSidecars(TEST_DIR);

    // No policy argument: a release manifest requires the declared sidecars.
    const { manifest } = buildManifest(TEST_DIR, [
      { relativePath: 'catalogue-0.json', absolutePath: shard, entryCount: 1 },
      { relativePath: 'search-index.json', absolutePath: index, entryCount: 0 },
    ], GENERATED_AT);

    // Owned, placed in canonical path order (scanner before search-*), and carrying
    // no invented entryCount: the packager does not own the sidecar's records.
    expect(manifest.artifacts.map((artifact) => artifact.path)).toEqual([
      'catalogue-0.json',
      ...[...sidecarBodies.keys()].sort(),
      'search-index.json',
    ]);
    for (const [relativePath, body] of sidecarBodies) {
      expect(manifest.artifacts.find((artifact) => artifact.path === relativePath)).toEqual({
        path: relativePath,
        byteSize: Buffer.byteLength(body),
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
      });
    }
  });

  it('fails a release manifest, without writing one, when a declared sidecar is not staged', () => {
    const shard = path.join(TEST_DIR, 'catalogue-0.json');
    fs.writeFileSync(shard, JSON.stringify([{ id: 'workflow-1' }]), 'utf8');

    // The reviewer's scenario: a mandatory sidecar is missing. Dropping its record
    // would emit a manifest that `check:data-sync` cannot distinguish from a
    // release that ships the artifact, because `manifest.artifacts` is the only
    // source of expected paths.
    expect(() => buildManifest(TEST_DIR, [
      { relativePath: 'catalogue-0.json', absolutePath: shard, entryCount: 1 },
    ], GENERATED_AT)).toThrow(/scanner\/calibration-v2-manifest\.json/);
    expect(fs.existsSync(path.join(TEST_DIR, 'manifest.json'))).toBe(false);
  });

  it('records no declared sidecar when the caller says this is not a release manifest', () => {
    const shard = path.join(TEST_DIR, 'catalogue-0.json');
    fs.writeFileSync(shard, JSON.stringify([{ id: 'workflow-1' }]), 'utf8');

    const { manifest } = buildScratchManifest(TEST_DIR, [
      { relativePath: 'catalogue-0.json', absolutePath: shard, entryCount: 1 },
    ], GENERATED_AT);

    expect(manifest.artifacts.map((artifact) => artifact.path)).toEqual(['catalogue-0.json']);
  });

  it.each([
    { security: { scannerVersion: 'scanner-sha' } },
    { security: { scannerVersion: 'scanner-sha', schemaVersion: 'scanner-result-v0' } },
  ])('rejects scanned catalogue security with invalid schema identity', ({ security }) => {
    const shard = path.join(TEST_DIR, 'catalogue-0.json');
    fs.writeFileSync(shard, JSON.stringify([{ id: 'workflow-1', security }]), 'utf8');

    expect(() => buildScratchManifest(TEST_DIR, [
      { relativePath: 'catalogue-0.json', absolutePath: shard, entryCount: 1 },
    ], GENERATED_AT)).toThrow(/schemaVersion/i);
  });

  it.each(['unscanned', 'not-scanned'])('allows legacy %s fallback without schema identity', (scannerVersion) => {
    const shard = path.join(TEST_DIR, 'catalogue-0.json');
    fs.writeFileSync(shard, JSON.stringify([{ id: 'workflow-1', security: { scannerVersion } }]), 'utf8');

    expect(() => buildScratchManifest(TEST_DIR, [
      { relativePath: 'catalogue-0.json', absolutePath: shard, entryCount: 1 },
    ], GENERATED_AT)).not.toThrow();
  });

  it('allows an explicit indeterminate fallback without schema identity', () => {
    const shard = path.join(TEST_DIR, 'catalogue-0.json');
    fs.writeFileSync(shard, JSON.stringify([{ id: 'workflow-1', security: {
      scannerVersion: 'unknown', analysisStatus: 'INDETERMINATE',
    } }]), 'utf8');

    expect(() => buildScratchManifest(TEST_DIR, [
      { relativePath: 'catalogue-0.json', absolutePath: shard, entryCount: 1 },
    ], GENERATED_AT)).not.toThrow();
  });
});
