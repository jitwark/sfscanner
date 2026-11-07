import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import MiniSearch from 'minisearch';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEARCH_FIELDS, SEARCH_STORE_FIELDS } from '../../contracts/search-config.ts';
import { parseSearchIndexJson } from '../../contracts/search-index-artifact.ts';
import {
  APPROVED_FIXTURE_PATH, HELPER_PATHS, REQUIRED_SEARCH_ARTIFACTS, cohortSha256, readRelevanceFixture,
} from './search-release-contract.mjs';
import { deriveSearchRelease } from './search-release-data.mjs';
import { verifySearchReleaseReceipt } from './search-release-binding.mjs';
import { dataIdentity, sourceIdentity } from './maintenance-identity.mjs';
import { inventoryDigest } from './published-secret-input-inventory.mjs';
import { buildMaintenancePlan, gitInfo } from './maintenance-plan.mjs';
import { collectV2ScannerSourceFiles } from '../../pipeline/scan/v2-source-files.ts';
import { computeEffectiveConfigDigest, computeSourceBuildDigest } from '../../pipeline/scan/v2-source-receipt.ts';
import {
  SEARCH_BINDING_ALLOWED_FIXTURE, SEARCH_BINDING_COHORT_SHA256, SEARCH_BINDING_RECEIPT_NAME,
  assertCandidateChangePaths, assertExactDirtyStaged, assertHelperClosure, assertPostBindSource,
  bindMaintenanceSearchRelease, sealMaintenancePlan, verifyMaintenancePlanLink,
  verifyMaintenanceSearchRelease,
} from './maintenance-search-binding.mjs';
import { commitCandidateData, runMaintenanceCandidate } from './maintenance-runner.mjs';

const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/(.:)/u, '$1'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const writeJson = (file, value) => writeFileSync(file, json(value));
const fixturePath = (root) => path.join(root, SEARCH_BINDING_ALLOWED_FIXTURE);
const artifactPath = (root, name) => path.join(root, 'data', name);
const authenticBytes = readFileSync(path.join(REPO_ROOT, APPROVED_FIXTURE_PATH));
const authentic = readRelevanceFixture(JSON.parse(authenticBytes));
const runtime = {
  nodeExecutable: process.execPath, nodeVersion: 'v22.17.0',
  npmExecutable: path.join(os.tmpdir(), 'maintenance-npm-cli.js'), npmVersion: '11.16.0', npmSha256: 'a'.repeat(64),
};

function encodeBitset(total, indices) {
  const bytes = Buffer.alloc(Math.ceil(total / 32) * 4);
  for (const index of indices) {
    const offset = (index >> 5) * 4;
    bytes.writeUInt32LE((bytes.readUInt32LE(offset) | (1 << (index & 31))) >>> 0, offset);
  }
  return bytes.toString('base64');
}

function slug(value) {
  return value.trim().toLowerCase().replace(/[_\s]+/gu, '-').replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-+/gu, '-').replace(/^-|-$/gu, '');
}

function facetKey(filter, value) {
  const normalized = slug(value);
  if (filter === 'grade') return `grade:${normalized.toUpperCase()}`;
  if (filter === 'rights') return `rights:${normalized === 'link-only' || normalized === 'linkonly' ? 'link_only' : normalized}`;
  return `${filter}:${normalized}`;
}

function document(id, mode) {
  return {
    id, slug: `slug-${id}`, title: `Workflow ${id}`, summary: `Summary ${mode} for ${id}`,
    tags: ['automation'], integrations: ['slack', 'google-sheets'], triggers: ['manual'],
    capabilities: ['code', 'ai'], grade: 'LOW', rights: 'link_only', complexity: 'simple',
    nodeCount: 1, sourceRepo: 'owner/repo', descriptionSource: 'upstream',
    isIndexable: true, isPrerendered: false, content: `Searchable workflow ${id} automation`,
  };
}

function indexArtifact(ids, mode) {
  const index = new MiniSearch({ fields: [...SEARCH_FIELDS], storeFields: [...SEARCH_STORE_FIELDS] });
  index.addAll(ids.map((id) => document(id, mode)));
  return JSON.parse(JSON.stringify(index));
}

