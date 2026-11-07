import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INVENTORY_ALGORITHM, INVENTORY_SCHEMA_VERSION, inventoryDigest, inventoryEntries } from './lib/published-secret-input-inventory.mjs';

/**
 * End-to-end runs of the gate against synthetic inputs, so the verdicts are
 * proven without touching the real corpus or the real artifacts.
 *
 * Every fixture value is synthetic and was never drawn from the corpus, and
 * every assertion checks that the gate's own output does not carry one: the
 * hard constraint is that a leak gate must never become a place a candidate
 * value appears.
 */
const BASIC_VALUE = 'Basic qqbbjjvvww0123456789';
const BEARER_VALUE = 'Bearer xxzzqqbbjjvv0123456789';
const CREDENTIAL_USER = 'qqvvbbjj';
const CREDENTIAL_PASSWORD = 'wwxxzz0123456789';
const FIXTURE_VALUES = [BASIC_VALUE, BEARER_VALUE, CREDENTIAL_USER, CREDENTIAL_PASSWORD];

const root = path.resolve(import.meta.dirname, '..');
const gate = path.join(import.meta.dirname, 'check-published-secret-leak.mjs');
const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'published-secret-gate-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeBodies() {
  const directory = path.join(temporaryDirectory(), 'bodies');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'official__9999_Synthetic_Gate_Fixture.json'), JSON.stringify({
    nodes: [
      {
        name: 'HTTP Request',
        parameters: {
          headerParameters: {
            parameters: [
              { name: 'Authorization', value: BASIC_VALUE },
              { name: 'Authorization', value: BEARER_VALUE },
              { name: 'X-Api-Key', value: '={{ $json.token }}' },
            ],
          },
        },
        credentials: {
          httpBasicAuth: { id: 'cred-1', name: 'Fixture', user: CREDENTIAL_USER, password: CREDENTIAL_PASSWORD },
        },
      },
    ],
  }), 'utf8');
  return directory;
}

function writeArtifacts(content) {
  const directory = path.join(temporaryDirectory(), 'artifacts');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'catalogue-0.json'), JSON.stringify(content), 'utf8');
  return directory;
}

/**
 * The owner-provisioned input snapshot, written from the real inventory code so
 * the test exercises the production verifier instead of a hand-written digest.
 */
function writeSnapshot(bodiesDir, overrides = {}) {
  const files = inventoryEntries(bodiesDir);
  const directory = temporaryDirectory();
  const file = path.join(directory, 'input-snapshot.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    algorithm: INVENTORY_ALGORITHM,
    inventoryDigest: inventoryDigest(files),
    fileCount: files.length,
    totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    files,
    ...overrides,
  }), 'utf8');
  return file;
}

