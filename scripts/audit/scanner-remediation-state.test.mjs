import { existsSync, readdirSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { transitionQueue, validateQueueFile } from './scanner-remediation-state.mjs';
import { canonicalJson, sha256 } from './scanner-remediation-state-receipts.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SCRATCH_ROOT = path.join(REPO_ROOT, 'pipeline/.work/scanner-final-work');
const CLI = path.join(REPO_ROOT, 'scripts/audit/scanner-remediation-state.mjs');
const SCHEMA_PATH = path.join(REPO_ROOT, 'docs/audit/2026-10-24-master-remediation/TASK-STATE-SCHEMA.json');
const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
const roots = [];
let sequence = 0;

const DEPENDENCIES = {
  '01': [], '02': ['01'], '03': ['02'], '04': ['01', '02'], '05': ['04'], '06': ['01', '02'],
  '07': ['01'], '08': ['06', '07'], '09': ['06', '07', '08'], '10': ['09'], '11': ['06', '09', '10'],
  '12': ['08', '11'], '13': ['05'], '14': ['13'], '15': ['12', '14'], '16': ['05', '12', '14'],
  '17': ['15', '16'], '18': ['06', '15'], '19': ['18'], '20': ['06'], '21': ['06'],
  '22': ['20', '21'], '23': ['02', '06', '12', '17', '19', '20', '21'], '24': ['23'],
  '25': ['05', '16', '17', '23'], '26': ['25'], '27': ['22', '24', '25', '26'], '28': ['27'],
  '29': ['20', '21', '22', '27'], '30': ['03', '28', '29'],
};
const MILESTONES = {
  '02': [['02a', ['01']], ['02b', ['02a']]],
  '06': [['06a', ['02']], ['06b', ['02']], ['06c', ['02']]],
  '22': [['22a', ['20', '21']], ['22b', ['22a', '23']]],
};
const PREPARABLE = new Set(['03', '05', '06', '13', '16']);

function syntheticQueue() {
  return {
    schemaVersion: 'scanner-final-remediation-queue-v1',
    revision: 0,
    date: '2026-10-24',
    status: 'REVIEWED_PLAN_QUALIFICATION_REQUIRED',
    authority: 'synthetic test queue',
    scope: '30 synthetic task identities',
    canonicalLeafCount: 48,
    originalChunkCount: 5,
    executionWaveCount: 7,
    acceptedLeafCount: null,
    completionPercent: null,
    roles: { controller: 'c', reviewer: 'r', luna: 'l', implementer: 'i' },
    restrictionState: 'PROCESS_ONLY',
    tasks: Object.keys(DEPENDENCIES).map((id) => ({
      id,
      title: `Task ${id}`,
      wave: 1,
      state: 'PLANNED',
      readiness: id === '01' ? 'QUALIFICATION_REQUIRED' : PREPARABLE.has(id) ? 'PREPARABLE_LOCAL' : 'DEPENDENCY_OR_BRIEF_REQUIRED',
      dependsOn: [...DEPENDENCIES[id]],
      attempts: 0,
      maxSubmittedAttempts: 3,
      owner: 'controller',
      writer: 'writer',
      reviewer: 'reviewer',
      briefRequiredBeforeDispatch: true,
      maxChangedProductTestPathsPerChild: 5,
      acceptanceReceipt: null,
      plan: 'plan.md',
      planHeading: `Task ${id}`,
      ...(MILESTONES[id]
        ? {
            milestones: MILESTONES[id].map(([mid, dependsOn]) => ({ id: mid, dependsOn: [...dependsOn], scope: `scope ${mid}` })),
            completionRequiresMilestones: MILESTONES[id].map(([mid]) => mid),
          }
        : {}),
      ...(id === '22' ? { verificationDependsOn: ['23'] } : {}),
      ...(id === '23' ? { dependencyMilestones: ['06c', '02b'] } : {}),
    })),
    planQualityReview: { scope: 'synthetic', outcome: 'PASS', revision: 1, path: 'final-review/REPORT.md' },
  };
}

function rel(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
}

async function makeWorld(queue = syntheticQueue(), { eol = '\n' } = {}) {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(SCRATCH_ROOT, 'task02a-test-'));
  roots.push(dir);
  const file = path.join(dir, 'queue.json');
  const world = { dir, file, fileRel: rel(file), queue, eol };
  await persist(world);
  return world;
}

async function persist(world, queue = world.queue) {
  const text = JSON.stringify(queue, null, 2).replace(/\n/gu, world.eol);
  await writeFile(world.file, `${text}${world.eol}`, 'utf8');
}

