import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { inventoryDigest } from './lib/published-secret-input-inventory.mjs';
import { buildMaintenancePlan, gitInfo, verifyMaintenancePlan, MODULE_ROOT } from './lib/maintenance-plan.mjs';
import { sourceIdentity, dataIdentity } from './lib/maintenance-identity.mjs';
import { writePlanOutput } from './maintenance.mjs';
import { commitCandidateData, runMaintenanceCandidate } from './lib/maintenance-runner.mjs';
import { HELPER_PATHS } from './lib/search-release-contract.mjs';

const temporary = [];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const runtime = { nodeExecutable: process.execPath, nodeVersion: 'v22.17.0', npmExecutable: path.join(os.tmpdir(), 'maintenance-npm-cli.js'), npmVersion: '11.16.0', npmSha256: 'a'.repeat(64) };
const authenticFixture = await readFile(new URL('../app/src/search/__fixtures__/relevance-set.json', import.meta.url));
const searchFixture = 'app/src/search/__fixtures__/relevance-set.json';

async function fixture(mode = 'scanner-rescan') {
  const base = await mkdtemp(path.join(os.tmpdir(), 'hub-maintenance-'));
  temporary.push(base);
  const sourceRoot = path.join(base, 'source');
  const candidateRoot = path.join(base, 'candidate');
  for (const dir of ['app', 'contracts', 'pipeline', 'packages/engine', 'schemas', 'scripts']) await mkdir(path.join(sourceRoot, dir), { recursive: true });
  await writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ workspaces: ['packages/engine'] }));
  await writeFile(path.join(sourceRoot, 'package-lock.json'), '{}');
  for (const name of ['.gitattributes', '.gitignore', 'eslint.config.mjs', 'firebase.json', 'tsconfig.json', 'vitest.config.ts']) await writeFile(path.join(sourceRoot, name), '{}');
  await writeFile(path.join(sourceRoot, 'packages/engine/package.json'), JSON.stringify({ name: '@test/engine' }));
  await writeFile(path.join(sourceRoot, 'scripts/runtime.mjs'), 'export const stable = true;\n');
  await writeFile(path.join(sourceRoot, 'pipeline/sources.json'), '[]');
  for (const relative of [...HELPER_PATHS, 'scripts/lib/search-release-binding.test.mjs']) {
    await mkdir(path.dirname(path.join(sourceRoot, relative)), { recursive: true });
    await cp(path.join(MODULE_ROOT, relative), path.join(sourceRoot, relative));
  }
  await mkdir(path.join(sourceRoot, 'app/src/search/__fixtures__'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'app/src/search/__fixtures__/relevance-set.json'), authenticFixture);
  const artifact = Buffer.from('catalogue bytes\n');
  const manifest = { schemaVersion: 'manifest-v1', generatedAt: '2026-10-27T00:00:00.000Z', totalEntries: 0, artifacts: [{ path: 'catalogue-0.json', byteSize: artifact.byteLength, sha256: sha256(artifact), entryCount: 0 }] };
  await mkdir(path.join(sourceRoot, 'data/scanner'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'data/manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(sourceRoot, 'data/catalogue-0.json'), artifact);
  for (const name of ['advisories-v2.json', 'advisory-quarantine-v1.json', 'calibration-v2-manifest.json']) await writeFile(path.join(sourceRoot, `data/scanner/${name}`), '{}');
  await mkdir(path.join(sourceRoot, 'docs/audit/2026-10-17-remediation'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'docs/audit/2026-10-17-remediation/C1-real-inventory.json'), JSON.stringify({ rows: [] }));
  await cp(sourceRoot, candidateRoot, { recursive: true });
  await mkdir(path.join(candidateRoot, '.git'), { recursive: true });
  await mkdir(path.join(candidateRoot, 'node_modules/@test'), { recursive: true });
  await symlink(path.join(candidateRoot, 'packages/engine'), path.join(candidateRoot, 'node_modules/@test/engine'), 'junction');
  const inputRoot = path.join(base, 'inputs');
  await mkdir(inputRoot, { recursive: true });
  const bodies = path.join(inputRoot, 'bodies');
  await mkdir(bodies);
  await writeFile(path.join(bodies, 'template.json'), '{}');
  const bodyMap = path.join(inputRoot, 'body-map.json');
  await writeFile(bodyMap, JSON.stringify({ rows: [{ templateId: 1, file: 'template.json', sourceDir: bodies, entryId: 'official-1' }], withoutBody: [], refusedBodies: [], orphanBodies: [], counts: { matched: 1 } }));
  const releaseSnapshot = path.join(inputRoot, 'release-inputs.json');
  await writeFile(releaseSnapshot, JSON.stringify({ schemaVersion: 'release-inputs-v1' }));
  const privacyBodies = path.join(inputRoot, 'privacy-bodies');
  await mkdir(privacyBodies);
  const privacyBody = Buffer.from('{"nodes":[]}');
  await writeFile(path.join(privacyBodies, 'official__1_demo.json'), privacyBody);
  const privacyRow = { name: 'official__1_demo.json', bytes: privacyBody.length, sha256: sha256(privacyBody) };
  const privacySnapshot = path.join(inputRoot, 'privacy-inputs.json');
  await writeFile(privacySnapshot, JSON.stringify({ schemaVersion: 1, algorithm: 'sha256', inventoryDigest: inventoryDigest([privacyRow]), fileCount: 1, totalBytes: privacyBody.length, files: [privacyRow] }));
  const releaseRoot = path.join(base, `release-${mode}`);
  const request = { schemaVersion: 'maintenance-request-v1', mode, runId: `test-${mode}`, generatedAt: '2026-10-27T12:00:00.000Z', candidateRoot, bodyMap, bodySources: [bodies], privacyBodies, privacySnapshot, releaseRoot, releaseSnapshot, siteUrl: 'https://example.test', basePath: '/' };
  const git = (root) => ({ root, head: root === candidateRoot ? 'candidate-head' : 'source-head', clean: true, userName: 'Test Maintainer', userEmail: 'test@example.test', dirtyPaths: [], stagedPaths: [] });
  const options = { sourceRoot, scriptRoot: sourceRoot, runtime, git, workspaceLinks: () => [] };
  return { base, sourceRoot, candidateRoot, request, options, runtime, git, releaseRoot };
}

afterEach(async () => { await Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true }))); });

