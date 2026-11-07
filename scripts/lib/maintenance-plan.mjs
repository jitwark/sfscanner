import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, dataIdentity, filesUnder, safePath, sha, sourceIdentity } from './maintenance-identity.mjs';
import { bindBodiesToInventory, readInputSnapshot } from './published-secret-input-inventory.mjs';
import {
  SEARCH_BINDING_ALLOWED_FIXTURE, SEARCH_BINDING_STEP_ID, createMaintenanceSearchBinding,
  sealMaintenancePlan, verifyMaintenancePlanLink,
} from './maintenance-search-binding.mjs';

export const MODULE_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const SIDECARS = ['advisories-v2.json', 'advisory-quarantine-v1.json', 'calibration-v2-manifest.json'];
const REQUEST_KEYS = ['schemaVersion', 'mode', 'runId', 'generatedAt', 'candidateRoot', 'bodyMap', 'bodySources', 'privacyBodies', 'privacySnapshot', 'releaseRoot', 'releaseSnapshot', 'siteUrl', 'basePath'];
const inside = (root, candidate) => { const rel = path.relative(root, candidate); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const equalPath = (a, b) => path.relative(path.resolve(a), path.resolve(b)) === '';
const fail = (message) => { throw new Error(`maintenance plan refused: ${message}`); };
function readJson(file, label) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { fail(`${label} is not valid JSON`); } }

export function inputSnapshot(file, label) { const resolved = safePath(file, label, { kind: 'file' }); const bytes = readFileSync(resolved); return { path: resolved, byteSize: bytes.length, sha256: sha(bytes) }; }
export function bodySnapshot(mapPath, bodyPaths, root) {
  const map = readJson(mapPath, 'body map');
  if (!Array.isArray(map?.rows) || map.rows.length === 0 || !Array.isArray(map.withoutBody) || !Array.isArray(map.refusedBodies) || !Array.isArray(map.orphanBodies) || !map.counts || typeof map.counts !== 'object') fail('body map must be a qualified official-body map with rows, counts and residual arrays');
  const sources = bodyPaths.map((item) => { const resolved = safePath(item, 'body source', { kind: 'directory' }); if (resolved !== item) fail('body source paths must be canonical'); return resolved; });
  if (new Set(sources.map((item) => process.platform === 'win32' ? item.toLowerCase() : item)).size !== sources.length) fail('bodySources contains a duplicate directory');
  const snapshots = sources.map((dir) => { const rows = filesUnder(dir); return { record: { path: dir, fileCount: rows.length, treeSha256: sha(Buffer.from(canonical(rows))) }, files: new Set(rows.map((row) => row.path)) }; });
  const records = snapshots.map((snapshot) => snapshot.record);
  const bySource = new Map(snapshots.map(({ record, files }) => [process.platform === 'win32' ? record.path.toLowerCase() : record.path, files]));
  for (const row of map.rows) {
    if (!Number.isSafeInteger(row?.templateId) || typeof row.file !== 'string' || typeof row.entryId !== 'string' || typeof row.sourceDir !== 'string') fail('body map row is malformed');
    if (path.isAbsolute(row.file) || row.file.split(/[\\/]/u).includes('..')) fail('body map contains an unsafe body path');
    const source = path.resolve(root, row.sourceDir); const key = process.platform === 'win32' ? source.toLowerCase() : source;
    if (!bySource.has(key) || !bySource.get(key).has(row.file.replaceAll('\\', '/'))) fail(`body map row is not covered by bodySources: ${row.entryId}`);
  }
  return { map: inputSnapshot(mapPath, 'body map'), sources: records };
}
export function privacyInputs(request) {
  const bodies = safePath(request.privacyBodies, 'privacy body directory', { kind: 'directory' }); const snapshotPath = safePath(request.privacySnapshot, 'privacy input snapshot', { kind: 'file' }); if (bodies !== request.privacyBodies || snapshotPath !== request.privacySnapshot) fail('privacy input paths must be canonical');
  const snapshot = readInputSnapshot(snapshotPath); if (!snapshot.ok || snapshot.inventory.fileCount === 0) fail(snapshot.ok ? 'privacy input snapshot has no bodies' : snapshot.detail);
  const matched = bindBodiesToInventory({ bodiesDir: bodies, inventory: snapshot.inventory }); if (!matched.ok) fail(`privacy body directory does not match its snapshot: ${matched.detail}`);
  const rows = filesUnder(bodies); return { bodies: { path: bodies, fileCount: rows.length, treeSha256: sha(Buffer.from(canonical(rows))) }, snapshot: inputSnapshot(snapshotPath, 'privacy input snapshot') };
}