function writeData(root, mode, cases) {
  const data = path.join(root, 'data');
  mkdirSync(data, { recursive: true });
  const ids = [...new Set(cases.flatMap((item) => item.expected.map((judgment) => judgment.id)))];
  const selected = new Map();
  for (const testCase of cases) for (const [filter, raw] of Object.entries(testCase.filters ?? {})) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      const key = facetKey(filter, value);
      const ordinals = selected.get(key) ?? new Set();
      for (const judgment of testCase.expected) ordinals.add(ids.indexOf(judgment.id));
      selected.set(key, ordinals);
    }
  }
  const artifacts = {
    'search-index.json': Buffer.from(json(indexArtifact(ids, mode))),
    'search-index-extended.json': Buffer.from(json(indexArtifact([], `${mode}-extended`))),
    'facets.json': Buffer.from(json({
      total: ids.length,
      counts: { rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: {}, tags: {} },
      facets: [], bitsets: Object.fromEntries([...selected].map(([key, values]) => [key, encodeBitset(ids.length, values)])),
      ordinals: ids,
    })),
    'semantic-index.json': Buffer.from(json({
      version: 1, dimensions: 96, ordinals: [],
      documents: ids.map((id) => ({ id, vector: Array(96).fill(mode === 'candidate' ? 0.5 : 0.25) })),
    })),
  };
  for (const [name, bytes] of Object.entries(artifacts)) writeFileSync(artifactPath(root, name), bytes);
  const generatedAt = mode === 'candidate' ? '2026-10-31T01:02:03.000Z' : '2026-10-26T00:00:00.000Z';
  const metadata = { corpusId: mode === 'candidate' ? 'data-v2' : 'baseline-data', corpusSha256: (mode === 'candidate' ? 'c' : 'b').repeat(64), generatedAt };
  writeJson(artifactPath(root, 'manifest.json'), {
    schemaVersion: 'manifest-v1', generatedAt, totalEntries: ids.length, catalogueShards: { all: ids.length },
    artifacts: Object.entries(artifacts).map(([name, bytes]) => ({ path: name, byteSize: bytes.length, sha256: sha256(bytes) })), metadata,
  });
  writeFileSync(path.join(data, 'analytics.json'), json({ mode, owner: 'complete-tree' }));
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function repository(root, cases, consumer = false) {
  for (const dir of ['app', 'contracts', 'pipeline', 'packages/engine', 'schemas', 'scripts/lib']) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/engine'] }));
  writeFileSync(path.join(root, 'package-lock.json'), '{}');
  writeFileSync(path.join(root, '.gitignore'), '/.work/\n/node_modules/\n/app/out/\n/app/public/data/\n');
  for (const name of ['.gitattributes', 'eslint.config.mjs', 'firebase.json', 'tsconfig.json', 'vitest.config.ts']) writeFileSync(path.join(root, name), '{}\n');
  writeFileSync(path.join(root, 'packages/engine/package.json'), JSON.stringify({ name: '@test/engine' }));
  writeFileSync(path.join(root, 'scripts/runtime.mjs'), 'export const stable = true;\n');
  writeFileSync(path.join(root, 'pipeline/sources.json'), '[]\n');
  for (const relative of [
    'pipeline/build-corpus.ts', 'pipeline/corpus/scan-stage.ts', 'pipeline/scan/v2-fast-forward.ts',
    'pipeline/scan/v2-source-receipt.ts', 'pipeline/scan/v2-corpus-adapter.ts', 'pipeline/scan/v2-security-summary.ts',
    'packages/scanner-core/src/v2/scan-workflow.ts', 'contracts/scanner-v2-result.ts',
    'pipeline/package.json', 'pipeline/tsconfig.json', 'pipeline/config/n8n-compatibility-target.json',
    'packages/scanner-core/package.json', 'packages/scanner-core/tsconfig.json',
    'contracts/package.json', 'contracts/tsconfig.json',
  ]) { mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), `export const fixture = '${relative}';\n`); }
  mkdirSync(path.join(root, 'docs/audit/2026-10-17-remediation'), { recursive: true });
  writeFileSync(path.join(root, 'docs/audit/2026-10-17-remediation/C1-real-inventory.json'), JSON.stringify({ rows: [] }));
  mkdirSync(path.dirname(fixturePath(root)), { recursive: true });
  writeFileSync(fixturePath(root), authenticBytes);
  for (const relative of [...HELPER_PATHS, 'scripts/lib/search-release-binding.test.mjs']) {
    const target = path.join(root, relative); mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(REPO_ROOT, relative), target);
  }
  if (consumer) {
    cpSync(path.join(REPO_ROOT, 'app/src'), path.join(root, 'app/src'), { recursive: true });
    cpSync(path.join(REPO_ROOT, 'contracts'), path.join(root, 'contracts'), { recursive: true, filter: (file) => !['node_modules', '.types'].includes(path.basename(file)) });
    copyFileSync(path.join(REPO_ROOT, 'scripts/evaluate-search.ts'), path.join(root, 'scripts/evaluate-search.ts'));
    symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  }
  writeData(root, 'baseline', cases);
  mkdirSync(path.join(root, 'data/scanner'), { recursive: true });
  for (const name of ['advisories-v2.json', 'advisory-quarantine-v1.json', 'calibration-v2-manifest.json']) writeFileSync(path.join(root, 'data/scanner', name), '{}\n');
  git(root, 'init'); git(root, 'config', 'user.name', 'Test Maintainer'); git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'add', '.'); git(root, 'commit', '--no-verify', '-m', 'baseline');
}

