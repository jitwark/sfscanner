/**
 * Roll a release root's active pointer back to an earlier immutable release.
 *
 * The command is deliberately narrow: it verifies the exact bytes of both the current
 * and the target release against the trusted ledger, re-verifies the target again after
 * the pointer has moved, and changes nothing but the pointer file. Two release families
 * are authorized — the `fixture.json` drill and a real staged release root written by
 * `scripts/stage-release.mjs`, which is the same verifier used by the rehearsal.
 *
 * Usage: node scripts/rollback-release.mjs --release-root <root> --release-id <prior-id>
 *        node scripts/rollback-release.mjs --fixture-root <temporary-fixture> --release-id <prior-id>
 */
import os from 'node:os';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  declaredSections, directory, fail, inside, isArtifactSection, jsonFile, record, replacePointer, sha256, validateId, verifySection,
} from './lib/release-artifacts.mjs';
import { assertLedgerBinding, readLedger, readPointer, writePointer } from './lib/release-ledger.mjs';
import { FIXTURE_SCHEMAS, LEDGER_FILE, readRootMarker, STAGED_SCHEMAS } from './lib/release-schemas.mjs';

export { replacePointer } from './lib/release-artifacts.mjs';
export { FIXTURE_SCHEMAS, STAGED_SCHEMAS };
export const RELEASE_SCHEMA = FIXTURE_SCHEMAS.release;
export const ARTIFACT_SCHEMA = FIXTURE_SCHEMAS.artifact;
export const FIXTURE_SCHEMA = FIXTURE_SCHEMAS.marker;
export const POINTER_SCHEMA = FIXTURE_SCHEMAS.pointer;
export const LEDGER_SCHEMA = FIXTURE_SCHEMAS.ledger;

/** Resolves and authorizes a release root: never the repository, never a production path. */
async function authorizedRoot(input) {
  if (typeof input !== 'string' || input.length === 0) fail('release root is required');
  const root = path.resolve(input);
  await directory(root, 'release root');
  const canonical = await realpath(root);
  const repository = await realpath(path.resolve(import.meta.dirname, '..')).catch(() => null);
  if (repository && (inside(repository, canonical) || inside(canonical, repository))) {
    fail('repository and production paths are not valid release roots');
  }
  const marker = await readRootMarker(canonical);
  if (marker === null) fail('release root is not authorized: a fixture root marker or a release staging marker is required');
  if (marker.family === 'fixture') {
    const temporary = await realpath(os.tmpdir());
    if (canonical === temporary || !inside(temporary, canonical)) fail('fixture root must be a child of the OS temporary directory');
  }
  return { root: canonical, schemas: marker.schemas };
}

/** Reads one immutable release: identity, layout, and every section hash recomputed from disk. */
export async function readRelease(root, schemas, releaseId) {
  validateId(releaseId);
  const releasesRoot = path.join(root, 'releases');
  await directory(releasesRoot, 'release directory');
  const releaseRoot = path.join(releasesRoot, releaseId);
  await directory(releaseRoot, `release ${releaseId}`);
  const entries = await readdir(releaseRoot, { withFileTypes: true });
  const names = entries.map((entry) => entry.name);
  if (entries.some((entry) => entry.isSymbolicLink() || entry.name.includes('\\')) || !names.includes('release.json') || names.length < 3) {
    fail(`release ${releaseId} has an unexpected or mixed layout`);
  }
  const parsed = await jsonFile(path.join(releaseRoot, 'release.json'), `release ${releaseId} record`, true);
  const value = parsed.value;
  if (!record(value) || value.schemaVersion !== schemas.release || value.releaseId !== releaseId ||
    !Number.isSafeInteger(value.sequence) || value.sequence < 0 || value.verified !== true ||
    !record(value.verification) || value.verification.status !== 'verified' ||
    typeof value.verification.method !== 'string' || !value.verification.method.trim() ||
    value.verification.evidence !== LEDGER_FILE ||
    value.artifactSchemaVersion !== schemas.artifact) {
    fail(`release ${releaseId} has an invalid, mixed-schema, or unverified identity`);
  }
  const sectionHashes = {};
  for (const name of [...names].filter((entry) => entry !== 'release.json').sort()) {
    if (!isArtifactSection(value[name], schemas.artifact)) fail(`release ${releaseId} section ${name} has an invalid or mixed schema`);
    sectionHashes[name] = await verifySection(releaseRoot, name, value[name], schemas.artifact);
  }
  const recordSections = declaredSections(value, schemas.artifact);
  if (recordSections.length !== Object.keys(sectionHashes).length) fail(`release ${releaseId} declares sections it does not ship`);
  return { id: releaseId, sequence: value.sequence, record: value, sectionHashes, releaseJsonSha256: sha256(parsed.bytes) };
}

/** Re-reads the pointer and re-verifies whatever release it now names. */
export async function verifyActive(root, schemas) {
  const { releases } = await readLedger(root, schemas);
  const ledger = new Map(releases.map((entry) => [entry.releaseId, entry]));
  const pointer = await readPointer(root, schemas);
  const active = await readRelease(root, schemas, validateId(pointer.releaseId, 'active release ID'));
  assertLedgerBinding(ledger.get(active.id), active.record, active.sectionHashes, active.releaseJsonSha256, active.id);
  return active;
}

export async function rollbackRelease({ releaseRoot: input, fixtureRoot, releaseId: targetId }) {
  const { root, schemas } = await authorizedRoot(input ?? fixtureRoot);
  const { releases } = await readLedger(root, schemas);
  const ledger = new Map(releases.map((entry) => [entry.releaseId, entry]));
  const target = validateId(targetId, 'target release ID');
  const pointer = await readPointer(root, schemas);
  const current = await readRelease(root, schemas, validateId(pointer.releaseId, 'active release ID'));
  const prior = await readRelease(root, schemas, target);
  assertLedgerBinding(ledger.get(current.id), current.record, current.sectionHashes, current.releaseJsonSha256, current.id);
  assertLedgerBinding(ledger.get(prior.id), prior.record, prior.sectionHashes, prior.releaseJsonSha256, prior.id);
  if (prior.sequence >= current.sequence) fail(`release ${target} is not an earlier immutable release`);
  await writePointer(root, schemas, prior.id);
  const verified = await verifyActive(root, schemas);
  if (verified.id !== prior.id) fail(`rollback did not restore release ${prior.id}`);
  return {
    from: current.id,
    to: prior.id,
    pointerPath: path.join(root, 'active-release.json'),
    sectionHashes: Object.freeze({ ...prior.sectionHashes }),
    verifiedAfter: Object.freeze({ releaseId: verified.id, sequence: verified.sequence, sections: Object.freeze({ ...verified.sectionHashes }) }),
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return null;
    if (flag !== '--fixture-root' && flag !== '--release-root' && flag !== '--release-id') fail(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail(`${flag} requires a value`);
    values[flag.slice(2)] = value;
  }
  if ((!values['release-root'] && !values['fixture-root']) || !values['release-id']) {
    fail('usage: rollback-release --release-root <root> --release-id <prior-id>');
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args) console.log('usage: rollback-release --release-root <root> --release-id <prior-id>');
    else {
      const result = await rollbackRelease({ releaseRoot: args['release-root'], fixtureRoot: args['fixture-root'], releaseId: args['release-id'] });
      const hashes = Object.entries(result.verifiedAfter.sections).map(([name, hash]) => `${name} ${hash}`).join('; ');
      console.log(`rollback-release: pointer ${result.from} -> release ${result.to}; verified after the move: ${hashes}`);
    }
  } catch (error) {
    console.error(`rollback-release refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
