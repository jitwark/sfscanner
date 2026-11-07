import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATE_SEQUENCES } from './run-gates.mjs';
import { INVENTORY_ALGORITHM, INVENTORY_SCHEMA_VERSION, inventoryDigest } from './lib/published-secret-input-inventory.mjs';
import { assertCleanTree, assertWriterMode, readInputInventory, readOptionalArtifacts, readTreeState } from './lib/release-descriptor.mjs';
import { GENERATIONS, writeDrillSnapshot, writeGeneration } from './lib/release-rehearsal-fixture.mjs';
import { verifyRelease } from './release-verify.mjs';
import { stageRelease } from './stage-release.mjs';

/**
 * The release descriptor writer is a host-operator command, not a build step: `npm run
 * gates` must never reach it, and it must refuse to run without the explicit mode. These
 * cases hold that boundary, plus the invariant the descriptor exists for — a verified
 * release stops verifying the moment one bound byte moves.
 *
 * The staging and verification cases inject the environment (tree, tools, input
 * inventory) rather than reading it, so they prove the descriptor logic without
 * requiring the developer's own tree to be clean; the CLI refusal below proves the
 * production path still demands `--mode release`.
 */
const repoRoot = path.resolve(import.meta.dirname, '..');
const WRITER_SCRIPTS = ['stage-release.mjs', 'export-public-dataset.ts', 'rehearse-release-rollback.mjs', 'rollback-release.mjs'];
const AUTHORIZED_WRITER_SCRIPTS = new Set(['stage:release', 'export:public-dataset', 'rehearse:release-rollback', 'rollback:release']);
const CLEAN_TREE = Object.freeze({ commit: 'a'.repeat(40), clean: true, dirty: false, dirtyFiles: [] });
const TOOLS = Object.freeze({ node: 'v22.0.0', npm: '10.0.0', lockfile: Object.freeze({ path: 'package-lock.json', sha256: 'f'.repeat(64), byteSize: 1, lockfileVersion: 3 }) });

let workRoot = '';
let generation = null;
let snapshot = null;
let environment = null;
let releaseId = '';

const verify = (releaseIdToCheck, generationToUse, snapshotToUse, env = environment) => verifyRelease({
  root: path.join(workRoot, 'root'),
  releaseId: releaseIdToCheck,
  site: generationToUse.site, data: generationToUse.data, export: generationToUse.export,
  snapshotPath: snapshotToUse.path, environment: env,
});

beforeAll(async () => {
  workRoot = await mkdtemp(path.join(os.tmpdir(), 'release-descriptor-'));
  snapshot = await writeDrillSnapshot(path.join(workRoot, 'official-bodies-snapshot.json'));
  generation = await writeGeneration(path.join(workRoot, 'generation'), GENERATIONS.current);
  await mkdir(path.join(workRoot, 'root'), { recursive: true });
  environment = Object.freeze({
    tree: CLEAN_TREE,
    tools: TOOLS,
    inputs: await readInputInventory(repoRoot, snapshot.path),
    optionalArtifacts: await readOptionalArtifacts(repoRoot),
  });
  const staged = await stageRelease({
    root: path.join(workRoot, 'root'), site: generation.site, data: generation.data, export: generation.export,
    snapshotPath: snapshot.path, activate: true, mode: 'release', environment,
  });
  releaseId = staged.releaseId;
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe('release descriptor writer authority', () => {
  it('is absent from every gate sequence, including the default one', () => {
    for (const [mode, commands] of Object.entries(GATE_SEQUENCES)) {
      for (const command of commands) {
        expect(command, `the ${mode} sequence must not run a release writer`).not.toMatch(/^(stage|export|rehearse|rollback):release|release:(stage|export|rehearse|rollback)/u);
      }
    }
    expect(GATE_SEQUENCES.gates).not.toContain('stage:release');
    expect(Object.values(GATE_SEQUENCES).flat()).not.toContain('export:public-dataset');
  });

  it('is reachable from no other package script', async () => {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    for (const [name, command] of Object.entries(manifest.scripts)) {
      if (AUTHORIZED_WRITER_SCRIPTS.has(name)) continue;
      for (const script of WRITER_SCRIPTS) {
        expect(command.includes(script), `${name} must not run the release writer ${script}`).toBe(false);
      }
    }
    expect(manifest.scripts['stage:release']).toContain('--mode release');
    expect(manifest.scripts['verify:release']).toBe('node scripts/release-verify.mjs');
  });

  it('refuses to write without --mode release', () => {
    for (const args of [['--root', path.join(workRoot, 'root')], ['--mode', 'dry-run', '--root', path.join(workRoot, 'root')]]) {
      const refusal = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'stage-release.mjs'), ...args], { cwd: repoRoot, encoding: 'utf8' });
      expect(refusal.status).not.toBe(0);
      expect(refusal.stderr).toContain('--mode release');
    }
    expect(() => assertWriterMode(undefined)).toThrow(/--mode release/u);
    expect(() => assertWriterMode('release')).not.toThrow();
  });

  it('refuses a dirty tree and declares the change it found', () => {
    expect(() => assertCleanTree({ commit: 'a'.repeat(40), clean: false, dirty: true, dirtyFiles: ['data/catalogue-0.json'] }))
      .toThrow(/dirty.*data\/catalogue-0\.json/u);
    expect(() => assertCleanTree({ commit: 'a'.repeat(40), clean: true, dirty: false, dirtyFiles: [] })).not.toThrow();
    expect(() => assertCleanTree(undefined)).toThrow(/dirty-tree declaration/u);
    const tree = readTreeState(repoRoot);
    expect(tree.commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(tree.clean).toBe(tree.dirtyFiles.length === 0);
  });
});