/** A synthetic fixture with its snapshot provisioned, as the trusted runner would supply it. */
function fixture(artifactContent) {
  const bodies = writeBodies();
  return { bodies, snapshot: writeSnapshot(bodies), artifacts: writeArtifacts(artifactContent) };
}

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [gate, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, OFFICIAL_BODIES_SNAPSHOT: '', ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, combined: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  // `CI` is stubbed by the local-only-policy tests; a stubbed value must not
  // leak into the next case (the gate reads it to pick fail-closed vs skip).
  vi.unstubAllEnvs();
  while (temporaryDirectories.length > 0) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

describe('published secret gate cli', () => {
  it('passes when the published artifact carries none of the candidates', () => {
    const { bodies, snapshot, artifacts } = fixture({ entries: [{ id: 'x', summary: 'clean' }] });
    const result = run(['--bodies', bodies, '--snapshot', snapshot, '--artifacts', artifacts]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Published secret gate passed');
    expect(result.combined).not.toContain('LEAK');
  });

  /**
   * The red run: the artifact carries a strict candidate, so the gate has to
   * fail and name the artifact, the field path and the rule class — and still
   * not name the value.
   */
  it('fails and locates a strict candidate that reaches a published artifact', () => {
    const { bodies, snapshot, artifacts } = fixture({ entries: [{ id: 'x', security: { header: BASIC_VALUE } }] });
    const result = run(['--bodies', bodies, '--snapshot', snapshot, '--artifacts', artifacts, '--json']);
    expect(result.status).toBe(1);
    const summary = JSON.parse(result.stdout);
    expect(summary.matches.strict).toBe(1);
    expect(summary.findings.strict[0]).toMatchObject({
      fieldPath: '$.entries[0].security.header',
      ruleClass: 'strict:basic-authorization-header',
      strict: true,
      needleLength: BASIC_VALUE.length,
    });
    expect(summary.findings.strict[0].artifact).toContain('catalogue-0.json');
    expect(result.stderr).toContain('$.entries[0].security.header');
  });

  it('fails on demand when the positive control artifact is swept with the real ones', () => {
    const { bodies, snapshot, artifacts } = fixture({ entries: [] });
    const result = run(['--bodies', bodies, '--snapshot', snapshot, '--artifacts', artifacts, '--plant-leak', '--json']);
    expect(result.status).toBe(1);
    expect(result.combined).toContain('LEAK');
    expect(result.combined).toContain('control-artifact.json');
    // The synthesized needles are stripped from the summary, so no planted value
    // reaches the gate's own output.
    expect(result.stdout).not.toMatch(/[bjqvwxz0-9]{16,}/);
  });

  it('fails closed when the raw bodies are not there to assert absence about', () => {
    // Local runs must never take the CI skip: the gate's whole value is that it
    // cannot prove absence without the source it is asserting absence about.
    vi.stubEnv('CI', '');
    const result = run(['--bodies', path.join(temporaryDirectory(), 'absent'), '--artifacts', writeArtifacts({ entries: [] })]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('raw bodies not found');
    expect(result.combined).not.toContain('skipped');
  });

  it('proves it can fail before it reports a verdict, every run', () => {
    const { bodies, snapshot, artifacts } = fixture({ entries: [] });
    const result = run(['--bodies', bodies, '--snapshot', snapshot, '--artifacts', artifacts]);
    expect(result.stdout).toContain('Positive control: 5/5 planted values detected');
  });

  it('reports the candidate counts, the swept artifact count and the verified snapshot', () => {
    const { bodies, snapshot, artifacts } = fixture({ entries: [] });
    const result = run(['--bodies', bodies, '--snapshot', snapshot, '--artifacts', artifacts, '--json']);
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.inputSnapshot).toMatchObject({
      digest: inventoryDigest(inventoryEntries(bodies)),
      fileCount: 1,
      algorithm: INVENTORY_ALGORITHM,
      schemaVersion: INVENTORY_SCHEMA_VERSION,
    });
    const human = run(['--bodies', bodies, '--snapshot', snapshot, '--artifacts', artifacts]);
    expect(human.stdout).toContain('strict candidates: 4 distinct values');
    expect(human.stdout).toContain('loose candidates:  1 distinct values');
    expect(human.stdout).toContain('Artifacts: 1 files');
    expect(human.stdout).toContain('Input snapshot: sha256:');
  });
});

/**
 * Owner policy (2026-10-18): the raw official corpus is local-only and
 * non-redistributable, so a cloud runner cannot possess it and `release:gates`
 * would fail every deploy at this stage. With the raw bodies absent, CI gets a
 * labelled skip; everywhere else the gate still fails closed. A skip must read
 * as a skip — never as a pass.
 */
describe('published secret gate local-only policy', () => {
  it('skips, labelled and loud, when the raw bodies are absent on CI — and says absence was NOT proven', () => {
    vi.stubEnv('CI', 'true');
    const result = run(['--bodies', path.join(temporaryDirectory(), 'absent'), '--artifacts', writeArtifacts({ entries: [] })]);
    expect(result.status).toBe(0);
    expect(result.combined).toContain('check:published-secret-leak skipped —');
    expect(result.combined).toContain('Absence of leaked values was NOT proven in this environment');
    expect(result.combined).toContain('local-only by owner policy');
    // The skip is neither verdict, in either spelling.
    expect(result.combined).not.toContain('Published secret gate passed');
    expect(result.combined).not.toContain('Published secret gate failed');
    // Nothing was extracted or swept: the skip happens before the snapshot is read.
    expect(result.combined).not.toContain('candidates:');
  });

  it('still runs the real check on CI when the bodies and the snapshot are present', () => {
    vi.stubEnv('CI', 'true');
    const { bodies, snapshot, artifacts } = fixture({ entries: [] });
    const result = run(['--bodies', bodies, '--snapshot', snapshot, '--artifacts', artifacts]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Published secret gate passed');
    expect(result.stdout).toContain('Positive control: 5/5 planted values detected');
    expect(result.combined).not.toContain('skipped');
  });
});

describe('published secret gate input snapshot', () => {
  it('fails closed when no verified input snapshot is provisioned', () => {
    const result = run(['--bodies', writeBodies(), '--artifacts', writeArtifacts({ entries: [] })]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no verified input snapshot was provisioned');
    expect(result.stderr).toContain('OFFICIAL_BODIES_SNAPSHOT');
    // Nothing was extracted and nothing was swept: the gate stopped before it
    // could report a verdict it was not entitled to make.
    expect(result.combined).not.toContain('Published secret gate passed');
    expect(result.combined).not.toContain('candidates:');
  });

  it('fails closed when a body was swapped out after the snapshot was taken', () => {
    const authorized = writeBodies();
    const snapshot = writeSnapshot(authorized);
    const substituted = writeBodies();
    fs.writeFileSync(
      path.join(substituted, 'official__9999_Synthetic_Gate_Fixture.json'),
      JSON.stringify({ nodes: [{ name: 'HTTP Request', parameters: { url: 'https://example.test' } }] }),
      'utf8',
    );
    const result = run(['--bodies', substituted, '--snapshot', snapshot, '--artifacts', writeArtifacts({ entries: [] })]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match the verified inventory');
    expect(result.stderr).toContain('official__9999_Synthetic_Gate_Fixture.json');
    expect(result.combined).not.toContain('Published secret gate passed');
  });

  it('fails closed when a body was added or removed after the snapshot was taken', () => {
    const bodies = writeBodies();
    const snapshot = writeSnapshot(bodies);
    fs.writeFileSync(path.join(bodies, 'official__9998_Added.json'), '{}', 'utf8');
    const added = run(['--bodies', bodies, '--snapshot', snapshot, '--artifacts', writeArtifacts({ entries: [] })]);
    expect(added.status).toBe(1);
    expect(added.stderr).toContain('not the set the verified inventory authorizes');
    expect(added.stderr).toContain('1 unexpected');

    const trimmed = writeBodies();
    const trimmedSnapshot = writeSnapshot(trimmed);
    fs.rmSync(path.join(trimmed, 'official__9999_Synthetic_Gate_Fixture.json'));
    const removed = run(['--bodies', trimmed, '--snapshot', trimmedSnapshot, '--artifacts', writeArtifacts({ entries: [] })]);
    expect(removed.status).toBe(1);
    expect(removed.stderr).toContain('1 missing');
  });

  it('fails closed on an unreadable body without printing a stack trace', () => {
    const bodies = writeBodies();
    const snapshot = writeSnapshot(bodies);
    fs.mkdirSync(path.join(bodies, 'official__9997_Directory.json'));
    const result = run(['--bodies', bodies, '--snapshot', snapshot, '--artifacts', writeArtifacts({ entries: [] })]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the bodies on disk are not the set the verified inventory authorizes');
    expect(result.combined).not.toMatch(/\n\s+at /);
  });

  it('fails closed when the snapshot is malformed or was never written', () => {
    const bodies = writeBodies();
    const malformed = writeSnapshot(bodies, { inventoryDigest: 'sha256:nothex' });
    const malformedRun = run(['--bodies', bodies, '--snapshot', malformed, '--artifacts', writeArtifacts({ entries: [] })]);
    expect(malformedRun.status).toBe(1);
    expect(malformedRun.stderr).toContain('inventoryDigest');

    const absentRun = run(['--bodies', bodies, '--snapshot', path.join(temporaryDirectory(), 'absent.json'), '--artifacts', writeArtifacts({ entries: [] })]);
    expect(absentRun.status).toBe(1);
    expect(absentRun.stderr).toContain('could not be read (ENOENT)');
  });

  it('takes the provisioned snapshot from the environment when no flag is passed', () => {
    const { bodies, snapshot, artifacts } = fixture({ entries: [] });
    const result = run(['--bodies', bodies, '--artifacts', artifacts], { OFFICIAL_BODIES_SNAPSHOT: snapshot });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Published secret gate passed');
  });

  /**
   * The digest is a precondition, not the check. A matching snapshot must not
   * turn the gate green on its own: the strict value sweep still decides.
   */
  it('does not substitute the digest for the source-value sweep', () => {
    const bodies = writeBodies();
    const snapshot = writeSnapshot(bodies);
    const result = run([
      '--bodies', bodies, '--snapshot', snapshot,
      '--artifacts', writeArtifacts({ entries: [{ id: 'x', security: { header: BASIC_VALUE } }] }),
      '--json',
    ]);
    expect(result.status).toBe(1);
    const summary = JSON.parse(result.stdout);
    expect(summary.inputSnapshot.digest).toBe(inventoryDigest(inventoryEntries(bodies)));
    expect(summary.matches.strict).toBe(1);
    expect(summary.candidates.needlesSwept).toBeGreaterThan(0);
  });

  it('never prints a candidate value, on the green run, the red one, or any snapshot failure', () => {
    const green = fixture({ entries: [] });
    const red = fixture({ entries: [{ id: 'x', value: BASIC_VALUE }] });
    const bodies = writeBodies();
    // A mistyped snapshot: the file holds raw secret text, so `JSON.parse`'s own
    // message would quote the first characters of it if the gate echoed that error.
    const mistyped = path.join(temporaryDirectory(), 'mistyped-snapshot.json');
    fs.writeFileSync(mistyped, BASIC_VALUE, 'utf8');
    const results = [
      run(['--bodies', green.bodies, '--snapshot', green.snapshot, '--artifacts', green.artifacts]),
      run(['--bodies', red.bodies, '--snapshot', red.snapshot, '--artifacts', red.artifacts]),
      run(['--bodies', bodies, '--artifacts', writeArtifacts({ entries: [] })]),
      run(['--bodies', bodies, '--snapshot', writeSnapshot(bodies, { inventoryDigest: `sha256:${'0'.repeat(64)}` }), '--artifacts', writeArtifacts({ entries: [] })]),
      run(['--bodies', bodies, '--snapshot', mistyped, '--artifacts', writeArtifacts({ entries: [] })]),
    ];
    expect(results.map((result) => result.status)).toEqual([0, 1, 1, 1, 1]);
    for (const result of results) {
      for (const value of FIXTURE_VALUES) {
        expect(result.combined).not.toContain(value);
        expect(result.combined).not.toContain(value.slice(0, 10));
        expect(result.combined).not.toContain(Buffer.from(value, 'utf8').toString('base64'));
      }
      expect(result.combined).not.toContain('Unexpected token');
    }
  });
});
