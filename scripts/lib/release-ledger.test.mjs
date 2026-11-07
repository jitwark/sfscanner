import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertLedgerBinding, nextSequence, readLedger } from './release-ledger.mjs';
import { STAGED_SCHEMAS } from './release-schemas.mjs';

/**
 * The ledger is the only thing that makes a release trustworthy, and its shape is the
 * check: a section hash that is not bound, and a hash bound to the wrong section, are both
 * "not this release". These cases pin the exact key set, because a looser rule accepted
 * `releaseJsonSha256` as if it were a section named `releaseJson`.
 */
const HASHES = { site: 'a'.repeat(64), data: 'b'.repeat(64), export: 'c'.repeat(64) };
const RELEASE = { sequence: 3 };
const JSON_SHA = 'd'.repeat(64);
let workRoot = '';

const entry = { releaseId: 'release-2026-01-02-abcdefabcdef', sequence: 3, releaseJsonSha256: JSON_SHA, siteSha256: HASHES.site, dataSha256: HASHES.data, exportSha256: HASHES.export };

async function writeLedger(value) {
  const root = await mkdtemp(path.join(workRoot, 'ledger-'));
  await writeFile(path.join(root, 'trusted-release-ledger.json'), `${JSON.stringify(value, null, 2)}\n`);
  return root;
}

beforeAll(async () => {
  workRoot = await mkdtemp(path.join(os.tmpdir(), 'release-ledger-'));
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe('release ledger binding', () => {
  it('binds every declared section and the release record bytes', () => {
    expect(() => assertLedgerBinding(entry, RELEASE, HASHES, JSON_SHA, entry.releaseId)).not.toThrow();
  });

  it('refuses an entry that does not bind every declared section', () => {
    const { exportSha256: _dropped, ...partial } = entry;
    expect(() => assertLedgerBinding(partial, RELEASE, HASHES, JSON_SHA, entry.releaseId)).toThrow(/not bound/u);
  });

  it('refuses an entry that binds a hash for something that is not a section', () => {
    expect(() => assertLedgerBinding({ ...entry, siteHashSha256: HASHES.site }, RELEASE, HASHES, JSON_SHA, entry.releaseId)).toThrow(/not bound/u);
  });

  it('refuses a section hash that belongs to different bytes', () => {
    expect(() => assertLedgerBinding({ ...entry, dataSha256: 'e'.repeat(64) }, RELEASE, HASHES, JSON_SHA, entry.releaseId)).toThrow(/not bound/u);
  });

  it('refuses a release whose record bytes or sequence moved', () => {
    expect(() => assertLedgerBinding(entry, RELEASE, HASHES, 'e'.repeat(64), entry.releaseId)).toThrow(/not bound/u);
    expect(() => assertLedgerBinding(entry, { sequence: 4 }, HASHES, JSON_SHA, entry.releaseId)).toThrow(/not bound/u);
  });
});

describe('release ledger file', () => {
  it('reads an ordered ledger and computes the next sequence', async () => {
    const root = await writeLedger({ schemaVersion: STAGED_SCHEMAS.ledger, releases: [{ ...entry, sequence: 1 }, { ...entry, releaseId: 'release-2026-01-02-fedcbafedcba', sequence: 2, releaseJsonSha256: 'e'.repeat(64) }] });
    const ledger = await readLedger(root, STAGED_SCHEMAS);
    expect(ledger.releases.map((item) => item.sequence)).toEqual([1, 2]);
    expect(nextSequence(ledger)).toBe(3);
  });

  it('refuses a ledger that is not ordered by sequence', async () => {
    const root = await writeLedger({ schemaVersion: STAGED_SCHEMAS.ledger, releases: [{ ...entry, sequence: 2 }, { ...entry, releaseId: 'release-2026-01-02-fedcbafedcba', sequence: 1, releaseJsonSha256: 'e'.repeat(64) }] });
    await expect(readLedger(root, STAGED_SCHEMAS)).rejects.toThrow(/not ordered by sequence/u);
  });

  it('refuses a duplicate release and an entry that binds nothing', async () => {
    const duplicate = await writeLedger({ schemaVersion: STAGED_SCHEMAS.ledger, releases: [{ ...entry, sequence: 1 }, { ...entry, sequence: 2, releaseJsonSha256: 'e'.repeat(64) }] });
    await expect(readLedger(duplicate, STAGED_SCHEMAS)).rejects.toThrow(/duplicate/u);
    const empty = await writeLedger({ schemaVersion: STAGED_SCHEMAS.ledger, releases: [{ releaseId: entry.releaseId, sequence: 1, releaseJsonSha256: JSON_SHA }] });
    await expect(readLedger(empty, STAGED_SCHEMAS)).rejects.toThrow(/binds no valid section/u);
  });
});
