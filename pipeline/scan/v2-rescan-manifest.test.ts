import { describe, expect, it } from 'vitest';
import {
  makeV2RescanManifest,
  writeV2RescanManifest,
  readV2RescanManifest,
  isV2RescanRecordStale,
  isV2RescanRecordCacheEligible,
  type V2RescanManifest,
} from './v2-rescan-manifest.js';
import type { V2RescanRecord } from './v2-corpus-adapter.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const digest = (letter: string) => letter.repeat(64);
const record = (entryId: string, overrides: Partial<V2RescanRecord> = {}): V2RescanRecord => ({
  entryId,
  sourceDigest: digest('a'),
  inputSha256: digest('b'),
  scannerVersion: '2.0.0',
  engineBuildDigest: digest('c'),
  profileId: 'beta-default',
  profileVersion: '2.0.0',
  rulesetDigest: digest('d'),
  semanticsDigest: digest('e'),
  limitsDigest: digest('f'),
  analysisStatus: 'COMPLETE',
  findingIds: [],
  rightsClass: 'redistributable',
  ok: true,
  ...overrides,
});

describe('v2 rescan manifest', () => {
  it('sorts records and serializes a self-authenticating manifest', async () => {
    const manifest = makeV2RescanManifest('release-2', [record('z'), record('a')]);
    expect(manifest.schemaVersion).toBe('v2-rescan-manifest');
    expect(manifest.records.map((item) => item.entryId)).toEqual(['a', 'z']);
    expect(manifest.manifestDigest).toMatch(/^[0-9a-f]{64}$/);

    const directory = await mkdtemp(join(tmpdir(), 'v2-rescan-'));
    const path = await writeV2RescanManifest(directory, manifest);
    const parsed = await readV2RescanManifest(path);
    expect(parsed).toEqual(manifest);
    expect(await readFile(path, 'utf8')).not.toContain('nodes');
  });

  it('rejects duplicate entries and stale input or authority identities', () => {
    expect(() => makeV2RescanManifest('release', [record('same'), record('same')])).toThrow(/duplicate/i);
    const prior = record('one');
    expect(isV2RescanRecordStale(prior, { ...prior, inputSha256: digest('1') })).toBe(true);
    expect(isV2RescanRecordStale(prior, { ...prior, engineBuildDigest: digest('2') })).toBe(true);
    expect(isV2RescanRecordStale(prior, { ...prior, rightsClass: 'link_only' })).toBe(false);
    expect(isV2RescanRecordStale(prior, { ...prior })).toBe(false);
  });

  it('does not accept a tampered manifest digest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'v2-rescan-'));
    const path = await writeV2RescanManifest(directory, makeV2RescanManifest('release', [record('one')]));
    const content = JSON.parse(await readFile(path, 'utf8')) as V2RescanManifest & { records: V2RescanRecord[] };
    content.records[0] = { ...content.records[0], inputSha256: digest('9') };
    const tamperedPath = join(directory, 'tampered.json');
    await writeFile(tamperedPath, `${JSON.stringify(content)}\n`, 'utf8');
    await expect(readV2RescanManifest(tamperedPath)).rejects.toThrow(/invalid|digest/i);
  });

  it('determines cache eligibility from securitySha256 and projection version', () => {
    const valid = record('one', {
      securityProjectionVersion: 'v2-entry-security-1',
      securitySha256: digest('9'),
    });
    expect(isV2RescanRecordCacheEligible(valid)).toBe(true);

    // Legacy / old record without securitySha256 is not cache-eligible (cold miss)
    const legacy = record('one');
    expect(isV2RescanRecordCacheEligible(legacy)).toBe(false);

    // Degraded or not ok record is not cache-eligible
    expect(isV2RescanRecordCacheEligible({ ...valid, ok: false })).toBe(false);
    expect(isV2RescanRecordCacheEligible({ ...valid, analysisStatus: 'DEGRADED' })).toBe(false);

    // Mismatched projection version is not cache-eligible
    expect(isV2RescanRecordCacheEligible({ ...valid, securityProjectionVersion: 'v2-entry-security-99' })).toBe(false);
  });

  it('rejects malformed securitySha256 or securityProjectionVersion during manifest normalization', () => {
    expect(() => makeV2RescanManifest('release', [record('one', { securitySha256: 'not-hex' })])).toThrow(/securitySha256/i);
    expect(() => makeV2RescanManifest('release', [record('one', { securityProjectionVersion: '' })])).toThrow(/securityProjectionVersion/i);
  });
});
