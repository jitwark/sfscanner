import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { buildMetadataFromEntries } from './metadata-from-entries.js';
import { makeEntry } from '../__fixtures__/make-entry.js';

const scratch: string[] = [];
function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-'));
  scratch.push(dir);
  fs.writeFileSync(path.join(dir, 'catalogue-0.json'), '[]', 'utf8');
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const TARGET = { version: '2.34.6', source: 'npm view n8n version', checkedAt: '2026-08-16' };
const entryWith = (scannerVersion: string): Entry =>
  makeEntry({ security: { scannerVersion } } as never) as Entry;

describe('buildMetadataFromEntries scanner identity', () => {
  it('refuses two competing scanner generations when nothing is declared', () => {
    // The invariant that keeps an accidentally mixed corpus from being published
    // as if one scanner produced it.
    expect(() => buildMetadataFromEntries(
      [entryWith('scanner-beta-1'), entryWith('c998701')], scratchDir(), TARGET, '2026-09-25T00:00:00.000Z',
    )).toThrow(/found mixed/);
  });

  it('publishes one engine version plus a build stamp the caller named', () => {
    const metadata = buildMetadataFromEntries(
      [entryWith('scanner-beta-1'), entryWith('c998701')],
      scratchDir(),
      TARGET,
      '2026-09-25T00:00:00.000Z',
      { legacyScannerStamps: ['c998701'] },
    );

    // The manifest stamp is the engine identity, so a reader without a shard
    // sees the scanner that produced this generation's results — not the build
    // stamp left on entries whose body was not available to rescan.
    expect(metadata.scannerVersion).toBe('scanner-beta-1');
    expect(metadata.generatedAt).toBe('2026-09-25T00:00:00.000Z');
  });

  it('still refuses an entry whose scan provenance was lost', () => {
    expect(() => buildMetadataFromEntries(
      [entryWith('unknown')], scratchDir(), TARGET, '2026-09-25T00:00:00.000Z', { legacyScannerStamps: ['c998701'] },
    )).toThrow(/found unknown/);
  });
});
