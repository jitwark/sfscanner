import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bodySnapshot, gitInfo, inputSnapshot, MODULE_ROOT, privacyInputs, stableJson, verifyMaintenancePlan, SIDECARS } from './maintenance-plan.mjs';
import { safePath } from './maintenance-identity.mjs';
import {
  SEARCH_BINDING_STEP_ID, assertCandidateChangePaths, assertExactDirtyStaged, assertPostBindSource,
  assertPreBindSource, assertImmutableSourceGit, bindMaintenanceSearchRelease, verifyMaintenanceSearchRelease,
} from './maintenance-search-binding.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(`maintenance candidate refused: ${message}`); };
const now = () => new Date().toISOString();
const TIMEOUT_MS = 12 * 60 * 60 * 1000;

function writeReceipt(file, value) { const temp = `${file}.tmp`; writeFileSync(temp, stableJson(value), { flag: 'w' }); renameSync(temp, file); }
function logName(id, ext) { return `${id.replace(/[^A-Za-z0-9_-]/gu, '_')}.${ext}.log`; }
function writeLogs(context, id, stdout, stderr) {
  const stdoutPath = path.join(context.logDir, logName(id, 'stdout')); const stderrPath = path.join(context.logDir, logName(id, 'stderr'));
  writeFileSync(stdoutPath, stdout); writeFileSync(stderrPath, stderr); return { stdoutPath, stderrPath };
}

