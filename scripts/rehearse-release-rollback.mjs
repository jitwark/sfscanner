/**
 * Rehearse promotion and rollback of the site and the corpus **together**, on local
 * generations, outside the repository. Two real releases are staged (site, corpus and
 * dataset all change between them), the pointer moves forward, a tampered rollback target
 * is proven to be refused with the pointer unmoved, the pointer is rolled back, and the
 * restored release is re-verified — including that the restored deep link resolves and
 * that the immutable asset it references is the very file the descriptor bounds.
 *
 * This is a **local rehearsal**. It proves the operation and the restored unit's internal
 * consistency on this host's filesystem. It is not host verification: cache and range
 * behaviour, edge headers and the noindex preview are unperformed, and `hostSteps` names
 * exactly what an operator must run on a real noindex preview.
 *
 * Usage: node scripts/rehearse-release-rollback.mjs [--root <dir>] [--keep] [--report <file>]
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonFile, record } from './lib/release-artifacts.mjs';
import { assert, assertRestoredUnit, HOST_STEPS } from './lib/release-rehearsal-checks.mjs';
import { GENERATIONS, writeDrillSnapshot, writeGeneration } from './lib/release-rehearsal-fixture.mjs';
import { POINTER_FILE } from './lib/release-schemas.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function runNode(script, args) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', script), ...args], { cwd: repoRoot, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function activeRelease(root) {
  const text = await readFile(path.join(root, POINTER_FILE), 'utf8').catch(() => null);
  return text === null ? null : JSON.parse(text);
}

async function releaseIds(root) {
  return (await readdir(path.join(root, 'releases'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/** Path-to-size for every released file, so a rollback that touched a release is visible. */
async function snapshotTree(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await snapshotTree(root, child));
    else files.push(`${child.replaceAll(path.sep, '/')} ${String((await stat(path.join(root, child))).size)}`);
  }
  return files.sort();
}

async function readReleaseValue(root, releaseId) {
  const { value } = await jsonFile(path.join(root, 'releases', releaseId, 'release.json'), 'release record', true);
  if (!record(value)) fail(`release ${releaseId} has no usable release record`);
  return value;
}