function runtimeIdentity(options) {
  if (options.runtime) return { platform: process.platform, arch: process.arch, ...options.runtime };
  const env = options.env ?? process.env; const npm = env.npm_execpath;
  if (!npm || !path.isAbsolute(npm)) fail('run this command through npm so npm_execpath is bound');
  const npmPath = safePath(npm, 'npm executable', { kind: 'file' });
  let npmVersion = env.npm_config_user_agent?.match(/(?:^|\s)npm\/([^\s]+)/u)?.[1];
  if (!npmVersion) {
    let cursor = path.dirname(npmPath);
    for (let i = 0; i < 5 && !npmVersion; i++, cursor = path.dirname(cursor)) {
      const file = path.join(cursor, 'package.json');
      if (lstatSync(file, { throwIfNoEntry: false })?.isFile()) { const pkg = readJson(file, 'npm package manifest'); if (pkg.name === 'npm') npmVersion = pkg.version; }
    }
  }
  if (!npmVersion) fail('could not resolve the selected npm version');
  return { platform: process.platform, arch: process.arch, nodeExecutable: path.resolve(process.execPath), nodeVersion: process.version, npmExecutable: npmPath, npmVersion, npmSha256: sha(readFileSync(npmPath)) };
}

export function gitInfo(root) {
  const run = (args, trim = true) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false }); if (result.status !== 0) fail(`git ${args[0]} could not inspect ${root}`); return trim ? result.stdout.trim() : result.stdout; };
  // `git status --porcelain` encodes the staged/unstaged columns before the path, so an unstaged change
  // starts with a significant space (" M data/x"). Trimming the output would corrupt the first entry's path.
  const status = run(['status', '--porcelain', '--untracked-files=all'], false).replace(/[\r\n]+$/u, '');
  return { root: path.resolve(run(['rev-parse', '--show-toplevel'])), head: run(['rev-parse', 'HEAD']), parents: run(['show', '-s', '--format=%P', 'HEAD']).split(' ').filter(Boolean), clean: status === '', dirtyPaths: status.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3).replaceAll('\\', '/').replace(/^"|"$/gu, '')), stagedPaths: run(['diff', '--cached', '--name-only']).split(/\r?\n/u).filter(Boolean), userName: run(['config', '--get', 'user.name']), userEmail: run(['config', '--get', 'user.email']) };
}