async function makeReceipt(world, spec = {}) {
  sequence += 1;
  const taskId = spec.taskId ?? '01';
  const milestoneId = spec.milestoneId ?? null;
  const attempt = spec.attempt ?? 1;
  const outcome = spec.outcome ?? 'PASS';
  const tag = `${taskId}${milestoneId ?? ''}-${attempt}-${sequence}`;
  const evidenceOnly = spec.evidenceOnly ?? false;
  let sourceFiles = [];
  if (!evidenceOnly) {
    const sourceFile = spec.sourcePath ?? path.join(world.dir, 'src', `${tag}.mjs`);
    await mkdir(path.dirname(sourceFile), { recursive: true });
    if (spec.sourceContent !== undefined) await writeFile(sourceFile, spec.sourceContent, 'utf8');
    else if (!existsSync(sourceFile)) await writeFile(sourceFile, `export const value = ${sequence};\n`, 'utf8');
    const bytes = await readFile(sourceFile);
    sourceFiles = [{ path: rel(sourceFile), sha256: sha256(bytes) }];
  }
  const logFile = spec.logPath ?? path.join(world.dir, 'logs', `${tag}.log`);
  const reviewFile = spec.reviewPath ?? path.join(world.dir, 'reviews', `${tag}.md`);
  const receiptFile = spec.receiptPath ?? path.join(world.dir, 'receipts', `${tag}.json`);
  await mkdir(path.dirname(logFile), { recursive: true });
  await mkdir(path.dirname(reviewFile), { recursive: true });
  await writeFile(logFile, spec.logContent ?? 'green\n', 'utf8');
  await writeFile(reviewFile, spec.reviewContent ?? 'PASS\n', 'utf8');
  const logSha = sha256(await readFile(logFile));
  const reviewSha = sha256(await readFile(reviewFile));
  const receipt = {
    schemaVersion: 'scanner-remediation-task-receipt-v1',
    taskId,
    milestoneId,
    attempt,
    outcome,
    exitCode: outcome === 'PASS' ? 0 : null,
    commands: [
      {
        command: spec.command ?? 'node node_modules/vitest/vitest.mjs run --project scripts synthetic',
        cwd: spec.cwd ?? '.',
        expectedExitCode: 0,
        exitCode: outcome === 'PASS' ? 0 : null,
        selectedFiles: spec.selectedFiles ?? 1,
        selectedTests: spec.selectedTests !== undefined ? spec.selectedTests : evidenceOnly ? null : 1,
        log: { path: rel(logFile), sha256: logSha },
      },
    ],
    sourceFiles,
    sourceDigest: sha256(canonicalJson([...sourceFiles].sort((left, right) => (left.path < right.path ? -1 : 1)))),
    review: { specVerdict: spec.specVerdict ?? 'PASS', qualityVerdict: spec.qualityVerdict ?? 'PASS', path: rel(reviewFile), sha256: reviewSha },
    evidenceDigest: '',
    changedPaths: [...new Set([...sourceFiles.map((file) => file.path), rel(logFile), rel(reviewFile)])],
    productTestPaths: sourceFiles
      .filter((file) => /^(app|packages|pipeline|scripts|contracts)\//u.test(file.path) && /\.(ts|tsx|js|jsx|mjs|cjs)$/u.test(file.path))
      .map((file) => file.path),
    notes: ['synthetic receipt'],
  };
  const { evidenceDigest: _ignored, ...withoutDigest } = receipt;
  receipt.evidenceDigest = sha256(canonicalJson(withoutDigest));
  await mkdir(path.dirname(receiptFile), { recursive: true });
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(receiptFile, bytes, 'utf8');
  return { file: receiptFile, rel: rel(receiptFile), sha256: sha256(bytes), receipt, sourceFiles };
}

async function markAccepted(world, ids) {
  const accept = async (task, entry, milestoneId) => {
    const receipt = await makeReceipt(world, {
      taskId: task.id,
      milestoneId,
      attempt: 1,
      evidenceOnly: task.id === '01' && !milestoneId,
    });
    entry.state = 'ACCEPTED';
    entry.attempts = 1;
    entry.acceptanceReceipt = { path: receipt.rel, sha256: receipt.sha256 };
    entry.receiptHistory = [{ path: receipt.rel, sha256: receipt.sha256, attempt: 1, state: 'ACCEPTED' }];
  };
  for (const id of ids) {
    const milestoneId = /^[0-9]{2}[a-z]$/u.test(id) ? id : null;
    const task = milestoneId
      ? world.queue.tasks.find((candidate) => (candidate.milestones ?? []).some((milestone) => milestone.id === id))
      : world.queue.tasks.find((candidate) => candidate.id === id);
    const entry = milestoneId ? task.milestones.find((milestone) => milestone.id === id) : task;
    if (milestoneId) {
      await accept(task, entry, milestoneId);
    } else {
      await accept(task, entry, null);
      for (const childId of task.completionRequiresMilestones ?? []) {
        const child = task.milestones.find((milestone) => milestone.id === childId);
        if (child) await accept(task, child, childId);
      }
    }
  }
  await persist(world);
}

function options(world, overrides = {}) {
  return { file: world.fileRel, expectedRevision: world.queue.revision, taskId: '03', to: 'BLOCKED_DEPENDENCY', ...overrides };
}

async function queueBytes(world) {
  return readFile(world.file, 'utf8');
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop(), { recursive: true, force: true });
});