function runProcess(argv, cwd, env, signal) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.some((part) => typeof part !== 'string')) fail('internal command argv is malformed');
  return new Promise((resolve, reject) => {
    const [exe, ...args] = argv; const child = spawn(exe, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; const err = []; let timedOut = false; let closed = false;
    const kill = () => { if (!closed) child.kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, TIMEOUT_MS);
    const cancel = () => kill(); signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (chunk) => out.push(chunk)); child.stderr.on('data', (chunk) => err.push(chunk));
    child.once('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(error); });
    child.once('close', (code, childSignal) => {
      closed = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      resolve({ exitCode: code, signal: childSignal, timedOut, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

async function invoke(step, argv, context, execute = context.executeStep) {
  const start = context.startTime(); let result;
  try { result = execute ? await execute({ ...step, argv }, context) : await runProcess(argv, context.root, context.env, context.signal); }
  catch (error) { result = { exitCode: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) }; }
  const stdout = Buffer.from(result.stdout ?? ''); const stderr = Buffer.from(result.stderr ?? '');
  const files = writeLogs(context, step.id, stdout, stderr);
  return {
    argv, cwd: context.root, startedAt: start, endedAt: context.startTime(), exitCode: result.exitCode ?? null,
    signal: result.signal ?? null, timedOut: result.timedOut === true, stdoutSha256: sha(stdout), stderrSha256: sha(stderr),
    stdoutLog: path.relative(context.runDir, files.stdoutPath).replaceAll('\\', '/'), stderrLog: path.relative(context.runDir, files.stderrPath).replaceAll('\\', '/'),
  };
}

async function invokeInternal(step, context, action) {
  const start = context.startTime(); const value = await action(); const stdout = Buffer.from(stableJson(value)); const files = writeLogs(context, step.id, stdout, Buffer.alloc(0));
  return { argv: [], cwd: context.root, startedAt: start, endedAt: context.startTime(), exitCode: 0, signal: null, timedOut: false,
    stdoutSha256: sha(stdout), stderrSha256: sha(''), stdoutLog: path.relative(context.runDir, files.stdoutPath).replaceAll('\\', '/'), stderrLog: path.relative(context.runDir, files.stderrPath).replaceAll('\\', '/') };
}

function seedSidecars(plan, runDir) {
  const input = path.join(runDir, 'add-source-data', 'scanner'); mkdirSync(input, { recursive: true });
  for (const name of SIDECARS) {
    const source = path.join(plan.request.candidateRoot, 'data/scanner', name); const expected = plan.bindings.scannerSidecars.find((item) => item.path === `scanner/${name}`);
    if (!expected || sha(readFileSync(source)) !== expected.sha256) fail(`scanner sidecar changed before seeding: ${name}`);
    copyFileSync(source, path.join(input, name));
  }
}

export async function commitCandidateData(plan, context, step, record) {
  const before = await context.inspectGit(context.root); const dirty = assertCandidateChangePaths(before.dirtyPaths ?? []);
  if (before.head !== plan.bindings.candidateGit.head) fail('candidate HEAD differs from the reviewed HEAD before add');
  if ((before.stagedPaths ?? []).length) fail('candidate must have no staged paths before the fixed two-path add');
  const hooks = path.join(context.runDir, 'empty-hooks'); mkdirSync(hooks, { recursive: true });
  const commands = step.argv; const subcommands = []; const originalEnv = context.env;
  const identity = plan.bindings.candidateGit;
  context.env = { ...originalEnv, GIT_AUTHOR_NAME: identity.userName, GIT_AUTHOR_EMAIL: identity.userEmail, GIT_COMMITTER_NAME: identity.userName, GIT_COMMITTER_EMAIL: identity.userEmail, GIT_AUTHOR_DATE: plan.request.generatedAt, GIT_COMMITTER_DATE: plan.request.generatedAt };
  try {
  for (let i = 0; i < commands.length; i++) {
    const argv = commands[i]; const entry = await invoke({ id: `${step.id}-${i + 1}` }, argv, context, context.executeGitStep ?? null); subcommands.push(entry);
    if (entry.exitCode !== 0 || entry.signal || entry.timedOut) fail(`candidate data commit command ${i + 1} failed`);
    if (i === 0) {
      const staged = await context.inspectGit(context.root, 'staged'); assertExactDirtyStaged(dirty, staged.stagedPaths ?? []);
      if (staged.head !== plan.bindings.candidateGit.head) fail('candidate HEAD changed during add');
    }
  }
  const after = await context.inspectGit(context.root);
  if (!after.clean || !after.head || after.head === before.head) fail('candidate data commit did not leave a clean new HEAD');
  if (JSON.stringify(after.parents) !== JSON.stringify([plan.bindings.candidateGit.head])) fail('candidate commit must have exactly the reviewed HEAD as its parent');
  context.committedHead = after.head;
  record.commit = { before: before.head, after: after.head, paths: dirty };
  return { ...record, subcommands };
  } finally { context.env = originalEnv; }
}

function checkExternalDrift(plan) {
  const { request, bindings } = plan; const root = request.candidateRoot;
  if (inputSnapshot(request.releaseSnapshot, 'release snapshot').sha256 !== bindings.releaseSnapshot.sha256) fail('release snapshot changed during the run');
  if (inputSnapshot(path.join(root, bindings.scannerRulings.path), 'scanner ruling inventory').sha256 !== bindings.scannerRulings.sha256) fail('scanner ruling inventory changed during the run');
  const currentBodies = bodySnapshot(request.bodyMap, request.bodySources, root);
  if (JSON.stringify(currentBodies) !== JSON.stringify(bindings.bodyInputs)) fail('body map or retained body folders changed during the run');
  if (JSON.stringify(privacyInputs(request)) !== JSON.stringify(bindings.privacyInputs)) fail('privacy body directory or snapshot changed during the run');
}

function verifyBound(plan, operations) {
  const verification = verifyMaintenanceSearchRelease(plan, operations.verify);
  assertPostBindSource(plan, verification); return verification;
}

function bindingSummary(verification) {
  const { receipt, receiptSha256, release, dataIdentity, paths } = verification;
  return { schemaVersion: receipt.schemaVersion, receiptSha256, receiptPath: paths.receipt, release, dataIdentity, fixtureSha256: receipt.generated.fixtureSha256 };
}

async function assertCommittedCandidate(plan, context) {
  const committed = await context.inspectGit(context.root);
  if (!context.committedHead || !committed.clean || committed.head !== context.committedHead ||
      JSON.stringify(committed.parents) !== JSON.stringify([plan.bindings.candidateGit.head])) {
    fail('committed candidate HEAD, clean state, or exact reviewed parent drifted');
  }
}

export async function runMaintenanceCandidate(reviewedPlan, options = {}) {
  const scriptRoot = path.resolve(options.scriptRoot ?? MODULE_ROOT);
  const plan = verifyMaintenancePlan(reviewedPlan, { ...options, scriptRoot });
  const root = plan.request.candidateRoot; const workRoot = path.join(root, '.work/maintenance'); const runDir = path.join(workRoot, plan.request.runId);
  const lock = path.join(workRoot, 'maintenance.lock'); mkdirSync(workRoot, { recursive: true });
  safePath(workRoot, 'candidate private work root', { kind: 'directory' }); safePath(lock, 'candidate maintenance lock', { missing: true });
  let handle; const token = `${randomUUID()}\n`;
  try { handle = openSync(lock, 'wx', 0o600); writeFileSync(handle, token); } catch (error) {
    try { if (handle !== undefined) closeSync(handle); if (readFileSync(lock, 'utf8') === token) rmSync(lock); } catch {}
    fail(error.code === 'EEXIST' ? 'candidate maintenance lock already exists' : 'could not acquire candidate maintenance lock');
  }
  let receipt; let receiptPath; let completed = 0; let activeStep; let bindingState;
  const operations = { bind: options.searchBinding?.bind, verify: options.searchBinding?.verify };
  try {
    if (existsSync(runDir)) fail('candidate run directory already exists');
    mkdirSync(runDir); const logDir = path.join(runDir, 'logs'); mkdirSync(logDir); mkdirSync(plan.bindings.searchBinding.receiptRoot);
    receiptPath = path.join(runDir, 'receipt.json');
    receipt = { schemaVersion: 'maintenance-receipt-v1', status: 'running', planDigest: plan.digest, requestIdentity: sha(Buffer.from(JSON.stringify(plan.request))), sourceIdentity: plan.bindings.source.sha256, lockIdentity: plan.bindings.candidate.files.find((file) => file.path === 'package-lock.json')?.sha256, privacySnapshotSha256: plan.bindings.privacyInputs.snapshot.sha256, privacyBodiesTreeSha256: plan.bindings.privacyInputs.bodies.treeSha256, runtime: plan.bindings.runtime, steps: [] };
    writeReceipt(receiptPath, receipt);
    const env = { ...process.env, NEXT_PUBLIC_SITE_URL: plan.request.siteUrl, NEXT_PUBLIC_BASE_PATH: plan.request.basePath, PLAYWRIGHT_BASE_PATH: plan.request.basePath, REFERENCE_DATE: plan.request.generatedAt.slice(0, 10), OFFICIAL_BODIES_DIR: plan.request.privacyBodies, OFFICIAL_BODIES_SNAPSHOT: plan.request.privacySnapshot };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = `${path.dirname(plan.bindings.runtime.nodeExecutable)}${path.delimiter}${env[pathKey] ?? ''}`;
    const context = { root, runDir, logDir, env, signal: options.signal, startTime: options.startTime ?? now, executeStep: options.executeStep, executeGitStep: options.executeGitStep, inspectGit: options.inspectGit ?? options.git ?? ((candidate) => gitInfo(candidate)) };
    for (const original of plan.steps) {
      if (options.signal?.aborted) fail('candidate run was cancelled');
      const step = { ...original }; let result; activeStep = step;
      assertImmutableSourceGit(plan, await context.inspectGit(plan.bindings.sourceGit.root));
      if (context.committedHead) await assertCommittedCandidate(plan, context);
      const startedAt = context.startTime();
      if (step.id === 'seed-scanner-sidecars') seedSidecars(plan, runDir);
      if (step.id === 'stage-release') mkdirSync(plan.request.releaseRoot);
      if (step.id === 'verify-release' && receipt.releaseId) step.argv = step.argv.map((arg) => arg === '<staged-release-id>' ? receipt.releaseId : arg);
      if (step.id === 'stage-release' || step.id === 'verify-release') {
        context.env.NEXT_PUBLIC_SITE_URL = plan.request.siteUrl;
        context.env.NEXT_PUBLIC_BASE_PATH = plan.request.basePath;
        context.env.PLAYWRIGHT_BASE_PATH = plan.request.basePath;
      }
      if (step.id === 'seed-scanner-sidecars') result = { argv: [], cwd: root, startedAt, endedAt: context.startTime(), exitCode: 0, signal: null, timedOut: false, stdoutSha256: sha(''), stderrSha256: sha(''), log: 'sidecars seeded' };
      else if (step.id === SEARCH_BINDING_STEP_ID) {
        assertPreBindSource(plan); checkExternalDrift(plan);
        result = await invokeInternal(step, context, async () => bindMaintenanceSearchRelease(plan, operations.bind));
        bindingState = verifyBound(plan, operations); receipt.searchBinding = bindingSummary(bindingState);
      } else if (step.id === 'commit-data') {
        verifyBound(plan, operations); result = await commitCandidateData(plan, context, step, { argv: step.argv, cwd: root, startedAt, endedAt: context.startTime() });
      } else {
        const record = await invoke(step, step.argv, context); result = { ...record, startedAt };
        if (record.exitCode !== 0 || record.signal || record.timedOut) fail(`step ${step.id} failed (exit=${String(record.exitCode)}, signal=${String(record.signal)}, timeout=${String(record.timedOut)})`);
        if (step.id === 'stage-release') {
          let staged; try { staged = JSON.parse(readFileSync(path.join(logDir, logName(step.id, 'stdout')), 'utf8')); } catch { fail('stage-release did not return JSON'); }
          if (typeof staged.releaseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(staged.releaseId)) fail('stage-release returned no valid releaseId');
          receipt.releaseId = staged.releaseId;
        }
        if (step.id === 'verify-release') {
          let verified; try { verified = JSON.parse(readFileSync(path.join(logDir, logName(step.id, 'stdout')), 'utf8')); } catch { fail('release verifier did not return JSON'); }
          if (verified.status !== 'verified' || verified.releaseId !== receipt.releaseId) fail('explicit staged release verification did not match');
        }
      }
      assertImmutableSourceGit(plan, await context.inspectGit(plan.bindings.sourceGit.root));
      if (bindingState) { bindingState = verifyBound(plan, operations); receipt.searchBinding = bindingSummary(bindingState); }
      if (context.committedHead) await assertCommittedCandidate(plan, context);
      receipt.steps.push({ id: step.id, ...result }); completed++; activeStep = undefined;
      receipt.completedSteps = completed; writeReceipt(receiptPath, receipt);
    }
    checkExternalDrift(plan); bindingState = verifyBound(plan, operations); receipt.searchBinding = bindingSummary(bindingState);
    await assertCommittedCandidate(plan, context);
    receipt.status = 'candidate-verified'; receipt.completedAt = context.startTime();
    writeReceipt(receiptPath, receipt);
    return { status: receipt.status, releaseId: receipt.releaseId, receiptPath, planDigest: plan.digest };
  } catch (error) {
    if (receipt && receiptPath) { const failure = error instanceof Error ? error.message : String(error); if (activeStep) receipt.steps.push({ id: activeStep.id, argv: activeStep.argv, cwd: root, status: 'failed', failure }); receipt.status = 'failed'; receipt.failure = failure; receipt.completedSteps = completed; writeReceipt(receiptPath, receipt); }
    throw error;
  } finally {
    try { closeSync(handle); } catch {}
    try { if (readFileSync(lock, 'utf8') === token) rmSync(lock); } catch {}
  }
}