function workspaceLinks(root) {
  const pkg = readJson(path.join(root, 'package.json'), 'candidate package manifest');
  const links = [];
  for (const pattern of pkg.workspaces ?? []) {
    const star = pattern.indexOf('*'); const parent = star < 0 ? [pattern] : readdirSync(path.join(root, path.dirname(pattern)), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(path.dirname(pattern), entry.name));
    for (const relative of parent) {
      const file = path.join(root, relative, 'package.json'); if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) continue;
      const name = readJson(file, `workspace manifest ${relative}`).name; if (typeof name !== 'string') fail(`workspace has no package name: ${relative}`);
      const link = path.join(root, 'node_modules', ...name.split('/'));
      let resolved; try { resolved = realpathSync(link); } catch { fail(`workspace dependency link is missing: ${name}`); }
      if (!inside(root, resolved)) fail(`workspace dependency link escapes the candidate: ${name}`); if (!equalPath(resolved, realpathSync(path.join(root, relative)))) fail(`workspace dependency link does not resolve to its declared candidate workspace: ${name}`);
      links.push({ name, target: resolved });
    }
  }
  return links.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('request must be an object');
  const keys = Object.keys(request).sort(); if (canonical(keys) !== canonical([...REQUEST_KEYS].sort())) fail('request has missing or unknown fields');
  if (request.schemaVersion !== 'maintenance-request-v1' || !['scanner-rescan', 'add-source'].includes(request.mode)) fail('request schema or mode is invalid');
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(request.runId ?? '')) fail('runId must contain 1-64 letters, digits, underscore or hyphen');
  if (typeof request.generatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(request.generatedAt) || new Date(request.generatedAt).toISOString() !== request.generatedAt) fail('generatedAt must be a canonical UTC ISO timestamp');
  let site;
  try { site = new URL(request.siteUrl); } catch { fail('siteUrl must be an absolute HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(site.protocol) || site.username || site.password || site.pathname !== '/' || site.search || site.hash) fail('siteUrl must be an HTTP(S) origin without credentials, path, query or fragment');
  if (typeof request.basePath !== 'string' || !request.basePath.startsWith('/') || request.basePath.includes('..') || (request.basePath !== '/' && request.basePath.endsWith('/'))) fail('basePath must be a normalized absolute path');
  if (!Array.isArray(request.bodySources) || request.bodySources.length === 0) fail('bodySources must declare at least one retained body folder');
}

export function makeExecutionSteps(request, root, runtime, identity) {
  const work = path.join(root, '.work', 'maintenance', request.runId); const inputData = path.join(work, 'add-source-data');
  const inventory = path.join(work, 'v2-input-inventory.json'); const hydration = path.join(work, 'hydration'); const out = path.join(work, 'v2-run'); const apply = path.join(work, 'data-v2');
  const dataInput = request.mode === 'add-source' ? inputData : path.join(root, 'data'); const node = runtime.nodeExecutable;
  const nodeCli = (script, ...args) => [node, '--import', 'tsx', path.join(root, script), ...args];
  const npm = (...args) => [node, runtime.npmExecutable, ...args];
  const steps = [];
  if (request.mode === 'add-source') {
    steps.push({ id: 'acquire', argv: nodeCli('pipeline/build-corpus.ts', '--run', request.runId) });
    steps.push({ id: 'seed-scanner-sidecars', argv: [], internal: true });
    steps.push({ id: 'enrich', argv: nodeCli('pipeline/run-enrichment.ts', '--run', request.runId, '--generated-at', request.generatedAt, '--skip-describe', '--staging-dir', inputData) });
  }
  steps.push({ id: 'inventory', argv: nodeCli('scripts/build-v2-input-inventory.ts', '--data', dataInput, '--map', request.bodyMap, '--out', inventory, '--cache', hydration, '--rulings', path.join(root, 'docs/audit/2026-10-17-remediation/C1-real-inventory.json')) });
  steps.push({ id: 'regenerate', argv: nodeCli('pipeline/regenerate/v2-cli.ts', '--data', dataInput, '--inventory', inventory, '--map', request.bodyMap, ...request.bodySources.flatMap((body) => ['--bodies', body]), '--hydrated', hydration, '--out', out, '--apply-data', apply, '--generated-at', request.generatedAt) });
  steps.push({ id: 'promote', argv: nodeCli('scripts/prepare-release-data.mjs', apply, '--replace') });
  steps.push({ id: SEARCH_BINDING_STEP_ID, internal: true, handler: 'maintenance-search-binding-v1', argv: [] });
  steps.push({ id: 'export', argv: nodeCli('scripts/export-public-dataset.ts', '--data', path.join(root, 'data'), '--out', path.join(root, 'outputs/public-dataset'), '--generated-at', request.generatedAt) });
  // release:gates includes the static build; repeating it doubles the expensive work.
  steps.push({ id: 'release-gates', argv: npm('run', 'release:gates') });
  steps.push({ id: 'packed-cli', argv: [node, path.join(root, 'scripts/verify-packed-cli.mjs')] });
  steps.push({ id: 'commit-data', argv: [['git', 'add', '-f', '--', 'data', SEARCH_BINDING_ALLOWED_FIXTURE], ['git', '-c', `user.name=${identity.userName}`, '-c', `user.email=${identity.userEmail}`, '-c', `core.hooksPath=${path.join(work, 'empty-hooks')}`, '-c', 'commit.gpgSign=false', 'commit', '--no-gpg-sign', '--no-verify', '-m', `maintenance candidate ${request.runId}`]] });
  const releaseArgs = ['--mode', 'release', '--root', request.releaseRoot, '--snapshot', request.releaseSnapshot, '--site', path.join(root, 'app/out'), '--data', path.join(root, 'data'), '--export', path.join(root, 'outputs/public-dataset'), '--json'];
  steps.push({ id: 'stage-release', argv: [node, path.join(root, 'scripts/stage-release.mjs'), ...releaseArgs] });
  steps.push({ id: 'verify-release', argv: [node, path.join(root, 'scripts/release-verify.mjs'), '--root', request.releaseRoot, '--release-id', '<staged-release-id>', '--snapshot', request.releaseSnapshot, '--site', path.join(root, 'app/out'), '--data', path.join(root, 'data'), '--export', path.join(root, 'outputs/public-dataset'), '--json'] });
  return steps;
}

export function buildMaintenancePlan(request, options = {}) {
  validateRequest(request);
  const scriptRoot = safePath(options.scriptRoot ?? MODULE_ROOT, 'executing repository', { kind: 'directory' });
  const sourceRoot = safePath(options.sourceRoot ?? MODULE_ROOT, 'source repository', { kind: 'directory' });
  const candidateRoot = safePath(request.candidateRoot, 'candidate repository', { kind: 'directory' });
  if (!equalPath(scriptRoot, sourceRoot) && !equalPath(scriptRoot, candidateRoot)) fail('the command must run from its source or requested candidate root');
  if (inside(sourceRoot, candidateRoot) || inside(candidateRoot, sourceRoot)) {
    if (!(options.allowSameRoot === true && equalPath(sourceRoot, candidateRoot))) fail('candidate and source roots must be independent');
  }
  if (candidateRoot !== request.candidateRoot) fail('candidateRoot must be canonical');
  const releaseRoot = safePath(request.releaseRoot, 'release root', { missing: true });
  if (lstatSync(releaseRoot, { throwIfNoEntry: false })) fail('release root already exists');
  if (releaseRoot !== request.releaseRoot) fail('releaseRoot must be canonical');
  const releaseParent = safePath(path.dirname(releaseRoot), 'release root parent', { kind: 'directory' });
  if (inside(sourceRoot, releaseParent) || inside(candidateRoot, releaseParent) || inside(releaseRoot, sourceRoot) || inside(releaseRoot, candidateRoot)) fail('release root must be isolated from source and candidate repositories');
  const mapPath = safePath(request.bodyMap, 'body map', { kind: 'file' }); const snapshotPath = safePath(request.releaseSnapshot, 'release snapshot', { kind: 'file' }); if (mapPath !== request.bodyMap || snapshotPath !== request.releaseSnapshot) fail('body map and release snapshot paths must be canonical');
  const source = sourceIdentity(sourceRoot); const candidate = sourceIdentity(candidateRoot);
  if (source.sha256 !== candidate.sha256) fail('candidate source/config/lock bytes differ from the source repository');
  const sourceData = dataIdentity(sourceRoot); const candidateData = dataIdentity(candidateRoot);
  if (sourceData.treeSha256 !== candidateData.treeSha256 || sourceData.manifestSha256 !== candidateData.manifestSha256) fail('candidate baseline data differs from source data');
  const git = options.git ?? gitInfo; const sourceGit = git(sourceRoot); const candidateGit = equalPath(sourceRoot, candidateRoot) ? sourceGit : git(candidateRoot);
  if (!equalPath(sourceGit.root, sourceRoot) || !equalPath(candidateGit.root, candidateRoot)) fail('source and candidate must each be complete Git roots');
  if (!sourceGit.clean) fail('source Git worktree must be clean before planning');
  if (!candidateGit.clean) fail('candidate Git worktree must be clean before planning');
  if (!candidateGit.userName || !candidateGit.userEmail) fail('candidate Git author identity must be configured');
  const runtime = runtimeIdentity(options);
  if (!runtime.nodeVersion?.startsWith('v22.') || !runtime.npmExecutable || !runtime.npmVersion || !runtime.npmSha256) fail('Node 22 and a bound npm runtime are required');
  const links = (options.workspaceLinks ?? workspaceLinks)(candidateRoot);
  const bodies = bodySnapshot(mapPath, request.bodySources, candidateRoot);
  const privacy = privacyInputs(request);
  const rulingsPath = 'docs/audit/2026-10-17-remediation/C1-real-inventory.json';
  const rulings = { ...inputSnapshot(path.join(candidateRoot, rulingsPath), 'scanner ruling inventory'), path: rulingsPath };
  if (rulings.sha256 !== inputSnapshot(path.join(sourceRoot, rulingsPath), 'source scanner ruling inventory').sha256) fail('candidate scanner ruling inventory differs from source');
  const scannerSidecars = SIDECARS.map((name) => {
    const item = inputSnapshot(path.join(sourceRoot, 'data/scanner', name), `scanner sidecar ${name}`);
    return { path: `scanner/${name}`, byteSize: item.byteSize, sha256: item.sha256 };
  });
  const releaseSnapshot = inputSnapshot(snapshotPath, 'release snapshot');
  const workRoot = path.join(candidateRoot, '.work/maintenance'); const runDir = path.join(workRoot, request.runId);
  for (const [target, label] of [[path.join(candidateRoot, 'pipeline/.work', request.runId), 'corpus run'], [path.join(candidateRoot, 'pipeline/reports', `corpus-${request.runId}.md`), 'corpus report'], [runDir, 'maintenance run'], [path.join(candidateRoot, 'outputs/public-dataset'), 'public dataset output'], ...['app/.next', 'app/out', 'app/public/data', 'app/public/og', 'public/og', 'packages/scanner-cli/dist'].map((relative) => [path.join(candidateRoot, relative), `${relative} build output`])]) {
    if (lstatSync(target, { throwIfNoEntry: false })) fail(`${label} path already exists`);
  }
  if (lstatSync(path.join(workRoot, 'maintenance.lock'), { throwIfNoEntry: false })) fail('maintenance lock already exists');
  const searchBinding = createMaintenanceSearchBinding({ sourceRoot, candidateRoot, runDir, runId: request.runId, baselineDataIdentity: sourceData });
  const bindings = { source, sourceGit: { root: sourceRoot, head: sourceGit.head }, candidate, data: sourceData, searchBinding, scannerSidecars, bodyInputs: bodies, privacyInputs: privacy, scannerRulings: rulings, releaseSnapshot, runtime, candidateGit: { head: candidateGit.head, userName: candidateGit.userName, userEmail: candidateGit.userEmail }, workspaceLinks: links };
  const steps = makeExecutionSteps(request, candidateRoot, runtime, candidateGit);
  const unsigned = { schemaVersion: 'maintenance-plan-v2', request, bindings, steps };
  return sealMaintenancePlan(unsigned);
}

export function verifyMaintenancePlan(plan, options = {}) {
  if (!plan || plan.schemaVersion !== 'maintenance-plan-v2' || !plan.request) fail('plan schema must be maintenance-plan-v2');
  verifyMaintenancePlanLink(plan);
  const actualRoot = safePath(options.scriptRoot ?? MODULE_ROOT, 'executing repository', { kind: 'directory' });
  if (!equalPath(actualRoot, plan.request.candidateRoot)) fail('candidate command is not running from its requested candidateRoot');
  const rebuilt = buildMaintenancePlan(plan.request, { ...options, scriptRoot: actualRoot, sourceRoot: plan.bindings.searchBinding.baselineRoot });
  if (rebuilt.digest !== plan.digest || canonical(rebuilt) !== canonical(plan)) fail('reviewed plan digest or bound inputs have drifted');
  return rebuilt;
}

export function stableJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