describe('transitionQueue', () => {
  it('persists a valid evidence-only first acceptance and increments revision once', async () => {
    const world = await makeWorld();
    const receipt = await makeReceipt(world, { taskId: '01', evidenceOnly: true });
    const result = await transitionQueue(
      options(world, { taskId: '01', to: 'ACCEPTED', receiptPath: receipt.rel }),
    );
    expect(result.outcome).toBe('PASS');
    expect(result.previousRevision).toBe(0);
    expect(result.revision).toBe(1);
    const saved = JSON.parse(await queueBytes(world));
    const task = saved.tasks.find((candidate) => candidate.id === '01');
    expect(task.state).toBe('ACCEPTED');
    expect(task.attempts).toBe(1);
    expect(task.acceptanceReceipt).toEqual({ path: receipt.rel, sha256: receipt.sha256 });
    expect(task.receiptHistory).toEqual([{ path: receipt.rel, sha256: receipt.sha256, attempt: 1, state: 'ACCEPTED' }]);
    expect(existsSync(`${world.file}.lock`)).toBe(false);
    expect((await readdir(world.dir)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('keeps one attempt across submit, fixes and accept reloads', async () => {
    const world = await makeWorld();
    await markAccepted(world, ['01']);
    const first = await makeReceipt(world, { taskId: '02', milestoneId: '02a', attempt: 1 });
    await transitionQueue(options(world, { taskId: '02', milestoneId: '02a', to: 'SUBMITTED', receiptPath: first.rel }));
    world.queue = JSON.parse(await queueBytes(world));
    const fixes = await makeReceipt(world, { taskId: '02', milestoneId: '02a', attempt: 1, outcome: 'FAIL', exitCode: 1 });
    await transitionQueue(options(world, { taskId: '02', milestoneId: '02a', to: 'REQUIRED_FIXES', receiptPath: fixes.rel }));
    world.queue = JSON.parse(await queueBytes(world));
    const second = await makeReceipt(world, { taskId: '02', milestoneId: '02a', attempt: 2 });
    await transitionQueue(options(world, { taskId: '02', milestoneId: '02a', to: 'SUBMITTED', receiptPath: second.rel }));
    world.queue = JSON.parse(await queueBytes(world));
    const acceptance = await makeReceipt(world, {
      taskId: '02',
      milestoneId: '02a',
      attempt: 2,
      sourcePath: path.join(REPO_ROOT, second.sourceFiles[0].path),
    });
    const accepted = await transitionQueue(
      options(world, { taskId: '02', milestoneId: '02a', to: 'ACCEPTED', receiptPath: acceptance.rel }),
    );
    expect(accepted.outcome).toBe('PASS');
    const saved = JSON.parse(await queueBytes(world));
    const milestone = saved.tasks.find((task) => task.id === '02').milestones.find((candidate) => candidate.id === '02a');
    expect(milestone.attempts).toBe(2);
    expect(milestone.receiptHistory.map((entry) => entry.state)).toEqual(['SUBMITTED', 'REQUIRED_FIXES', 'SUBMITTED', 'ACCEPTED']);
  });

  it('leaves bytes untouched on stale revision and on lock contention', async () => {
    const world = await makeWorld();
    const before = await queueBytes(world);
    world.queue.revision = 1;
    await persist(world);
    const bumped = await queueBytes(world);
    await expect(transitionQueue(options(world, { expectedRevision: 0 }))).rejects.toThrow(/STALE_REVISION/u);
    expect(await queueBytes(world)).toBe(bumped);
    world.queue.revision = 0;
    await persist(world);
    const reset = await queueBytes(world);
    await writeFile(`${world.file}.lock`, 'held by test\n', 'utf8');
    await expect(transitionQueue(options(world, {}))).rejects.toThrow(/LOCK_HELD/u);
    expect(await queueBytes(world)).toBe(reset);
    expect(existsSync(`${world.file}.lock`)).toBe(true);
    expect(before).toBe(reset);
  });

  it('rejects hash-changed receipt evidence without writing the queue', async () => {
    const world = await makeWorld();
    const receipt = await makeReceipt(world, { taskId: '01' });
    const source = path.join(REPO_ROOT, receipt.sourceFiles[0].path);
    await writeFile(source, 'export const value = 999;\n', 'utf8');
    const before = await queueBytes(world);
    await expect(
      transitionQueue(options(world, { taskId: '01', to: 'SUBMITTED', receiptPath: receipt.rel })),
    ).rejects.toThrow(/EVIDENCE_DIGEST_MISMATCH/u);
    expect(await queueBytes(world)).toBe(before);
  });

  it('reports historical source drift for accepted dependencies without rejecting', async () => {
    const world = await makeWorld();
    const accepted = await makeReceipt(world, { taskId: '01' });
    const entry = world.queue.tasks.find((task) => task.id === '01');
    entry.state = 'ACCEPTED';
    entry.attempts = 1;
    entry.acceptanceReceipt = { path: accepted.rel, sha256: accepted.sha256 };
    entry.receiptHistory = [{ path: accepted.rel, sha256: accepted.sha256, attempt: 1, state: 'ACCEPTED' }];
    await persist(world);
    await writeFile(path.join(REPO_ROOT, accepted.sourceFiles[0].path), 'export const value = 777;\n', 'utf8');
    const result = await transitionQueue(options(world, { taskId: '02', to: 'IN_PROGRESS' }));
    expect(result.outcome).toBe('PASS');
    expect(result.sourceDrift).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: '01', path: accepted.sourceFiles[0].path, expectedSha256: accepted.sourceFiles[0].sha256 }),
      ]),
    );
  });

  it('rejects a changed protected fixture', async () => {
    const world = await makeWorld();
    const fixture = path.join(world.dir, 'fixture.json');
    await writeFile(fixture, '{"pinned":true}\n', 'utf8');
    const bytes = await readFile(fixture);
    world.queue.protectedFixtures = [{ path: rel(fixture), sha256: sha256(bytes) }];
    await persist(world);
    await writeFile(fixture, '{"pinned":false}\n', 'utf8');
    const before = await queueBytes(world);
    await expect(transitionQueue(options(world, {}))).rejects.toThrow(/PROTECTED_FIXTURE_CHANGED/u);
    expect(await queueBytes(world)).toBe(before);
  });

  it('refuses absolute, traversal, drive, UNC, URL, NUL and backslash receipt paths', async () => {
    const world = await makeWorld();
    const before = await queueBytes(world);
    for (const unsafe of ['/abs.json', '../escape.json', 'C:/escape.json', '\\\\server\\share\\x.json', 'https://example.test/x.json', 'bad\0name.json', 'a\\b.json']) {
      await expect(
        transitionQueue(options(world, { taskId: '01', to: 'SUBMITTED', receiptPath: unsafe })),
      ).rejects.toThrow(/UNSAFE_PATH/u);
      expect(await queueBytes(world)).toBe(before);
    }
  });

  it('refuses a receipt whose realpath escapes containment', async () => {
    const world = await makeWorld();
    const receipt = await makeReceipt(world, { taskId: '01' });
    const outside = path.join(os.tmpdir(), 'outside-receipt.json');
    const io = {
      ...fsp,
      realpath: async (target, ...args) =>
        target.endsWith(path.basename(receipt.file)) ? outside : fsp.realpath(target, ...args),
    };
    await expect(
      transitionQueue(options(world, { taskId: '01', to: 'SUBMITTED', receiptPath: receipt.rel, io })),
    ).rejects.toThrow(/UNSAFE_PATH/u);
  });

  it('refuses a queue path outside the write targets and owned scratch', async () => {
    const world = await makeWorld();
    await expect(
      transitionQueue({ ...options(world), file: 'scripts/audit/scanner-remediation-state.mjs' }),
    ).rejects.toThrow(/UNSAFE_PATH/u);
    await expect(
      transitionQueue({ ...options(world), file: path.join(os.tmpdir(), 'queue.json') }),
    ).rejects.toThrow(/UNSAFE_PATH/u);
  });

  it('detects a concurrent revision change and removes its temp file', async () => {
    const world = await makeWorld();
    const before = await queueBytes(world);
    let targetReads = 0;
    const io = {
      ...fsp,
      async readFile(target, ...args) {
        if (path.resolve(target) === path.resolve(world.file)) {
          targetReads += 1;
          if (targetReads === 2) return `${JSON.stringify({ ...world.queue, revision: 9 }, null, 2)}\n`;
        }
        return fsp.readFile(target, ...args);
      },
    };
    await expect(transitionQueue(options(world, { io }))).rejects.toThrow(/CONCURRENT_REVISION/u);
    expect(await queueBytes(world)).toBe(before);
    expect((await readdir(world.dir)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('surfaces replace failure and the owned temp file for controller recovery', async () => {
    const world = await makeWorld();
    const before = await queueBytes(world);
    const io = {
      ...fsp,
      async rename() {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      },
    };
    const error = await transitionQueue(options(world, { io })).catch((caught) => caught);
    expect(error.message).toMatch(/REPLACE_FAILED/u);
    expect(error.details.tempPath).toBeTruthy();
    expect(error.message).toContain('recovery');
    expect(await queueBytes(world)).toBe(before);
    expect(existsSync(error.details.tempPath)).toBe(true);
    expect(existsSync(`${world.file}.lock`)).toBe(false);
  });

  it('reports a post-rename readback mismatch against the replaced target', async () => {
    const world = await makeWorld();
    let targetReads = 0;
    const io = {
      ...fsp,
      async readFile(target, ...args) {
        if (path.resolve(target) === path.resolve(world.file)) {
          targetReads += 1;
          if (targetReads === 3) return `${JSON.stringify({ ...world.queue, revision: 42 }, null, 2)}\n`;
        }
        return fsp.readFile(target, ...args);
      },
    };
    const error = await transitionQueue(options(world, { io })).catch((caught) => caught);
    expect(error.message).toMatch(/READBACK_MISMATCH/u);
    expect(error.details.targetPath).toBe(world.file);
  });
});

describe('CLI', () => {
  function run(args) {
    return spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  }

  it('validates a queue read-only and is deterministic', async () => {
    const world = await makeWorld();
    const before = await queueBytes(world);
    const first = run(['validate', '--file', world.fileRel]);
    expect(first.status).toBe(0);
    const parsed = JSON.parse(first.stdout);
    expect(parsed).toMatchObject({ command: 'validate', outcome: 'PASS', revision: 0 });
    expect(await queueBytes(world)).toBe(before);
    const second = run(['validate', '--file', world.fileRel]);
    expect(second.stdout).toBe(first.stdout);
    expect(await queueBytes(world)).toBe(before);
  });

  it('uses exit 2 for usage errors and exit 1 for unknown states', async () => {
    const world = await makeWorld();
    expect(run(['transition', '--file', world.fileRel, '--nonsense', 'x']).status).toBe(2);
    const unknown = run([
      'transition', '--file', world.fileRel, '--expected-revision', '0', '--task', '01', '--to', 'DONE',
    ]);
    expect(unknown.status).toBe(1);
    expect(JSON.parse(unknown.stdout).errors[0].code).toBe('UNKNOWN_STATE');
  });

  it('runs a valid transition and demonstrates stale revision and lock refusal', async () => {
    const world = await makeWorld();
    const ok = run(['transition', '--file', world.fileRel, '--expected-revision', '0', '--task', '03', '--to', 'BLOCKED_DEPENDENCY']);
    expect(ok.status).toBe(0);
    const stale = run(['transition', '--file', world.fileRel, '--expected-revision', '0', '--task', '03', '--to', 'IN_PROGRESS']);
    expect(stale.status).toBe(1);
    expect(JSON.parse(stale.stdout).errors[0].code).toBe('STALE_REVISION');
    await writeFile(`${world.file}.lock`, 'held\n', 'utf8');
    const locked = run(['transition', '--file', world.fileRel, '--expected-revision', '1', '--task', '03', '--to', 'IN_PROGRESS']);
    expect(locked.status).toBe(1);
    expect(JSON.parse(locked.stdout).errors[0].code).toBe('LOCK_HELD');
  });
});

describe('symlink containment', () => {
  it('refuses a symlinked receipt pointing outside the evidence roots', async () => {
    const world = await makeWorld();
    const outside = path.join(os.tmpdir(), `scanner-state-outside-${process.pid}.json`);
    await writeFile(outside, '{}\n', 'utf8');
    const link = path.join(world.dir, 'linked-receipt.json');
    try {
      await symlink(outside, link, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return;
      throw error;
    }
    await expect(
      transitionQueue(options(world, { taskId: '01', to: 'SUBMITTED', receiptPath: rel(link) })),
    ).rejects.toThrow(/UNSAFE_PATH/u);
  });
});

describe('candidate2 repairs', () => {
  it('preserves the queue newline convention across a semantic transition', async () => {
    const world = await makeWorld(syntheticQueue(), { eol: '\r\n' });
    const before = await queueBytes(world);
    expect(before.includes('\r\n')).toBe(true);
    const result = await transitionQueue(options(world, {}));
    const after = await queueBytes(world);
    const parsed = JSON.parse(after);
    expect(after.includes('\r\n')).toBe(true);
    expect(after.replace(/\r\n/gu, '').includes('\n')).toBe(false);
    expect(after.replace(/\r\n/gu, '\n')).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(result.queueSha256).toBe(sha256(after));
    expect(parsed.tasks.find((task) => task.id === '03').state).toBe('BLOCKED_DEPENDENCY');
  });

  it('refuses early task and milestone parking without altering bytes, and allows ceiling parking', async () => {
    const world = await makeWorld();
    const task = world.queue.tasks.find((candidate) => candidate.id === '03');
    task.state = 'REQUIRED_FIXES';
    task.attempts = 1;
    await persist(world);
    const before = await queueBytes(world);
    await expect(
      transitionQueue(options(world, { taskId: '03', to: 'PARKED_AFTER_ATTEMPT_CEILING' })),
    ).rejects.toThrow(/ATTEMPT_PARKED_EARLY/u);
    expect(await queueBytes(world)).toBe(before);
    task.attempts = 3;
    await persist(world);
    const parked = await transitionQueue(options(world, { taskId: '03', to: 'PARKED_AFTER_ATTEMPT_CEILING' }));
    expect(parked.outcome).toBe('PASS');
    expect(JSON.parse(await queueBytes(world)).tasks.find((candidate) => candidate.id === '03').state).toBe(
      'PARKED_AFTER_ATTEMPT_CEILING',
    );
    const milestoneWorld = await makeWorld();
    const milestone = milestoneWorld.queue.tasks.find((candidate) => candidate.id === '02').milestones[0];
    milestone.state = 'REQUIRED_FIXES';
    milestone.attempts = 1;
    await persist(milestoneWorld);
    const milestoneBefore = await queueBytes(milestoneWorld);
    await expect(
      transitionQueue(options(milestoneWorld, { taskId: '02', milestoneId: '02a', to: 'PARKED_AFTER_ATTEMPT_CEILING' })),
    ).rejects.toThrow(/ATTEMPT_PARKED_EARLY/u);
    expect(await queueBytes(milestoneWorld)).toBe(milestoneBefore);
  });

  it('accepts source bytes outside evidence roots with a real hash binding', async () => {
    const world = await makeWorld();
    const external = path.join(REPO_ROOT, 'pipeline/.work', `repair2-src-${process.pid}-${Date.now()}`);
    roots.push(external);
    const receipt = await makeReceipt(world, {
      taskId: '01',
      sourcePath: path.join(external, 'agent.mjs'),
      sourceContent: 'export const repaired = 2;\n',
    });
    expect(receipt.sourceFiles[0].path.startsWith('pipeline/.work/repair2-src-')).toBe(true);
    const result = await transitionQueue(options(world, { taskId: '01', to: 'ACCEPTED', receiptPath: receipt.rel }));
    expect(result.outcome).toBe('PASS');
    const saved = JSON.parse(await queueBytes(world));
    expect(saved.tasks.find((task) => task.id === '01').acceptanceReceipt).toEqual({
      path: receipt.rel,
      sha256: receipt.sha256,
    });
  });

  it.each(['SUBMITTED', 'BLOCKED_DEPENDENCY'])('accepts unchanged unsorted multi-file source from %s at the submitted attempt', async (state) => {
    const world = await makeWorld();
    await markAccepted(world, ['01']);
    const firstPath = path.join(world.dir, 'src', 'z-source.mjs');
    const secondPath = path.join(world.dir, 'src', 'a-source.mjs');
    await mkdir(path.dirname(secondPath), { recursive: true });
    await writeFile(secondPath, 'export const second = true;\n', 'utf8');
    const second = { path: rel(secondPath), sha256: sha256(await readFile(secondPath)) };
    const multiFileReceipt = async () => {
      const base = await makeReceipt(world, { taskId: '02', milestoneId: '02a', attempt: 1, sourcePath: firstPath, selectedFiles: 2, selectedTests: 2 });
      const sourceFiles = [...base.sourceFiles, second];
      const { evidenceDigest: _ignored, ...previous } = base.receipt;
      const receipt = {
        ...previous,
        sourceFiles,
        sourceDigest: sha256(canonicalJson([...sourceFiles].sort((left, right) => (left.path < right.path ? -1 : 1)))),
        productTestPaths: sourceFiles.map((source) => source.path),
        changedPaths: [...base.receipt.changedPaths, second.path],
      };
      await writeFile(base.file, `${JSON.stringify({ ...receipt, evidenceDigest: sha256(canonicalJson(receipt)) }, null, 2)}\n`, 'utf8');
      return base;
    };
    const submitted = await multiFileReceipt();
    await transitionQueue(options(world, { taskId: '02', milestoneId: '02a', to: 'SUBMITTED', receiptPath: submitted.rel }));
    world.queue = JSON.parse(await queueBytes(world));
    if (state === 'BLOCKED_DEPENDENCY') {
      await transitionQueue(options(world, { taskId: '02', milestoneId: '02a', to: state }));
      world.queue = JSON.parse(await queueBytes(world));
    }
    const reviewed = await multiFileReceipt();
    const result = await transitionQueue(options(world, { taskId: '02', milestoneId: '02a', to: 'ACCEPTED', receiptPath: reviewed.rel }));
    expect(result.outcome).toBe('PASS');
    const saved = JSON.parse(await queueBytes(world));
    const milestone = saved.tasks.find((task) => task.id === '02').milestones.find((candidate) => candidate.id === '02a');
    expect(milestone.state).toBe('ACCEPTED');
    expect(milestone.attempts).toBe(1);
    expect(milestone.receiptHistory.map((entry) => entry.state)).toEqual(['SUBMITTED', 'ACCEPTED']);
  });

  it('rejects changed candidate source at a consumed attempt and accepts unchanged source with new review metadata', async () => {
    const world = await makeWorld();
    await markAccepted(world, ['01']);
    const submitted = await makeReceipt(world, { taskId: '02', milestoneId: '02a', attempt: 1 });
    await transitionQueue(options(world, { taskId: '02', milestoneId: '02a', to: 'SUBMITTED', receiptPath: submitted.rel }));
    world.queue = JSON.parse(await queueBytes(world));
    await transitionQueue(options(world, { taskId: '02', milestoneId: '02a', to: 'BLOCKED_DEPENDENCY' }));
    world.queue = JSON.parse(await queueBytes(world));
    const changed = await makeReceipt(world, { taskId: '02', milestoneId: '02a', attempt: 1 });
    const before = await queueBytes(world);
    await expect(
      transitionQueue(options(world, { taskId: '02', milestoneId: '02a', to: 'ACCEPTED', receiptPath: changed.rel })),
    ).rejects.toThrow(/CANDIDATE_SCOPE_MISMATCH/u);
    expect(await queueBytes(world)).toBe(before);
    const review = await makeReceipt(world, {
      taskId: '02',
      milestoneId: '02a',
      attempt: 1,
      sourcePath: path.join(REPO_ROOT, submitted.sourceFiles[0].path),
      logPath: path.join(world.dir, 'logs', 'acceptance-02a.log'),
      reviewPath: path.join(world.dir, 'reviews', 'acceptance-02a.md'),
      receiptPath: path.join(world.dir, 'receipts', 'acceptance-02a.json'),
      reviewContent: 'SYNTHETIC acceptance review\n',
    });
    const accepted = await transitionQueue(
      options(world, { taskId: '02', milestoneId: '02a', to: 'ACCEPTED', receiptPath: review.rel }),
    );
    expect(accepted.outcome).toBe('PASS');
    const saved = JSON.parse(await queueBytes(world));
    const milestone = saved.tasks.find((task) => task.id === '02').milestones.find((candidate) => candidate.id === '02a');
    expect(milestone.attempts).toBe(1);
    expect(milestone.receiptHistory.map((entry) => entry.state)).toEqual(['SUBMITTED', 'ACCEPTED']);
  });

  it('rejects tampered submitted candidate bytes at acceptance', async () => {
    const world = await makeWorld();
    await markAccepted(world, ['01']);
    const submitted = await makeReceipt(world, { taskId: '02', milestoneId: '02a', attempt: 1 });
    await transitionQueue(options(world, { taskId: '02', milestoneId: '02a', to: 'SUBMITTED', receiptPath: submitted.rel }));
    world.queue = JSON.parse(await queueBytes(world));
    await writeFile(submitted.file, `${JSON.stringify({ ...submitted.receipt, notes: ['tampered candidate'] }, null, 2)}\n`, 'utf8');
    const review = await makeReceipt(world, {
      taskId: '02',
      milestoneId: '02a',
      attempt: 1,
      sourcePath: path.join(REPO_ROOT, submitted.sourceFiles[0].path),
      receiptPath: path.join(world.dir, 'receipts', 'tampered-acceptance.json'),
    });
    const before = await queueBytes(world);
    await expect(
      transitionQueue(options(world, { taskId: '02', milestoneId: '02a', to: 'ACCEPTED', receiptPath: review.rel })),
    ).rejects.toThrow(/ACCEPTED_RECEIPT_CHANGED/u);
    expect(await queueBytes(world)).toBe(before);
  });

  it('rejects historical containment escapes instead of downgrading them to drift', async () => {
    const world = await makeWorld();
    const accepted = await makeReceipt(world, { taskId: '01' });
    const task = world.queue.tasks.find((candidate) => candidate.id === '01');
    task.state = 'ACCEPTED';
    task.attempts = 1;
    task.acceptanceReceipt = { path: accepted.rel, sha256: accepted.sha256 };
    task.receiptHistory = [{ path: accepted.rel, sha256: accepted.sha256, attempt: 1, state: 'ACCEPTED' }];
    await persist(world);
    const sourceRel = accepted.sourceFiles[0].path;
    const outside = path.join(os.tmpdir(), `task02a-outside-${process.pid}.mjs`);
    const io = {
      ...fsp,
      realpath: async (target, ...args) =>
        path.resolve(target) === path.resolve(REPO_ROOT, sourceRel) ? outside : fsp.realpath(target, ...args),
    };
    const before = await queueBytes(world);
    await expect(
      transitionQueue(options(world, { taskId: '02', to: 'IN_PROGRESS', io })),
    ).rejects.toThrow(/UNSAFE_PATH/u);
    expect(await queueBytes(world)).toBe(before);
    const validated = await validateQueueFile(world.fileRel, { io });
    expect(validated.outcome).toBe('FAIL');
    expect(validated.errors.some((error) => error.code === 'UNSAFE_PATH')).toBe(true);
  });

  it('does not delete a replacement lock owned by another invocation', async () => {
    const world = await makeWorld();
    const io = {
      ...fsp,
      async readFile(target, ...args) {
        if (String(target).endsWith('.lock')) return 'foreign-token\n';
        return fsp.readFile(target, ...args);
      },
    };
    const result = await transitionQueue(options(world, { io }));
    expect(result.outcome).toBe('PASS');
    expect(result.warnings.some((warning) => warning.code === 'LOCK_RELEASE_SKIPPED')).toBe(true);
    expect(existsSync(`${world.file}.lock`)).toBe(true);
  });

  it('rejects a write-target symlink alias inside the workspace', async () => {
    const realRel = 'docs/audit/2026-10-24-master-remediation/TASK-QUEUE.json';
    const realFile = path.join(REPO_ROOT, realRel);
    const before = await readFile(realFile);
    const io = {
      ...fsp,
      realpath: async (target, ...args) =>
        path.resolve(target) === path.resolve(realFile) ? path.join(REPO_ROOT, 'README.md') : fsp.realpath(target, ...args),
    };
    await expect(
      transitionQueue({ file: realRel, expectedRevision: 0, taskId: '03', to: 'BLOCKED_DEPENDENCY', io }),
    ).rejects.toThrow(/UNSAFE_PATH/u);
    expect(await readFile(realFile)).toEqual(before);
  });

  it('turns non-string evidence paths into typed rejection', async () => {
    const world = await makeWorld();
    const receipt = await makeReceipt(world, { taskId: '01' });
    const object = JSON.parse(await readFile(receipt.file, 'utf8'));
    object.commands[0].log.path = 5;
    const broken = path.join(world.dir, 'receipts', 'non-string-path.json');
    await writeFile(broken, `${JSON.stringify(object, null, 2)}\n`, 'utf8');
    const error = await transitionQueue(
      options(world, { taskId: '01', to: 'SUBMITTED', receiptPath: rel(broken) }),
    ).catch((caught) => caught);
    expect(error.message).toMatch(/UNSAFE_PATH/u);
    expect(error.message).not.toMatch(/INTERNAL_ERROR|TypeError/u);
  });

  it('reports intended and observed readback hashes while retaining intended bytes', async () => {
    const world = await makeWorld();
    let targetReads = 0;
    const io = {
      ...fsp,
      async readFile(target, ...args) {
        if (path.resolve(target) === path.resolve(world.file)) {
          targetReads += 1;
          if (targetReads === 3) return `${JSON.stringify({ ...world.queue, revision: 42 }, null, 2)}\n`;
        }
        return fsp.readFile(target, ...args);
      },
    };
    const error = await transitionQueue(options(world, { io })).catch((caught) => caught);
    expect(error.message).toMatch(/READBACK_MISMATCH/u);
    expect(error.details.intendedHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(error.details.readbackHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(sha256(await readFile(world.file))).toBe(error.details.intendedHash);
  });
});

describe('candidate2 CLI guards', () => {
  function run(args) {
    return spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  }

  it('rejects meaningless and missing flags with exit 2', async () => {
    const world = await makeWorld();
    const receipt = await makeReceipt(world, { taskId: '01' });
    expect(run(['stop', '--file', world.fileRel, '--task', '03']).status).toBe(2);
    expect(run(['stop', '--file', world.fileRel, '--checkpoint', '--task', '03']).status).toBe(2);
    expect(
      run(['transition', '--file', world.fileRel, '--expected-revision', '0', '--task', '01', '--to', 'IN_PROGRESS', '--receipt', receipt.rel]).status,
    ).toBe(2);
    expect(run(['unknown-command']).status).toBe(2);
    expect(run(['validate']).status).toBe(2);
  });

  it('rejects malformed queues on validate and stop with exit 1', async () => {
    const world = await makeWorld();
    await writeFile(world.file, 'null\n', 'utf8');
    const validated = run(['validate', '--file', world.fileRel]);
    expect(validated.status).toBe(1);
    expect(JSON.parse(validated.stdout).errors[0].code).toBe('QUEUE_SHAPE');
    const stopped = run(['stop', '--file', world.fileRel]);
    expect(stopped.status).toBe(1);
    expect(JSON.parse(stopped.stdout).outcome).toBe('INVALID');
  });
});
