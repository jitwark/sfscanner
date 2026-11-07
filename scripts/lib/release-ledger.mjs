/**
 * The trusted release ledger and the active-release pointer: the only two mutable
 * files in a release root. The ledger binds a release ID and sequence to the hashes of
 * the bytes it was staged from, so nothing can be rolled back to unless it is the exact
 * release that was verified, and the pointer is written by atomic replace.
 */
import path from 'node:path';
import { fail, jsonFile, record, replacePointer, sha256, validateId } from './release-artifacts.mjs';
import { LEDGER_FILE, POINTER_FILE } from './release-schemas.mjs';

const DIGEST = /^[a-f0-9]{64}$/u;
const SECTION_HASH = /^[A-Za-z][A-Za-z0-9]*Sha256$/u;
const IDENTITY_KEYS = Object.freeze(['releaseId', 'sequence', 'releaseJsonSha256']);

export async function readLedger(root, schemas) {
  const ledger = await jsonFile(path.join(root, LEDGER_FILE), 'trusted release ledger');
  if (!record(ledger) || ledger.schemaVersion !== schemas.ledger || !Array.isArray(ledger.releases)) fail('trusted release ledger has an invalid schema');
  const seen = new Set();
  let previous = null;
  const releases = ledger.releases.map((entry) => {
    if (!record(entry) || !DIGEST.test(String(entry.releaseJsonSha256)) ||
      !Number.isSafeInteger(entry.sequence) || entry.sequence < 0) fail('trusted release ledger has an invalid release');
    validateId(entry.releaseId, 'ledger release ID');
    if (seen.has(entry.releaseId)) fail('trusted release ledger has an invalid or duplicate release');
    seen.add(entry.releaseId);
    const others = Object.keys(entry).filter((key) => !IDENTITY_KEYS.includes(key));
    if (others.length === 0 || others.some((key) => !SECTION_HASH.test(key) || !DIGEST.test(String(entry[key])))) {
      fail(`trusted release ledger entry ${entry.releaseId} binds no valid section`);
    }
    if (previous !== null && entry.sequence <= previous) fail('trusted release ledger is not ordered by sequence');
    previous = entry.sequence;
    return entry;
  });
  return { schemaVersion: schemas.ledger, releases };
}

export function nextSequence(ledger) {
  return ledger.releases.reduce((highest, entry) => Math.max(highest, entry.sequence), 0) + 1;
}

/**
 * The release a rollback would restore: the nearest earlier sequence in the trusted
 * ledger. Derived rather than read from the pointer, because the pointer moves during a
 * rollback and a descriptor that bound it could not be re-verified afterwards.
 */
export function previousRelease(ledger, sequence) {
  const earlier = ledger.releases
    .filter((entry) => entry.sequence < sequence)
    .sort((left, right) => right.sequence - left.sequence)[0];
  return earlier === undefined ? null : Object.freeze({ releaseId: earlier.releaseId, sequence: earlier.sequence });
}

/** The ledger entry a staged release will be published as. */
export function ledgerEntry({ releaseId, sequence, releaseJsonSha256, sectionHashes }) {
  const entry = { releaseId, sequence, releaseJsonSha256 };
  for (const name of Object.keys(sectionHashes).sort()) entry[`${name}Sha256`] = sectionHashes[name];
  return entry;
}

export async function writeLedger(root, schemas, entries) {
  const sorted = [...entries].sort((left, right) => left.sequence - right.sequence);
  const text = `${JSON.stringify({ schemaVersion: schemas.ledger, releases: sorted }, null, 2)}\n`;
  await replacePointer(path.join(root, LEDGER_FILE), text);
  return sorted;
}

export async function readPointer(root, schemas) {
  const pointer = await jsonFile(path.join(root, POINTER_FILE), 'active release pointer');
  if (!record(pointer) || pointer.schemaVersion !== schemas.pointer) fail('active release pointer has an invalid schema');
  return pointer;
}

export async function writePointer(root, schemas, releaseId) {
  await replacePointer(path.join(root, POINTER_FILE), `${JSON.stringify({ schemaVersion: schemas.pointer, releaseId }, null, 2)}\n`);
}

/**
 * A release is only as good as the ledger binding: this is the one place that decides
 * whether the bytes on disk are the release the ledger recorded. The key set is exact —
 * every declared section is bound, and no unbound hash is accepted.
 */
export function assertLedgerBinding(entry, releaseValue, sectionHashes, releaseJsonSha256, releaseId) {
  const names = Object.keys(sectionHashes).sort();
  const expected = [...names.map((name) => `${name}Sha256`), ...IDENTITY_KEYS].sort();
  const actual = record(entry) ? Object.keys(entry).sort() : [];
  const unbound = names.some((name) => entry?.[`${name}Sha256`] !== sectionHashes[name]) ||
    actual.length !== expected.length || actual.some((key, index) => key !== expected[index]);
  if (!record(entry) || unbound || entry.sequence !== releaseValue.sequence || entry.releaseJsonSha256 !== releaseJsonSha256) {
    fail(`release ${releaseId} is not bound by the trusted release ledger`);
  }
}

export function releaseJsonSha256(bytes) {
  return sha256(bytes);
}
