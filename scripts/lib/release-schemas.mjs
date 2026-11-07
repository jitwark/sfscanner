/**
 * The schema families a release root can declare, and the marker that declares one.
 *
 * A root states which family it is before any release in it is trusted: the fixture
 * drill's family, or the staged-release family this row introduces. Naming them in one
 * place is what lets the verifier stay single-implementation — the fixture drill and the
 * real rollback rehearsal run the same hash and ledger checks with no second code path.
 */
import { fail, jsonFile, record } from './release-artifacts.mjs';
import path from 'node:path';

export const FIXTURE_SCHEMAS = Object.freeze({
  marker: 'rollback-fixture-v1',
  scope: 'fixture-only',
  release: 'fixture-release-v1',
  artifact: 'fixture-artifact-v1',
  pointer: 'fixture-active-release-pointer-v1',
  ledger: 'fixture-trusted-release-ledger-v1',
});

export const STAGED_SCHEMAS = Object.freeze({
  marker: 'release-staging-v1',
  scope: 'staged-release',
  release: 'release-v1',
  artifact: 'release-artifact-v1',
  pointer: 'active-release-pointer-v1',
  ledger: 'trusted-release-ledger-v1',
});

export const MARKER_FILE = 'release-staging.json';
export const FIXTURE_MARKER_FILE = 'fixture.json';
export const POINTER_FILE = 'active-release.json';
export const LEDGER_FILE = 'trusted-release-ledger.json';

/** Reads a root's authorization marker; `null` means the root declares nothing. */
export async function readRootMarker(root) {
  const fixture = await jsonFile(path.join(root, FIXTURE_MARKER_FILE), 'fixture marker').catch(() => null);
  if (fixture !== null) {
    if (!record(fixture) || fixture.schemaVersion !== FIXTURE_SCHEMAS.marker || fixture.scope !== FIXTURE_SCHEMAS.scope) fail('fixture marker does not authorize fixture-only rollback');
    return { family: 'fixture', schemas: FIXTURE_SCHEMAS };
  }
  const staged = await jsonFile(path.join(root, MARKER_FILE), 'release staging marker').catch(() => null);
  if (staged !== null) {
    if (!record(staged) || staged.schemaVersion !== STAGED_SCHEMAS.marker || staged.scope !== STAGED_SCHEMAS.scope) fail('release staging marker does not authorize a staged release root');
    return { family: 'staged', schemas: STAGED_SCHEMAS };
  }
  return null;
}
