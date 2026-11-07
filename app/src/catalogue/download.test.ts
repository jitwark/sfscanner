import type { Entry } from '@hub/contracts';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SCHEMA_VERSION } from './manifest';
import { getDownloadSpec, downloadWorkflow } from './download';
import { makeManifestFor, makeTestEntry } from './download-test-support';

describe('download.ts', () => {
  it('returns null spec for link-only entry', () => {
    expect(getDownloadSpec(makeTestEntry('link_only'))).toBeNull();
  });

  it('fails closed when a redistributable entry has incomplete download metadata', () => {
    const incomplete = { ...makeTestEntry('redistributable'), download: undefined };
    expect(getDownloadSpec(incomplete)).toBeNull();
    expect(getDownloadSpec(incomplete, {
      schemaVersion: MANIFEST_SCHEMA_VERSION, generatedAt: '2026-08-13T00:00:00.000Z', totalEntries: 1,
      catalogueShards: {}, artifacts: [{
        path: 'packs/pack-4.jsonl', byteSize: 200, sha256: '0'.repeat(64), entryCount: 1, entryRange: [0, 0],
      }],
    })).toBeNull();

    const partial = { ...makeTestEntry('redistributable'), download: { pack: 2, line: 1 } } as Entry;
    expect(getDownloadSpec(partial)).toBeNull();
  });

  it('requires manifest-confirmed pack coordinates before exposing a download', () => {
    const redist = makeTestEntry('redistributable');
    const manifest = makeManifestFor(redist);
    expect(getDownloadSpec(redist)).toBeNull();
    expect(getDownloadSpec(redist, manifest)).toEqual({
      packPath: 'packs/pack-0.jsonl', line: 0, offset: 0, length: 200, totalSize: 200, sha256: 'a'.repeat(64),
    });
    expect(getDownloadSpec(redist, { ...manifest, artifacts: [] })).toBeNull();
    expect(getDownloadSpec({ ...redist, download: { ...redist.download!, offset: 1 } }, manifest)).toBeNull();
  });

  it('rejects malformed download hashes instead of treating them as legacy metadata', () => {
    const entry = makeTestEntry('redistributable', {
      download: { pack: 0, line: 0, offset: 0, length: 200, sha256: 'A'.repeat(64) },
    });
    expect(getDownloadSpec(entry, makeManifestFor(entry))).toBeNull();
  });

  it('refuses a redistributable entry that publishes no digest at all', () => {
    const entry = makeTestEntry('redistributable', {
      download: { pack: 0, line: 0, offset: 0, length: 200 },
    });
    expect(getDownloadSpec(entry, makeManifestFor(entry))).toBeNull();
  });

  it('cannot be talked into attaching a notice to a link-only entry', async () => {
    await expect(downloadWorkflow(makeTestEntry('link_only'))).rejects.toThrow(/link-only/i);
  });
});