async function harness(mode = 'scanner-rescan', consumer = false) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'maintenance-search-binding-'));
  temporary.push(base);
  const sourceRoot = path.join(base, 'source'); const candidateRoot = path.join(base, 'candidate');
  mkdirSync(sourceRoot); mkdirSync(candidateRoot); repository(sourceRoot, authentic.cases, consumer); repository(candidateRoot, authentic.cases, consumer);
  const inputs = path.join(base, 'inputs'); const bodies = path.join(inputs, 'bodies'); const privacyBodies = path.join(inputs, 'privacy-bodies');
  mkdirSync(bodies, { recursive: true }); mkdirSync(privacyBodies); writeFileSync(path.join(bodies, 'template.json'), '{}');
  writeFileSync(path.join(privacyBodies, 'official__1_demo.json'), '{"nodes":[]}');
  const bodyMap = path.join(inputs, 'body-map.json');
  writeJson(bodyMap, { rows: [{ templateId: 1, file: 'template.json', sourceDir: bodies, entryId: 'official-1' }], withoutBody: [], refusedBodies: [], orphanBodies: [], counts: { matched: 1 } });
  const privacyBytes = Buffer.from('{"nodes":[]}');
  const snapshotRows = [{ name: 'official__1_demo.json', bytes: privacyBytes.length, sha256: sha256(privacyBytes) }];
  const privacySnapshot = path.join(inputs, 'privacy-inputs.json');
  writeJson(privacySnapshot, { schemaVersion: 1, algorithm: 'sha256', inventoryDigest: inventoryDigest(snapshotRows), fileCount: 1, totalBytes: privacyBytes.length, files: snapshotRows });
  const releaseSnapshot = path.join(inputs, 'release-inputs.json'); writeJson(releaseSnapshot, { schemaVersion: 'release-inputs-v1' });
  const releaseRoot = path.join(base, `release-${mode}`);
  const request = {
    schemaVersion: 'maintenance-request-v1', mode, runId: `test-${mode}-search`, generatedAt: '2026-10-31T12:00:00.000Z',
    candidateRoot, bodyMap, bodySources: [bodies], privacyBodies, privacySnapshot, releaseRoot, releaseSnapshot,
    siteUrl: 'https://example.test', basePath: '/',
  };
  const options = { sourceRoot, scriptRoot: sourceRoot, runtime, workspaceLinks: () => [] };
  return { base, sourceRoot, candidateRoot, request, options, inputs };
}

function promote(work) { writeData(work.candidateRoot, 'candidate', authentic.cases); }
function execute(work, failStep) {
  const completed = [];
  return { completed, executeStep: async (step) => {
    completed.push(step.id); if (step.id === 'promote') promote(work);
    return {
      exitCode: step.id === failStep ? 1 : 0, stderr: step.id === failStep ? 'controlled gate failure' : '',
      stdout: step.id === 'stage-release' ? '{"releaseId":"release-123"}' : step.id === 'verify-release' ? '{"status":"verified","releaseId":"release-123"}' : '',
    };
  } };
}

let temporary;
beforeEach(() => { temporary = []; });
afterEach(() => { for (const item of temporary.splice(0)) rmSync(item, { recursive: true, force: true }); });

