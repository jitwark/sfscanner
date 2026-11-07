import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION, type PublicReleaseMetadata } from '@hub/contracts/public-data-model';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { buildPublicProjection } from './public-projection.js';
import { writePublicRelease } from './public-release.js';
import { defaultPublicReleaseWriters, type PublicReleaseWriters } from './bundle-builder.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function release(id: string): PublicReleaseMetadata {
  return {
    releaseId: id, schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
    generatedAt: '2026-08-30T00:00:00.000Z', toolVersion: 'hub-pipeline@1.0.0', scannerVersion: 'scanner-v1',
    policyVersion: 'policy-v1', searchIndexVersion: 'search-v1', buildRevision: 'revision',
    manifestSha256: 'a'.repeat(64), corpusSha256: 'b'.repeat(64),
    counts: { workflows: 1, redistributable: 1, linkOnly: 0, excluded: 0, findings: 0 },
    facetCounts: { rights: { redistributable: 1, linkOnly: 0, excluded: 0 } },
  };
}

function projection(releaseId: string) {
  return buildPublicProjection([makeEntry({ id: 'one', download: { pack: 0, line: 1, offset: 0, length: 10 } })], {
    release: release(releaseId), bodySha256ByWorkflowId: { one: 'c'.repeat(64) },
  });
}

function directory(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-release-atomicity-'));
  roots.push(parent);
  return path.join(parent, 'release');
}

type Snapshot = Record<string, string>;

function snapshot(root: string): Snapshot {
  const result: Snapshot = {};
  const visit = (dir: string, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, relative);
      else result[relative] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  visit(root);
  return result;
}

function failingWriters(overrides: Partial<PublicReleaseWriters>): PublicReleaseWriters {
  return { ...defaultPublicReleaseWriters, ...overrides };
}

describe('writePublicRelease bundle atomicity', () => {
  it.each<[string, Partial<PublicReleaseWriters>]>([
    ['NDJSON', { ndjson: () => { throw new Error('simulated NDJSON writer failure'); } }],
    ['SQLite', { sqlite: () => { throw new Error('simulated SQLite writer failure'); } }],
    ['Excel', { excel: () => { throw new Error('simulated Excel writer failure'); } }],
    ['schema document', { schema: () => { throw new Error('simulated schema document failure'); } }],
    ['data dictionary document', { dictionary: () => { throw new Error('simulated data dictionary failure'); } }],
    ['release notes document', { releaseNotes: () => { throw new Error('simulated release notes failure'); } }],
    ['examples document', { examples: () => { throw new Error('simulated examples document failure'); } }],
    ['bundle manifest', { manifest: () => { throw new Error('simulated manifest write failure'); } }],
  ])('rolls back cleanly when the %s writer fails, leaving the release directory and manifest byte-identical', (_label, overrides) => {
    const dir = directory();
    writePublicRelease(projection('release-before'), dir);
    const before = snapshot(dir);
    const beforeManifest = fs.readFileSync(path.join(dir, 'public-release.json'), 'utf8');

    expect(() => writePublicRelease(projection('release-after'), dir, failingWriters(overrides))).toThrow(/simulated/);

    expect(snapshot(dir)).toEqual(before);
    expect(fs.readFileSync(path.join(dir, 'public-release.json'), 'utf8')).toBe(beforeManifest);
  });

  it('produces a first-time release when no previous bundle exists at the target path', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-release-atomicity-first-'));
    const dir = path.join(parent, 'nested', 'release');
    roots.push(parent);
    expect(fs.existsSync(dir)).toBe(false);

    const bundle = writePublicRelease(projection('release-first'), dir);

    expect(bundle.releaseId).toBe('release-first');
    expect(fs.existsSync(path.join(dir, 'public-release.json'))).toBe(true);
    expect(fs.existsSync(`${dir}.previous`)).toBe(false);
  });
});