describe('release verification', () => {
  const stageInactive = async () => {
    const root = await mkdtemp(path.join(workRoot, 'inactive-'));
    const staged = await stageRelease({ root, site: generation.site, data: generation.data, export: generation.export,
      snapshotPath: snapshot.path, activate: false, mode: 'release', environment });
    const options = { root, releaseId: staged.releaseId, site: generation.site, data: generation.data,
      export: generation.export, snapshotPath: snapshot.path, environment };
    return { root, options };
  };

  it('verifies an explicit staged release without creating or requiring an active pointer', async () => {
    const { root, options } = await stageInactive();
    const result = await verifyRelease(options);
    expect(result.status).toBe('verified');
    expect(result.activeRelease).toBeNull();
    expect(result.activeIsVerified).toBe(false);
    await expect(readFile(path.join(root, 'active-release.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still requires an active pointer when no explicit staged release is selected', async () => {
    const { options } = await stageInactive();
    await expect(verifyRelease({ ...options, releaseId: undefined })).rejects.toThrow(/pointer/u);
  });

  it('refuses a malformed existing pointer even when an explicit release is selected', async () => {
    const { root, options } = await stageInactive();
    await writeFile(path.join(root, 'active-release.json'), '{broken');
    await expect(verifyRelease(options)).rejects.toThrow(/JSON|pointer/u);
  });

  it('verifies the staged release from its own source inputs', async () => {
    const value = await verify(releaseId, generation, snapshot);
    expect(value.status).toBe('verified');
    expect(value.releaseId).toBe(releaseId);
    expect(value.artifacts.map((artifact) => artifact.name)).toEqual(['site', 'data', 'export']);
    expect(value.artifacts.map((artifact) => artifact.rightsScope)).toEqual(['published-site-pages', 'public-catalogue-and-search-metadata', 'redistributable-only-projection']);
    expect(value.inputs.inventoryDigest).toBe(snapshot.inventoryDigest);
    expect(value.activeRelease).toBe(releaseId);
    expect(value.rollbackIdentity.unit).toBe('site+data+export');
    expect(value.rollbackIdentity.restore.join('+')).toBe('data+export+site');
    expect(value.coverage.data.declaredFiles).toBe(5);
    expect(value.coverage.export.declaredFiles).toBe(9);
    expect(value.coverage.export.shards).toBe(1);
    expect(value.coverage.site.noindex).toBe(true);
  });

  it('fails on a single mutated byte of a released artifact', async () => {
    const target = path.join(workRoot, 'root', 'releases', releaseId, 'data', 'manifest.json');
    const original = await readFile(target);
    await writeFile(target, Buffer.concat([original, Buffer.from('\n', 'utf8')]));
    await expect(verify(releaseId, generation, snapshot)).rejects.toThrow(/hash or byte size mismatch|package hash mismatch/u);
    await writeFile(target, original);
    await expect(verify(releaseId, generation, snapshot)).resolves.toMatchObject({ status: 'verified' });
  });

  it('fails on a single mutated byte of a source input', async () => {
    const target = path.join(generation.data, 'catalogue-0.json');
    const original = await readFile(target);
    await writeFile(target, Buffer.concat([original, Buffer.from('\n', 'utf8')]));
    await expect(verify(releaseId, generation, snapshot)).rejects.toThrow(/corpus is not the current corpus input/u);
    await writeFile(target, original);
  });

  it('fails when the input inventory is not the one the descriptor bound', async () => {
    const entries = [{ name: 'official__1_drill-alpha.json', bytes: 5, sha256: 'a'.repeat(64) }];
    const other = path.join(workRoot, 'other-snapshot.json');
    await writeFile(other, `${JSON.stringify({ schemaVersion: INVENTORY_SCHEMA_VERSION, algorithm: INVENTORY_ALGORITHM, inventoryDigest: inventoryDigest(entries), fileCount: 1, totalBytes: 5, files: entries })}\n`, 'utf8');
    const inputs = await readInputInventory(repoRoot, other);
    await expect(verify(releaseId, generation, { path: other }, { ...environment, inputs })).rejects.toThrow(/does not describe this tree/u);
  });
});