export async function rehearse({ root: requested, keep = false }) {
  const root = path.resolve(requested);
  const relative = path.relative(repoRoot, root);
  assert(relative.startsWith('..') || path.isAbsolute(relative), 'the rehearsal root must be outside the repository');
  await mkdir(root, { recursive: true });
  const steps = [];
  const step = (name, started, detail) => steps.push({ name, ms: Date.now() - started, detail });
  const startedAll = Date.now();

  let started = Date.now();
  const generationsRoot = path.join(root, 'generations');
  const snapshot = await writeDrillSnapshot(path.join(generationsRoot, 'official-bodies-snapshot.json'));
  const prior = await writeGeneration(path.join(generationsRoot, 'prior'), GENERATIONS.prior);
  const current = await writeGeneration(path.join(generationsRoot, 'current'), GENERATIONS.current);
  step('write two local generations (site, corpus and dataset all differ) and a drill input inventory', started, `snapshot ${snapshot.inventoryDigest}`);

  const stage = (generation) => runNode('stage-release.mjs', [
    '--mode', 'release', '--root', root,
    '--site', generation.site, '--data', generation.data, '--export', generation.export,
    '--snapshot', snapshot.path, '--activate',
  ]);
  started = Date.now();
  const priorStage = stage(prior);
  assert(priorStage.status === 0, `staging the prior release failed: ${priorStage.stderr || priorStage.stdout}`);
  const priorId = (await activeRelease(root))?.releaseId ?? '';
  assert(priorId !== '', 'the prior staging did not activate a release');
  step('stage the prior generation and activate it', started, priorStage.stdout);

  started = Date.now();
  const currentStage = stage(current);
  assert(currentStage.status === 0, `staging the current release failed: ${currentStage.stderr || currentStage.stdout}`);
  const currentId = (await activeRelease(root))?.releaseId ?? '';
  assert(currentId !== '' && currentId !== priorId, 'the current staging did not produce a second release');
  const priorValue = await readReleaseValue(root, priorId);
  const currentValue = await readReleaseValue(root, currentId);
  assert(priorValue.identity.corpus.corpusId === GENERATIONS.prior.corpusId, 'the prior release does not carry the prior corpus');
  assert(currentValue.identity.corpus.corpusId === GENERATIONS.current.corpusId, 'the current release does not carry the current corpus');
  step('stage the current generation and move the pointer forward to it', started, currentStage.stdout);

  const before = await snapshotTree(path.join(root, 'releases'));

  started = Date.now();
  const target = path.join(root, 'releases', priorId, 'site', 'index.html');
  const original = await readFile(target);
  await writeFile(target, Buffer.concat([original, Buffer.from('<!--drill-->\n', 'utf8')]));
  const bad = runNode('rollback-release.mjs', ['--release-root', root, '--release-id', priorId]);
  const pointerAfterBad = (await activeRelease(root))?.releaseId ?? '';
  await writeFile(target, original);
  assert(bad.status !== 0, 'the rollback accepted a tampered target release');
  assert(pointerAfterBad === currentId, 'the refused rollback still moved the pointer');
  step('roll back to the tampered target (must be refused, pointer unmoved)', started, `exit ${String(bad.status)}: ${bad.stderr}`);

  started = Date.now();
  const rollback = runNode('rollback-release.mjs', ['--release-root', root, '--release-id', priorId]);
  assert(rollback.status === 0, `the rollback failed: ${rollback.stderr || rollback.stdout}`);
  const pointerAfter = (await activeRelease(root))?.releaseId ?? '';
  assert(pointerAfter === priorId, 'the rollback did not restore the prior release');
  step('roll back to the restored prior release', started, rollback.stdout);

  started = Date.now();
  const verified = runNode('release-verify.mjs', [
    '--root', root, '--release-id', priorId,
    '--site', prior.site, '--data', prior.data, '--export', prior.export,
    '--snapshot', snapshot.path, '--json',
  ]);
  assert(verified.status === 0, `verifying the restored release failed: ${verified.stderr || verified.stdout}`);
  const verifiedValue = JSON.parse(verified.stdout);
  assert(verifiedValue.releaseId === priorId, 'the verifier reported a different release than the restored one');
  step('re-verify the restored release from its source inputs', started, `${String(verifiedValue.artifacts.length)} declared artifact families, ${String(verifiedValue.coverage.export.shards)} ndjson shard(s)`);

  started = Date.now();
  await assertRestoredUnit({ root, releaseValue: priorValue, releaseId: priorId, generation: prior, other: current });
  const after = await snapshotTree(path.join(root, 'releases'));
  const changed = after.filter((entry, index) => entry !== before[index]);
  assert(changed.length === 0, `the rollback rewrote released bytes: ${changed.join(', ')}`);
  assert(currentValue.rollbackIdentity.previousReleaseId === priorId && currentValue.rollbackIdentity.previousSequence === priorValue.sequence,
    'the current release does not point back at the prior release');
  step('check the restored unit: deep link, immutable asset reference, corpus identity, and untouched released bytes', started, `deep link ${prior.deepLink}; asset ${prior.assetPath}`);

  const summary = {
    root,
    kept: keep,
    scope: 'local-rehearsal',
    hostVerification: 'unperformed',
    hostSteps: HOST_STEPS,
    priorReleaseId: priorId,
    currentReleaseId: currentId,
    activeReleaseId: pointerAfter,
    releases: await releaseIds(root),
    releasedFiles: after.length,
    restoredReleaseChangedFiles: changed.map((entry) => entry.split(' ')[0]),
    steps,
    elapsedMs: Date.now() - startedAll,
  };
  if (!keep) await rm(root, { recursive: true, force: true });
  return summary;
}

const USAGE = 'usage: rehearse-release-rollback [--root <dir>] [--keep] [--report <file>]';

/** Throws like every other release command, so one catch block owns the refusal path. */
function parseArgs(argv) {
  const values = { keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep') { values.keep = true; continue; }
    if (flag === '--help' || flag === '-h') return null;
    if (flag !== '--root' && flag !== '--report') fail(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail(`${flag} requires a value`);
    values[flag.slice(2)] = value;
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`rehearse-release-rollback refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
  if (args === undefined) {
    process.exitCode = 1;
  } else if (args === null) {
    console.log(USAGE);
  } else {
    try {
      const summary = await rehearse({
        root: args.root ?? path.join(os.tmpdir(), `sfscanner-release-rehearsal-${String(process.pid)}`),
        keep: args.keep,
      });
      if (args.report !== undefined) {
        const report = path.resolve(args.report);
        await mkdir(path.dirname(report), { recursive: true });
        await writeFile(report, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
      }
      console.log(`rehearsal root: ${summary.root}${summary.kept ? ' (kept)' : ' (removed)'}; scope: ${summary.scope} (host verification ${summary.hostVerification})`);
      console.log(`releases: ${summary.releases.join(', ')}`);
      console.log(`pointer: ${summary.currentReleaseId} -> rolled back to ${summary.activeReleaseId}`);
      for (const entry of summary.steps) console.log(`\n[${String((entry.ms / 1000).toFixed(1))}s] ${entry.name}\n  ${entry.detail.split('\n').join('\n  ')}`);
      console.log(`\nreleased files: ${String(summary.releasedFiles)}; released bytes rewritten by the rollback: ${summary.restoredReleaseChangedFiles.length === 0 ? 'none' : summary.restoredReleaseChangedFiles.join(', ')}`);
      console.log('\nunperformed on a host (run these on a real noindex preview):');
      for (const entry of summary.hostSteps) console.log(`  - ${entry}`);
      console.log(`\ntotal rehearsal: ${String((summary.elapsedMs / 1000).toFixed(1))}s`);
    } catch (error) {
      console.error(`rehearsal failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