describe('guarded maintenance plans', () => {
  it.runIf(process.platform === 'win32')('rejects a Windows namespace alias into the source release directory', async () => {
    const f = await fixture();
    const releaseRoot = path.toNamespacedPath(path.join(f.sourceRoot, 'release-alias'));
    expect(() => buildMaintenancePlan({ ...f.request, releaseRoot }, f.options)).toThrow(/namespace|canonical|isolated/u);
  });

  it('rejects hard-linked generated candidate icons before any writer runs', async () => {
    const f = await fixture();
    await mkdir(path.join(f.sourceRoot, 'app/app'), { recursive: true });
    await mkdir(path.join(f.candidateRoot, 'app/app'), { recursive: true });
    const original = path.join(f.sourceRoot, 'app/app/favicon.ico');
    await writeFile(original, 'preserve source icon');
    await link(original, path.join(f.candidateRoot, 'app/app/favicon.ico'));
    expect(() => buildMaintenancePlan(f.request, f.options)).toThrow(/hard.link/u);
    expect(await readFile(original, 'utf8')).toBe('preserve source icon');
  });

  it('keeps porcelain status paths intact when the first entry starts with a blank column', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'hub-maintenance-status-')); temporary.push(parent);
    const root = path.join(parent, 'repo'); await mkdir(path.join(root, 'data'), { recursive: true });
    const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout; };
    git('init'); git('config', 'user.name', 'Test Maintainer'); git('config', 'user.email', 'test@example.test');
    await writeFile(path.join(root, 'data/analytics.json'), '{}\n');
    git('add', 'data/analytics.json'); git('commit', '--no-verify', '-m', 'baseline');
    await writeFile(path.join(root, 'data/analytics.json'), '{"changed":true}\n');
    await writeFile(path.join(root, 'data/extra.json'), '{"new":true}\n');
    const info = gitInfo(root);
    expect(info.clean).toBe(false);
    expect(info.dirtyPaths).toEqual(['data/analytics.json', 'data/extra.json']);
  });

  it('commits real candidate data with the reviewed identity despite inherited Git author overrides', async () => {
    const f = await fixture();
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: f.candidateRoot, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    await rm(path.join(f.candidateRoot, '.git'), { recursive: true });
    git('init'); git('config', 'user.name', 'Test Maintainer'); git('config', 'user.email', 'test@example.test');
    git('add', 'data', searchFixture); git('commit', '--no-verify', '-m', 'baseline');
    const plan = { request: f.request, bindings: { candidateGit: { head: git('rev-parse', 'HEAD'), userName: 'Test Maintainer', userEmail: 'test@example.test' } } };
    const runDir = path.join(f.candidateRoot, '.work/commit-test'); const logDir = path.join(runDir, 'logs');
    await mkdir(logDir, { recursive: true });
    await writeFile(path.join(f.candidateRoot, 'data/catalogue-0.json'), 'new generated data');
    await writeFile(path.join(f.candidateRoot, searchFixture), `${authenticFixture.toString('utf8')}\n`);
    const context = {
      root: f.candidateRoot, runDir, logDir, startTime: () => f.request.generatedAt,
      inspectGit: () => ({ ...gitInfo(f.candidateRoot), clean: git('status', '--porcelain', '--', 'data', searchFixture) === '', dirtyPaths: git('diff', '--name-only', 'HEAD', '--', 'data', searchFixture).split('\n').filter(Boolean) }),
      env: { ...process.env, GIT_AUTHOR_NAME: 'Unreviewed Author', GIT_AUTHOR_EMAIL: 'override@example.test', GIT_COMMITTER_NAME: 'Unreviewed Committer', GIT_COMMITTER_EMAIL: 'override@example.test' },
      executeStep: async (step, state) => { const result = spawnSync(step.argv[0], step.argv.slice(1), { cwd: state.root, env: state.env, encoding: 'utf8' }); return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }; },
    };
    const step = { id: 'commit-data', argv: [['git', 'add', '--', 'data', searchFixture], ['git', 'commit', '--no-verify', '-m', 'candidate data']] };
    await commitCandidateData(plan, context, step, {});
    expect(git('show', '-s', '--format=%an|%ae|%cn|%ce|%aI|%cI')).toBe('Test Maintainer|test@example.test|Test Maintainer|test@example.test|2026-10-27T12:00:00Z|2026-10-27T12:00:00Z');
  });

  it('skips known generated source files without rejecting a real source tree', async () => {
    const f = await fixture();
    await mkdir(path.join(f.sourceRoot, 'app/app'), { recursive: true });
    await writeFile(path.join(f.sourceRoot, 'app/app/apple-icon.png'), 'generated icon');
    await writeFile(path.join(f.sourceRoot, 'app/tsconfig.tsbuildinfo'), 'generated types');
    expect(sourceIdentity(f.sourceRoot).sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('binds Git attributes that control byte-preserving data staging', async () => {
    const f = await fixture();
    const before = sourceIdentity(f.sourceRoot).sha256;
    await writeFile(path.join(f.sourceRoot, '.gitattributes'), 'data/** -text\n');
    expect(sourceIdentity(f.sourceRoot).sha256).not.toBe(before);
  });

  it('binds every data file even if its directory name resembles generated source output', async () => {
    const f = await fixture();
    const before = dataIdentity(f.sourceRoot).treeSha256;
    await mkdir(path.join(f.sourceRoot, 'data/out'));
    await writeFile(path.join(f.sourceRoot, 'data/out/extra.json'), '{}');
    expect(dataIdentity(f.sourceRoot).treeSha256).not.toBe(before);
  });

  it('keeps explicit plan output out of live product directories', async () => {
    const f = await fixture();
    const target = path.join(f.sourceRoot, 'data/plan.json');
    expect(() => writePlanOutput(target, '{}', f.sourceRoot)).toThrow(/private|\.work/u);
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(path.join(f.sourceRoot, '.work'));
    const privatePlan = path.join(f.sourceRoot, '.work/reviewed-plan.json');
    writePlanOutput(privatePlan, '{}', f.sourceRoot);
    expect(await readFile(privatePlan, 'utf8')).toBe('{}');
  });

  it.each(['scanner-rescan', 'add-source'])('plans a complete closed %s sequence without writes', async (mode) => {
    const f = await fixture(mode);
    const plan = await buildMaintenancePlan(f.request, f.options);
    expect(plan.schemaVersion).toBe('maintenance-plan-v2');
    expect(plan.steps.map((step) => step.id)).toEqual(mode === 'add-source'
      ? ['acquire', 'seed-scanner-sidecars', 'enrich', 'inventory', 'regenerate', 'promote', 'bind-search-release', 'export', 'release-gates', 'packed-cli', 'commit-data', 'stage-release', 'verify-release']
      : ['inventory', 'regenerate', 'promote', 'bind-search-release', 'export', 'release-gates', 'packed-cli', 'commit-data', 'stage-release', 'verify-release']);
    expect(JSON.stringify(plan.steps)).not.toMatch(/--only|--accept-partial|--activate|deploy|clean/u);
    expect(await readFile(path.join(f.candidateRoot, 'data/catalogue-0.json'), 'utf8')).toBe('catalogue bytes\n');
    await expect(readFile(path.join(f.candidateRoot, '.work/maintenance'))).rejects.toThrow();
  });

  it('rejects an old plan schema and any tampered v2 bind order or transaction link', async () => {
    const f = await fixture(); const plan = await buildMaintenancePlan(f.request, f.options);
    expect(plan.digest).toBe(plan.bindings.searchBinding.transaction.planSha256);
    expect(() => verifyMaintenancePlan({ ...plan, schemaVersion: 'maintenance-plan-v1' }, { ...f.options, scriptRoot: f.candidateRoot })).toThrow(/schema|v2/u);
    const changed = structuredClone(plan); changed.bindings.searchBinding.transaction.attempt = 2;
    expect(() => verifyMaintenancePlan(changed, { ...f.options, scriptRoot: f.candidateRoot })).toThrow(/digest|attempt/u);
    const reordered = structuredClone(plan); const bind = reordered.steps.findIndex((step) => step.id === 'bind-search-release'); [reordered.steps[bind], reordered.steps[bind + 1]] = [reordered.steps[bind + 1], reordered.steps[bind]];
    expect(() => verifyMaintenancePlan(reordered, { ...f.options, scriptRoot: f.candidateRoot })).toThrow(/digest|order/u);
  });

  it('rejects unknown request fields and missing body inputs', async () => {
    const f = await fixture();
    expect(() => buildMaintenancePlan({ ...f.request, previousRun: 'old-run' }, f.options)).toThrow(/unknown/i);
    await rm(path.join(path.dirname(f.request.bodyMap), 'bodies/template.json'));
    expect(() => buildMaintenancePlan(f.request, f.options)).toThrow(/body|input/i);
  });

  it('binds source bytes, lock bytes, data artifacts and external input snapshots before execution', async () => {
    const f = await fixture();
    const plan = await buildMaintenancePlan(f.request, f.options);
    await writeFile(path.join(f.candidateRoot, 'package-lock.json'), '{"changed":true}');
    const executeStep = async () => { throw new Error('subprocess must not run after drift'); };
    await expect(runMaintenanceCandidate(plan, { ...f.options, scriptRoot: f.candidateRoot, executeStep })).rejects.toThrow(/digest|drift|mismatch|identity|source\/config/i);
  });

  it('refuses baseline data drift before starting a subprocess', async () => {
    const f = await fixture();
    const plan = await buildMaintenancePlan(f.request, f.options);
    await writeFile(path.join(f.candidateRoot, 'data/catalogue-0.json'), 'changed baseline bytes\n');
    const executeStep = async () => { throw new Error('subprocess must not run after data drift'); };
    await expect(runMaintenanceCandidate(plan, { ...f.options, scriptRoot: f.candidateRoot, executeStep })).rejects.toThrow(/manifest|data artifact|digest|drift/i);
  });

  it('refuses pre-existing generated build output instead of overwriting it', async () => {
    const f = await fixture();
    const staleOutput = path.join(f.candidateRoot, 'app/out');
    await mkdir(staleOutput, { recursive: true });
    await writeFile(path.join(staleOutput, 'preserve-me.txt'), 'existing evidence');
    expect(() => buildMaintenancePlan(f.request, f.options)).toThrow(/app\/out build output path already exists/u);
    await expect(readFile(path.join(staleOutput, 'preserve-me.txt'), 'utf8')).resolves.toBe('existing evidence');
  });

  it('refuses a candidate whose declared workspace link resolves into the source repository', async () => {
    const f = await fixture();
    await rm(path.join(f.candidateRoot, 'node_modules/@test/engine'), { recursive: true, force: true });
    await symlink(path.join(f.sourceRoot, 'packages/engine'), path.join(f.candidateRoot, 'node_modules/@test/engine'), 'junction');
    const options = { ...f.options }; delete options.workspaceLinks;
    expect(() => buildMaintenancePlan(f.request, options)).toThrow(/escapes the candidate/u);
  });

  it('refuses a workspace dependency link aimed at the wrong internal directory', async () => {
    const f = await fixture();
    await rm(path.join(f.candidateRoot, 'node_modules/@test/engine'), { recursive: true, force: true });
    await symlink(path.join(f.candidateRoot, 'app'), path.join(f.candidateRoot, 'node_modules/@test/engine'), 'junction');
    const options = { ...f.options }; delete options.workspaceLinks;
    expect(() => buildMaintenancePlan(f.request, options)).toThrow(/declared candidate workspace/u);
  });

  it('refuses an existing candidate lock without replacing it', async () => {
    const f = await fixture(); const plan = await buildMaintenancePlan(f.request, f.options);
    const lock = path.join(f.candidateRoot, '.work/maintenance/maintenance.lock');
    await mkdir(path.dirname(lock), { recursive: true }); await writeFile(lock, 'owned by another run');
    const executeStep = async () => { throw new Error('subprocess must not run while locked'); };
    await expect(runMaintenanceCandidate(plan, { ...f.options, scriptRoot: f.candidateRoot, executeStep })).rejects.toThrow(/lock/i);
    await expect(readFile(lock, 'utf8')).resolves.toBe('owned by another run');
  });

  it.each(['scanner-rescan', 'add-source'])('runs the reviewed %s sequence in the candidate and never activates', async (mode) => {
    const f = await fixture(mode);
    const plan = await buildMaintenancePlan(f.request, f.options);
    const completed = []; let staged = false; let committed = false; let bindingReceipt;
    const dirtyPaths = ['data/catalogue-0.json', searchFixture];
    const result = await runMaintenanceCandidate(plan, {
      ...f.options,
      scriptRoot: f.candidateRoot,
      executeStep: async (step, context) => {
        const pathKey = Object.keys(context.env).find((key) => key.toLowerCase() === 'path');
        expect(context.env[pathKey].split(path.delimiter)[0]).toBe(path.dirname(runtime.nodeExecutable));
        completed.push(step.id);
        if (step.id === 'commit-data-1') staged = true;
        if (step.id === 'commit-data-2') committed = true;
        return { exitCode: 0, stdout: step.id === 'stage-release' ? '{"releaseId":"release-123"}' : step.id === 'verify-release' ? '{"status":"verified","releaseId":"release-123"}' : '' };
      },
      inspectGit: async (root) => root === f.sourceRoot ? f.git(root) : ({ root, head: committed ? 'after-commit' : 'candidate-head', parents: committed ? ['candidate-head'] : [], clean: committed, userName: 'Test Maintainer', userEmail: 'test@example.test', dirtyPaths: committed ? [] : dirtyPaths, stagedPaths: staged && !committed ? dirtyPaths : [] }),
      executeGitStep: async (step) => {
        if (step.id === 'commit-data-1') staged = true;
        if (step.id === 'commit-data-2') committed = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      searchBinding: {
        bind: async (binding) => {
          const bytes = Buffer.from(`${authenticFixture.toString('utf8')}\n`);
          await writeFile(path.join(f.candidateRoot, searchFixture), bytes);
          bindingReceipt = { transaction: binding.transaction, helper: plan.bindings.searchBinding.helper.slice(0, 5), generated: { fixtureSha256: sha256(bytes) } };
          return bindingReceipt;
        },
        verify: () => ({ receipt: bindingReceipt, receiptSha256: 'b'.repeat(64), release: { releaseId: 'test-release' }, dataIdentity: {}, paths: { receipt: plan.bindings.searchBinding.receiptPath } }),
      },
      startTime: () => '2026-10-27T12:00:00.000Z',
    });
    const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
    expect(staged).toBe(true); expect(committed).toBe(true);
    expect(receipt.steps.map((step) => step.id)).toEqual(plan.steps.map((step) => step.id));
    expect(result.status).toBe('candidate-verified');
    expect(result.releaseId).toBe('release-123');
    expect(completed).not.toContain('activate');
    expect(await readFile(path.join(f.candidateRoot, 'data/catalogue-0.json'), 'utf8')).toBe('catalogue bytes\n');
  });

  it('stops on the first failed step, leaves failure evidence and releases only its lock', async () => {
    const f = await fixture();
    const plan = await buildMaintenancePlan(f.request, f.options);
    const completed = [];
    await expect(runMaintenanceCandidate(plan, {
      ...f.options,
      scriptRoot: f.candidateRoot,
      executeStep: async (step) => { completed.push(step.id); return { exitCode: step.id === 'regenerate' ? 1 : 0, stdout: '', stderr: 'controlled failure' }; },
      inspectGit: f.git,
      startTime: () => '2026-10-27T12:00:00.000Z',
    })).rejects.toThrow(/regenerate/i);
    expect(completed).toEqual(['inventory', 'regenerate']);
    await expect(readFile(path.join(f.candidateRoot, '.work/maintenance/maintenance.lock'))).rejects.toThrow();
    const receipt = JSON.parse(await readFile(path.join(f.candidateRoot, `.work/maintenance/${f.request.runId}/receipt.json`), 'utf8'));
    expect(receipt.status).toBe('failed');
    expect(receipt.steps.at(-1)).toMatchObject({ id: 'regenerate', status: 'failed' });
  });
});