describe('maintenance search-binding integration', () => {
  it('SB02 final success guard refuses history drift after the post-verifier inspection', async () => {
    const work = await harness(); const plan = buildMaintenancePlan(work.request, work.options);
    const execution = execute(work); let verified = false; let inspections = 0;
    await expect(runMaintenanceCandidate(plan, {
      ...work.options, scriptRoot: work.candidateRoot,
      executeStep: async (step, context) => { const result = await execution.executeStep(step, context); if (step.id === 'verify-release') verified = true; return result; },
      inspectGit: (root) => {
        if (root === work.candidateRoot && verified && ++inspections === 2) git(root, 'commit', '--allow-empty', '--no-verify', '-m', 'late foreign history');
        return gitInfo(root);
      },
    })).rejects.toThrow(/committed candidate/u);
    expect(inspections).toBe(2);
    const receipt = JSON.parse(readFileSync(path.join(work.candidateRoot, '.work/maintenance', work.request.runId, 'receipt.json'), 'utf8'));
    expect(receipt.status).toBe('failed'); expect(receipt.completedAt).toBeUndefined();
    expect(receipt.completedSteps).toBe(plan.steps.length);
    expect(verifyMaintenanceSearchRelease(plan).release.releaseId).toMatch(/^data-v2@/u);
  }, 30_000);

  it.each([
    { boundary: 'verify-release', mutation: 'empty' },
    { boundary: 'verify-release', mutation: 'foreign' },
    { boundary: 'verify-release', mutation: 'dirty' },
    { boundary: 'stage-release', mutation: 'empty' },
  ])('SB02 terminal guard rejects $mutation during $boundary despite valid JSON', async ({ boundary, mutation }) => {
    const work = await harness(); const plan = buildMaintenancePlan(work.request, work.options);
    const execution = execute(work); let returnedValidJson = false;
    await expect(runMaintenanceCandidate(plan, { ...work.options, scriptRoot: work.candidateRoot, executeStep: async (step, context) => {
      const result = await execution.executeStep(step, context);
      if (step.id === boundary) {
        if (mutation !== 'empty') writeFileSync(path.join(work.candidateRoot, 'foreign-final.txt'), 'outside sourceIdentity');
        if (mutation === 'foreign') git(work.candidateRoot, 'add', 'foreign-final.txt');
        if (mutation !== 'dirty') git(work.candidateRoot, 'commit', '--allow-empty', '--no-verify', '-m', 'unreviewed final history');
        expect(JSON.parse(result.stdout)).toMatchObject(boundary === 'verify-release' ? { status: 'verified', releaseId: 'release-123' } : { releaseId: 'release-123' });
        returnedValidJson = true;
      }
      return result;
    } })).rejects.toThrow(/committed candidate|candidate worktree/u);
    expect(returnedValidJson).toBe(true);
    const receipt = JSON.parse(readFileSync(path.join(work.candidateRoot, '.work/maintenance', work.request.runId, 'receipt.json'), 'utf8'));
    expect(receipt.status).toBe('failed'); expect(receipt.completedAt).toBeUndefined();
    expect(receipt.steps.at(-1)).toMatchObject({ id: boundary, status: 'failed' });
    if (boundary === 'stage-release') expect(execution.completed).not.toContain('verify-release');
    expect(verifyMaintenanceSearchRelease(plan).release.releaseId).toMatch(/^data-v2@/u);
  }, 30_000);

  it('SB01 refuses a dirty immutable source even when its bytes match a clean candidate', async () => {
    const work = await harness();
    writeFileSync(path.join(work.sourceRoot, 'notes.txt'), 'unreviewed baseline');
    expect(() => buildMaintenancePlan(work.request, work.options)).toThrow(/source.*clean|source.*dirty/u);
  }, 20_000);

  it.each(['promote', 'packed-cli'])('SB01 refuses immutable source history drift at %s', async (boundary) => {
    const work = await harness(); const plan = buildMaintenancePlan(work.request, work.options);
    const execution = execute(work);
    await expect(runMaintenanceCandidate(plan, { ...work.options, scriptRoot: work.candidateRoot, executeStep: async (step, context) => {
      const result = await execution.executeStep(step, context);
      if (step.id === boundary) git(work.sourceRoot, 'commit', '--allow-empty', '--no-verify', '-m', 'foreign source history');
      return result;
    } })).rejects.toThrow(/source.*(HEAD|history|identity)/u);
    expect(execution.completed).not.toContain('stage-release');
  }, 30_000);

  it.each(['empty', 'foreign'])('SB02 refuses %s candidate history drift before the fixed add', async (mutation) => {
    const work = await harness(); const plan = buildMaintenancePlan(work.request, work.options); const execution = execute(work);
    await expect(runMaintenanceCandidate(plan, { ...work.options, scriptRoot: work.candidateRoot, executeStep: async (step, context) => {
      const result = await execution.executeStep(step, context);
      if (step.id === 'packed-cli') {
        if (mutation === 'foreign') { writeFileSync(path.join(work.candidateRoot, 'foreign.txt'), 'foreign'); git(work.candidateRoot, 'add', 'foreign.txt'); }
        git(work.candidateRoot, 'commit', '--allow-empty', '--no-verify', '-m', 'foreign candidate history');
      }
      return result;
    } })).rejects.toThrow(/candidate.*HEAD|reviewed.*HEAD/u);
    expect(execution.completed).not.toContain('stage-release'); expect(execution.completed).not.toContain('verify-release');
    const receipt = JSON.parse(readFileSync(path.join(work.candidateRoot, '.work/maintenance', work.request.runId, 'receipt.json'), 'utf8'));
    expect(receipt.status).toBe('failed');
    expect(git(work.candidateRoot, 'diff', '--cached', '--name-only')).toBe('');
  }, 30_000);

  it.each([[], ['foreign-head'], ['reviewed-head', 'foreign-head']].map((parents) => ({ parents })))('SB02 rejects a new commit with nonexact parents $parents', async ({ parents }) => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'maintenance-parent-')); temporary.push(base);
    mkdirSync(path.join(base, 'logs'));
    const dirtyPaths = ['data/manifest.json', SEARCH_BINDING_ALLOWED_FIXTURE]; let calls = 0;
    const context = {
      root: base, runDir: base, logDir: path.join(base, 'logs'), env: process.env, startTime: () => '2026-11-02T00:00:00.000Z',
      inspectGit: () => { calls++; return calls < 3 ? { head: 'reviewed-head', dirtyPaths, stagedPaths: calls === 2 ? dirtyPaths : [] } : { head: 'new-head', clean: true, parents }; },
      executeGitStep: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    await expect(commitCandidateData({ request: { generatedAt: '2026-11-02T00:00:00.000Z' }, bindings: { candidateGit: { head: 'reviewed-head', userName: 'Test', userEmail: 'test@example.test' } } }, context, { id: 'commit-data', argv: [['git', 'add'], ['git', 'commit']] }, {})).rejects.toThrow(/exactly.*parent/u);
  });

  it('keeps the benchmark fixture outside scanner source collection and source-build invalidation', async () => {
    const work = await harness();
    const parameters = async (root) => ({
      sourceFiles: await collectV2ScannerSourceFiles(root), lockfileDigest: 'a'.repeat(64),
      runtimeVersion: 'v22.17.0', effectiveConfigDigest: computeEffectiveConfigDigest(),
    });
    const before = await parameters(work.sourceRoot);
    writeFileSync(fixturePath(work.sourceRoot), Buffer.concat([authenticBytes, Buffer.from(' ')]));
    const fixtureOnly = await parameters(work.sourceRoot);
    expect(fixtureOnly.sourceFiles).toEqual(before.sourceFiles);
    expect(computeSourceBuildDigest(fixtureOnly)).toBe(computeSourceBuildDigest(before));
    writeFileSync(path.join(work.sourceRoot, 'pipeline/sources.json'), '[{\"changed\":true}]\n');
    const scannerChange = await parameters(work.sourceRoot);
    expect(scannerChange.sourceFiles).not.toEqual(before.sourceFiles);
    expect(computeSourceBuildDigest(scannerChange)).not.toBe(computeSourceBuildDigest(before));
  }, 20_000);

  it('publishes a non-circular v2 plan that refuses v1, transaction tampering, and step reordering', async () => {
    const work = await harness(); const plan = await buildMaintenancePlan(work.request, work.options);
    expect(plan.schemaVersion).toBe('maintenance-plan-v2');
    expect(plan.steps.map((step) => step.id).slice(-8)).toEqual([
      'promote', 'bind-search-release', 'export', 'release-gates', 'packed-cli', 'commit-data', 'stage-release',
      'verify-release',
    ]);
    expect(plan.digest).toBe(plan.bindings.searchBinding.transaction.planSha256);
    expect(plan.bindings.searchBinding).toMatchObject({
      fixturePath: SEARCH_BINDING_ALLOWED_FIXTURE, cohortSha256: SEARCH_BINDING_COHORT_SHA256,
      baselineRoot: work.sourceRoot, candidateRoot: work.candidateRoot,
      expectedFixtureSha256: sha256(authenticBytes), expectedBaselineDataIdentity: dataIdentity(work.sourceRoot),
      transaction: { id: `maintenance-${work.request.runId}`, attempt: 1 },
    });
    expect(plan.bindings.searchBinding.helper).toHaveLength(6);
    expect(() => verifyMaintenancePlanLink(plan)).not.toThrow();
    expect(() => verifyMaintenancePlanLink({ ...plan, schemaVersion: 'maintenance-plan-v1' })).toThrow(/schema|v2/u);
    expect(() => verifyMaintenancePlanLink({ ...plan, bindings: { ...plan.bindings, searchBinding: { ...plan.bindings.searchBinding, transaction: { ...plan.bindings.searchBinding.transaction, attempt: 2 } } } })).toThrow(/digest|attempt/u);
    const reordered = structuredClone(plan); [reordered.steps[4], reordered.steps[5]] = [reordered.steps[5], reordered.steps[4]];
    expect(() => verifyMaintenancePlanLink(reordered)).toThrow(/digest|order/u);
    expect(sealMaintenancePlan({ ...structuredClone(plan), digest: undefined }).digest).toBe(plan.digest);
  }, 20_000);

  it('composes the accepted helper end to end, commits only data plus the fixture, and replays coherently', async () => {
    const work = await harness('scanner-rescan', true); const plan = await buildMaintenancePlan(work.request, work.options);
    for (const name of ['search-index.json', 'search-index-extended.json']) {
      expect(() => parseSearchIndexJson(readFileSync(artifactPath(work.candidateRoot, name), 'utf8'))).not.toThrow();
    }
    const execution = execute(work);
    const result = await runMaintenanceCandidate(plan, { ...work.options, scriptRoot: work.candidateRoot, executeStep: execution.executeStep });
    const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
    const bindingReceipt = JSON.parse(readFileSync(plan.bindings.searchBinding.receiptPath, 'utf8'));
    expect(result.status).toBe('candidate-verified');
    expect(execution.completed).not.toContain('bind-search-release');
    expect(receipt.steps.map((step) => step.id)).toEqual(plan.steps.map((step) => step.id));
    expect(git(work.candidateRoot, 'status', '--porcelain')).toBe('');
    expect(git(work.candidateRoot, 'diff', '--name-only', 'HEAD^')).toEqual(['app/src/search/__fixtures__/relevance-set.json', 'data/analytics.json', 'data/manifest.json', 'data/search-index.json', 'data/semantic-index.json'].sort().join('\n'));
    expect(sha256(readFileSync(fixturePath(work.candidateRoot)))).toBe(bindingReceipt.generated.fixtureSha256);
    expect(cohortSha256(readRelevanceFixture(JSON.parse(readFileSync(fixturePath(work.candidateRoot)))))).toBe(SEARCH_BINDING_COHORT_SHA256);
    const replay = verifySearchReleaseReceipt({
      candidateRoot: work.candidateRoot, baselineCandidateRoot: work.sourceRoot,
      receiptRoot: path.dirname(plan.bindings.searchBinding.receiptPath), receiptPath: plan.bindings.searchBinding.receiptPath,
      transaction: plan.bindings.searchBinding.transaction,
    });
    expect(replay.release).toEqual(deriveSearchRelease({ candidateRoot: work.candidateRoot }).release);
    expect(replay.dataIdentity).toEqual(dataIdentity(work.candidateRoot));
    cpSync(path.join(work.candidateRoot, 'data'), path.join(work.candidateRoot, 'app/public/data'), { recursive: true });
    expect(git(work.candidateRoot, 'show', '-s', '--format=%P')).toBe(plan.bindings.candidateGit.head);
    const evaluatorArgv = ['--import', pathToFileURL(path.join(REPO_ROOT, 'node_modules/tsx/dist/loader.mjs')).href, path.join(work.candidateRoot, 'scripts/evaluate-search.ts'), '--json'];
    const runEvaluator = () => spawnSync(process.execPath, evaluatorArgv, { cwd: work.candidateRoot, encoding: 'utf8', timeout: 20_000 });
    const browserIndex = path.join(work.candidateRoot, 'app/public/data/search-index.json');
    writeFileSync(browserIndex, Buffer.concat([readFileSync(browserIndex), Buffer.from(' ')]));
    const staleReplay = runEvaluator();
    expect(staleReplay.status, staleReplay.stderr).toBe(1);
    expect(staleReplay.stderr).toMatch(/artifact hash is stale|source and browser artifact differ/u);
    copyFileSync(artifactPath(work.candidateRoot, 'search-index.json'), browserIndex);
    const evaluator = runEvaluator();
    expect(evaluator.status, evaluator.stderr).toBe(0);
    const measurement = JSON.parse(evaluator.stdout);
    expect(measurement.schemaVersion).toBe('search-quality-report-v1');
    expect(measurement.cases).toBe(authentic.cases.length);
    expect(measurement.releaseId).toBe(replay.release.releaseId);
    expect(measurement.corpusSha256).toBe(replay.release.corpusSha256);
    for (const name of REQUIRED_SEARCH_ARTIFACTS) expect(measurement.bytes.artifacts[name].sha256).toBe(replay.release.artifacts[name]);
    expect(measurement.protocol).toEqual(authentic.protocol);
    expect(sha256(readFileSync(path.join(work.candidateRoot, 'scripts/evaluate-search.ts')))).toBe(sha256(readFileSync(path.join(REPO_ROOT, 'scripts/evaluate-search.ts'))));
    expect(Number.isFinite(measurement.ndcgAt10)).toBe(true);
    const evidence = process.env.STAGE_B_REPAIR_EVIDENCE;
    if (evidence) writeJson(path.join(evidence, 'evaluator-replay.json'), { head: git(work.candidateRoot, 'rev-parse', 'HEAD'), parent: plan.bindings.candidateGit.head, fixtureSha256: replay.receipt.generated.fixtureSha256, dataIdentity: replay.dataIdentity, evaluatorSha256: sha256(readFileSync(path.join(work.candidateRoot, 'scripts/evaluate-search.ts'))), argv: [process.execPath, ...evaluatorArgv], staleReplay: { exitCode: staleReplay.status, stdout: staleReplay.stdout, stderr: staleReplay.stderr }, exitCode: evaluator.status, measurement });
    expect(git(work.candidateRoot, 'status', '--porcelain')).toBe('');
  }, 60_000);

  it('preserves bound data, fixture, and receipt after a gate failure and never stages', async () => {
    const work = await harness(); const plan = await buildMaintenancePlan(work.request, work.options);
    const execution = execute(work, 'release-gates');
    await expect(runMaintenanceCandidate(plan, { ...work.options, scriptRoot: work.candidateRoot, executeStep: execution.executeStep })).rejects.toThrow(/release-gates/u);
    expect(execution.completed).toEqual(expect.arrayContaining(['promote', 'export', 'release-gates']));
    expect(execution.completed).not.toContain('commit-data'); expect(execution.completed).not.toContain('stage-release');
    expect(verifySearchReleaseReceipt({ candidateRoot: work.candidateRoot, baselineCandidateRoot: work.sourceRoot, receiptRoot: path.dirname(plan.bindings.searchBinding.receiptPath), receiptPath: plan.bindings.searchBinding.receiptPath, transaction: plan.bindings.searchBinding.transaction }).release.releaseId).toMatch(/^data-v2@/u);
    expect(git(work.candidateRoot, 'status', '--porcelain')).toContain(SEARCH_BINDING_ALLOWED_FIXTURE);
    const receipt = JSON.parse(readFileSync(path.join(work.candidateRoot, '.work/maintenance', work.request.runId, 'receipt.json'), 'utf8'));
    expect(receipt.status).toBe('failed'); expect(receipt.failure).toMatch(/release-gates/u);
  }, 30_000);

  it('fails closed on source, fixture, baseline-data, helper, and receipt drift', async () => {
    const work = await harness(); const plan = await buildMaintenancePlan(work.request, work.options);
    promote(work); const binding = plan.bindings.searchBinding; mkdirSync(binding.receiptRoot, { recursive: true });
    bindMaintenanceSearchRelease(plan);
    const verification = verifyMaintenanceSearchRelease(plan);
    expect(() => assertPostBindSource(plan, verification)).not.toThrow();
    writeFileSync(path.join(work.candidateRoot, 'scripts/runtime.mjs'), 'foreign\n');
    expect(() => assertPostBindSource(plan, verification)).toThrow(/source|drift|inventory/u);
    expect(() => assertHelperClosure(work.sourceRoot)).not.toThrow();
    writeFileSync(path.join(work.sourceRoot, 'scripts/lib/search-release-data.mjs'), 'foreign\n');
    expect(() => assertHelperClosure(work.sourceRoot)).toThrow(/helper/u);
    writeFileSync(path.join(work.candidateRoot, 'scripts/lib/search-release-data.mjs'), 'foreign\n');
    expect(() => assertHelperClosure(work.candidateRoot)).toThrow(/helper|source/u);
    const receiptBytes = readFileSync(binding.receiptPath);
    const stale = JSON.parse(receiptBytes); stale.transaction.attempt = 2; writeJson(binding.receiptPath, stale);
    expect(() => verifyMaintenanceSearchRelease(plan)).toThrow(/transaction attempt|belongs/u);
    writeFileSync(binding.receiptPath, receiptBytes);
    writeFileSync(path.join(work.candidateRoot, 'data/analytics.json'), 'foreign data\n');
    expect(() => verifyMaintenanceSearchRelease(plan)).toThrow(/identity|tree|manifest/u);
    writeFileSync(fixturePath(work.candidateRoot), Buffer.concat([readFileSync(fixturePath(work.candidateRoot)), Buffer.from(' ')]));
    expect(() => verifyMaintenanceSearchRelease(plan)).toThrow(/fixture/u);
    writeFileSync(binding.receiptPath, '{}\n');
    expect(() => verifyMaintenanceSearchRelease(plan)).toThrow(/receipt|keys|schema/u);
    unlinkSync(binding.receiptPath);
    expect(() => verifyMaintenanceSearchRelease(plan)).toThrow();
    expect(sourceIdentity(work.sourceRoot).files.some((row) => row.path === APPROVED_FIXTURE_PATH)).toBe(true);
  }, 30_000);

  it('rejects a changed cohort, pinned fixture, or baseline data identity', async () => {
    const cohort = await harness();
    const changed = structuredClone(authentic); changed.createdOn = '2026-11-01';
    for (const root of [cohort.sourceRoot, cohort.candidateRoot]) writeFileSync(fixturePath(root), json(changed));
    git(cohort.candidateRoot, 'add', SEARCH_BINDING_ALLOWED_FIXTURE);
    git(cohort.candidateRoot, 'commit', '--no-verify', '-m', 'changed cohort');
    git(cohort.sourceRoot, 'add', SEARCH_BINDING_ALLOWED_FIXTURE);
    git(cohort.sourceRoot, 'commit', '--no-verify', '-m', 'changed cohort');
    expect(() => buildMaintenancePlan(cohort.request, cohort.options)).toThrow(/cohort|fixture/u);

    for (const mutation of ['fixture', 'baseline']) {
      const work = await harness(); const plan = await buildMaintenancePlan(work.request, work.options);
      const binding = plan.bindings.searchBinding; mkdirSync(binding.receiptRoot, { recursive: true });
      if (mutation === 'fixture') writeFileSync(fixturePath(work.candidateRoot), Buffer.concat([authenticBytes, Buffer.from(' ')]));
      else writeFileSync(path.join(work.sourceRoot, 'data/analytics.json'), 'foreign baseline\n');
      promote(work);
      expect(() => bindMaintenanceSearchRelease(plan)).toThrow(mutation === 'fixture' ? /fixture|pinned/u : /baseline data|identity/u);
    }
  }, 30_000);

  it('does not commit or stage after an in-process bind failure', async () => {
    const work = await harness(); const plan = await buildMaintenancePlan(work.request, work.options);
    const execution = execute(work);
    await expect(runMaintenanceCandidate(plan, {
      ...work.options, scriptRoot: work.candidateRoot, executeStep: execution.executeStep,
      searchBinding: { bind: () => { throw new Error('controlled bind failure'); } },
    })).rejects.toThrow(/controlled bind failure/u);
    expect(execution.completed).toEqual(expect.arrayContaining(['promote']));
    expect(execution.completed).not.toContain('commit-data'); expect(execution.completed).not.toContain('stage-release');
    const receipt = JSON.parse(readFileSync(path.join(work.candidateRoot, '.work/maintenance', work.request.runId, 'receipt.json'), 'utf8'));
    expect(receipt.status).toBe('failed'); expect(receipt.failure).toMatch(/controlled bind failure/u);
  }, 20_000);

  it('retains the clean committed data and fixture after stage failure and never verifies/stages again', async () => {
    const work = await harness(); const plan = await buildMaintenancePlan(work.request, work.options);
    const execution = execute(work, 'stage-release');
    await expect(runMaintenanceCandidate(plan, { ...work.options, scriptRoot: work.candidateRoot, executeStep: execution.executeStep })).rejects.toThrow(/stage-release/u);
    expect(execution.completed).toContain('stage-release'); expect(execution.completed).not.toContain('verify-release');
    expect(git(work.candidateRoot, 'status', '--porcelain')).toBe('');
    expect(verifyMaintenanceSearchRelease(plan).release.releaseId).toMatch(/^data-v2@/u);
  }, 30_000);

  it('retains bind/data evidence and never stages after commit failure', async () => {
    const work = await harness(); const plan = await buildMaintenancePlan(work.request, work.options);
    const execution = execute(work);
    await expect(runMaintenanceCandidate(plan, {
      ...work.options, scriptRoot: work.candidateRoot, executeStep: execution.executeStep,
      executeGitStep: async (step) => ({ exitCode: step.id === 'commit-data-1' ? 1 : 0, stdout: '', stderr: 'controlled commit failure' }),
    })).rejects.toThrow(/commit-data-1|commit command/u);
    expect(execution.completed).toContain('packed-cli'); expect(execution.completed).not.toContain('stage-release');
    expect(git(work.candidateRoot, 'status', '--porcelain')).toContain(SEARCH_BINDING_ALLOWED_FIXTURE);
    expect(verifyMaintenanceSearchRelease(plan).release.releaseId).toMatch(/^data-v2@/u);
  }, 30_000);

  it('retains the clean committed pair and fails truthfully when release verification fails', async () => {
    const work = await harness(); const plan = await buildMaintenancePlan(work.request, work.options);
    const execution = execute(work, 'verify-release');
    await expect(runMaintenanceCandidate(plan, { ...work.options, scriptRoot: work.candidateRoot, executeStep: execution.executeStep })).rejects.toThrow(/verify-release/u);
    expect(execution.completed).toEqual(expect.arrayContaining(['stage-release', 'verify-release']));
    expect(git(work.candidateRoot, 'status', '--porcelain')).toBe('');
    const receipt = JSON.parse(readFileSync(path.join(work.candidateRoot, '.work/maintenance', work.request.runId, 'receipt.json'), 'utf8'));
    expect(receipt.status).toBe('failed'); expect(receipt.failure).toMatch(/verify-release/u);
    expect(receipt.steps.map((step) => step.id)).toEqual(expect.arrayContaining(['commit-data', 'stage-release', 'verify-release']));
    expect(verifyMaintenanceSearchRelease(plan).release.releaseId).toMatch(/^data-v2@/u);
  }, 30_000);

  it('accepts exactly data files plus the one fixture and rejects partial or foreign path sets', () => {
    expect(() => assertCandidateChangePaths(['data/manifest.json', SEARCH_BINDING_ALLOWED_FIXTURE])).not.toThrow();
    expect(() => assertCandidateChangePaths(['data/manifest.json'])).toThrow(/fixture|two-path/u);
    expect(() => assertCandidateChangePaths([SEARCH_BINDING_ALLOWED_FIXTURE])).toThrow(/data/u);
    expect(() => assertCandidateChangePaths(['data/manifest.json', SEARCH_BINDING_ALLOWED_FIXTURE, 'scripts/runtime.mjs'])).toThrow(/outside|unrelated/u);
    expect(() => assertCandidateChangePaths(['data/../scripts/runtime.mjs', SEARCH_BINDING_ALLOWED_FIXTURE])).toThrow(/malformed/u);
    expect(() => assertCandidateChangePaths(['data/manifest.json', 'data-other/manifest.json', SEARCH_BINDING_ALLOWED_FIXTURE])).toThrow(/outside|unrelated/u);
    expect(() => assertExactDirtyStaged(['data/manifest.json', SEARCH_BINDING_ALLOWED_FIXTURE], ['data/manifest.json', SEARCH_BINDING_ALLOWED_FIXTURE])).not.toThrow();
    expect(() => assertExactDirtyStaged(['data/manifest.json', SEARCH_BINDING_ALLOWED_FIXTURE], ['data/manifest.json'])).toThrow(/equal|fixture/u);
  });

  it('uses the frozen receipt location and rejects a caller path or release override', async () => {
    const work = await harness(); const plan = await buildMaintenancePlan(work.request, work.options);
    expect(plan.bindings.searchBinding.receiptPath).toBe(path.join(work.candidateRoot, '.work/maintenance', work.request.runId, 'search-release-binding', SEARCH_BINDING_RECEIPT_NAME));
    expect(() => verifyMaintenancePlanLink({ ...plan, bindings: { ...plan.bindings, searchBinding: { ...plan.bindings.searchBinding, receiptPath: path.join(work.candidateRoot, 'data/receipt.json') } } })).toThrow(/receipt|digest/u);
    expect(() => verifyMaintenancePlanLink({ ...plan, steps: plan.steps.map((step) => step.id === 'bind-search-release' ? { ...step, argv: ['node', 'other.mjs'] } : step) })).toThrow(/argv|digest|handler/u);
    expect(existsSync(path.join(work.candidateRoot, 'data/receipt.json'))).toBe(false);
  }, 20_000);
});
