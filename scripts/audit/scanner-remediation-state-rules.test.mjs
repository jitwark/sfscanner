import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkStop,
  planTransition,
  validateQueue,
} from './scanner-remediation-state-rules.mjs';
import { assertAllowedMutations, canonicalJson, receiptScope, sha256, validateReceipt } from './scanner-remediation-state-receipts.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const schema = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'docs/audit/2026-10-24-master-remediation/TASK-STATE-SCHEMA.json'), 'utf8'),
);
const FIXTURE = 'pipeline/.work/scanner-final-work/rules-fixture';

const DEPENDENCIES = {
  '01': [],
  '02': ['01'],
  '03': ['02'],
  '04': ['01', '02'],
  '05': ['04'],
  '06': ['01', '02'],
  '07': ['01'],
  '08': ['06', '07'],
  '09': ['06', '07', '08'],
  '10': ['09'],
  '11': ['06', '09', '10'],
  '12': ['08', '11'],
  '13': ['05'],
  '14': ['13'],
  '15': ['12', '14'],
  '16': ['05', '12', '14'],
  '17': ['15', '16'],
  '18': ['06', '15'],
  '19': ['18'],
  '20': ['06'],
  '21': ['06'],
  '22': ['20', '21'],
  '23': ['02', '06', '12', '17', '19', '20', '21'],
  '24': ['23'],
  '25': ['05', '16', '17', '23'],
  '26': ['25'],
  '27': ['22', '24', '25', '26'],
  '28': ['27'],
  '29': ['20', '21', '22', '27'],
  '30': ['03', '28', '29'],
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

function makeReceipt({
  taskId = '02a',
  milestoneId = null,
  attempt = 1,
  outcome = 'PASS',
  verdict = { specVerdict: 'PASS', qualityVerdict: 'PASS' },
  sourceFiles = [{ path: 'scripts/audit/synthetic.mjs', sha256: 'a'.repeat(64) }],
  selectedTests = 1,
  commands,
  logPath = `${FIXTURE}/log-${taskId}-${attempt}.log`,
  reviewPath = `${FIXTURE}/review-${taskId}-${attempt}.md`,
  receiptPath = `${FIXTURE}/receipt-${taskId}-${attempt}.json`,
  extra = {},
} = {}) {
  const receipt = {
    schemaVersion: 'scanner-remediation-task-receipt-v1',
    taskId,
    milestoneId,
    attempt,
    outcome,
    exitCode: outcome === 'PASS' ? 0 : null,
    commands:
      commands ??
      [
        {
          command: 'node node_modules/vitest/vitest.mjs run --project scripts synthetic',
          cwd: '.',
          expectedExitCode: 0,
          exitCode: outcome === 'PASS' ? 0 : null,
          selectedFiles: 1,
          selectedTests,
          log: { path: logPath, sha256: 'b'.repeat(64) },
        },
      ],
    sourceFiles,
    sourceDigest: sha256(canonicalJson([...sourceFiles].sort((left, right) => (left.path < right.path ? -1 : 1)))),
    review: { specVerdict: verdict.specVerdict, qualityVerdict: verdict.qualityVerdict, path: reviewPath, sha256: 'd'.repeat(64) },
    evidenceDigest: '',
    changedPaths: [...new Set([...sourceFiles.map((file) => file.path), logPath, reviewPath])],
    productTestPaths: sourceFiles
      .filter((file) => /^(app|packages|pipeline|scripts|contracts)\//u.test(file.path) && /\.(ts|tsx|js|jsx|mjs|cjs)$/u.test(file.path))
      .map((file) => file.path),
    notes: ['synthetic receipt'],
    ...extra,
  };
  if (!('evidenceDigest' in extra)) {
    const { evidenceDigest: _ignored, ...withoutDigest } = receipt;
    receipt.evidenceDigest = sha256(canonicalJson(withoutDigest));
  }
  return { receiptPath, receiptSha: sha256(canonicalJson(receipt)), receipt };
}

function options(queue, overrides = {}) {
  const built = makeReceipt({ taskId: overrides.taskId ?? '02', milestoneId: overrides.milestoneId ?? null, attempt: overrides.attempt ?? 1 });
  return {
    taskId: overrides.taskId ?? '02',
    milestoneId: overrides.milestoneId ?? null,
    to: 'ACCEPTED',
    expectedRevision: queue.revision,
    receipt: built.receipt,
    receiptPath: built.receiptPath,
    receiptSha: built.receiptSha,
    evidenceVerified: true,
    ...overrides,
    receipt: overrides.receipt ?? built.receipt,
    receiptPath: overrides.receiptPath ?? built.receiptPath,
    receiptSha: overrides.receiptSha ?? built.receiptSha,
  };
}

function markAccepted(queue, ids) {
  const accept = (entry, taskId, milestoneId) => {
    const ref = { path: `${FIXTURE}/accepted-${milestoneId ?? taskId}.json`, sha256: 'f'.repeat(64) };
    entry.state = 'ACCEPTED';
    entry.attempts = 1;
    entry.acceptanceReceipt = ref;
    entry.receiptHistory = [{ ...ref, attempt: 1, state: 'ACCEPTED' }];
  };
  for (const id of ids) {
    const milestoneId = /^[0-9]{2}[a-z]$/u.test(id) ? id : null;
    const task = milestoneId
      ? queue.tasks.find((candidate) => (candidate.milestones ?? []).some((milestone) => milestone.id === id))
      : queue.tasks.find((candidate) => candidate.id === id);
    const entry = milestoneId ? task.milestones.find((milestone) => milestone.id === id) : task;
    accept(entry, task.id, milestoneId);
    if (!milestoneId) {
      for (const childId of task.completionRequiresMilestones ?? []) {
        const child = task.milestones.find((milestone) => milestone.id === childId);
        if (child) accept(child, task.id, childId);
      }
    }
  }
  return queue;
}

function codes(result) {
  return result.errors.map((error) => error.code);
}

describe('validateQueue', () => {
  it('accepts the synthetic revision-0 queue with 30 identities', () => {
    expect(validateQueue(syntheticQueue(), schema).errors).toEqual([]);
  });

  it('rejects duplicate task ids', () => {
    const queue = syntheticQueue();
    queue.tasks[29].id = '01';
    expect(codes(validateQueue(queue, schema))).toContain('TASK_ID_DUPLICATE');
  });

  it('rejects duplicate milestone ids and foreign milestone ownership', () => {
    const duplicate = syntheticQueue();
    duplicate.tasks.find((task) => task.id === '06').milestones[2].id = '02a';
    expect(codes(validateQueue(duplicate, schema))).toContain('MILESTONE_ID_DUPLICATE');
    const foreign = syntheticQueue();
    foreign.tasks.find((task) => task.id === '06').milestones[2].id = '05c';
    expect(codes(validateQueue(foreign, schema))).toContain('MILESTONE_OWNER');
  });

  it('rejects missing task and milestone dependencies', () => {
    const taskMissing = syntheticQueue();
    taskMissing.tasks.find((task) => task.id === '02').dependsOn = ['01', '99'];
    expect(codes(validateQueue(taskMissing, schema))).toContain('TASK_DEPENDENCY_MISSING');
    const milestoneMissing = syntheticQueue();
    milestoneMissing.tasks.find((task) => task.id === '02').milestones[0].dependsOn = ['99'];
    expect(codes(validateQueue(milestoneMissing, schema))).toContain('MILESTONE_DEPENDENCY_MISSING');
  });

  it('rejects task cycles and milestone-only cycles', () => {
    const taskCycle = syntheticQueue();
    taskCycle.tasks.find((task) => task.id === '02').dependsOn = ['03'];
    expect(codes(validateQueue(taskCycle, schema))).toContain('DEPENDENCY_CYCLE');
    const milestoneCycle = syntheticQueue();
    const milestones = milestoneCycle.tasks.find((candidate) => candidate.id === '02').milestones;
    milestones[0].dependsOn = ['02b'];
    milestones[1].dependsOn = ['02a'];
    expect(codes(validateQueue(milestoneCycle, schema))).toContain('DEPENDENCY_CYCLE');
  });

  it('rejects unknown states, readiness and queue status', () => {
    const queue = syntheticQueue();
    queue.tasks[0].state = 'READY';
    queue.tasks[0].readiness = 'MAYBE';
    queue.tasks.find((task) => task.id === '02').milestones[0].state = 'DONE';
    queue.status = 'SHIPPED';
    const found = codes(validateQueue(queue, schema));
    expect(found).toEqual(expect.arrayContaining(['UNKNOWN_STATE', 'UNKNOWN_READINESS', 'UNKNOWN_MILESTONE_STATE', 'UNKNOWN_QUEUE_STATUS']));
  });

  it('rejects invariant drift and task-count drift', () => {
    const queue = syntheticQueue();
    queue.canonicalLeafCount = 47;
    queue.acceptedLeafCount = 1;
    queue.tasks.pop();
    const found = codes(validateQueue(queue, schema));
    expect(found).toEqual(expect.arrayContaining(['INVARIANT_CHANGED', 'TASK_COUNT']));
  });

  it('rejects completion-set mismatch, dangling milestones and task identity drift', () => {
    const mismatch = syntheticQueue();
    mismatch.tasks.find((task) => task.id === '02').completionRequiresMilestones = ['02a'];
    expect(codes(validateQueue(mismatch, schema))).toContain('COMPLETION_SET_MISMATCH');
    const dangling = syntheticQueue();
    dangling.tasks.find((task) => task.id === '23').dependencyMilestones = ['06c', '99a'];
    expect(codes(validateQueue(dangling, schema))).toContain('DANGLING_MILESTONE');
    const identity = syntheticQueue();
    identity.tasks[0].id = '31';
    expect(codes(validateQueue(identity, schema))).toContain('TASK_ID_SET');
  });

  it('freezes the mandatory 02, 06, 22 and 23 dependency shape', () => {
    const shape = syntheticQueue();
    const task23 = shape.tasks.find((task) => task.id === '23');
    task23.dependsOn.push('22b');
    const found = codes(validateQueue(shape, schema));
    expect(found).toContain('REQUIRED_DEPENDENCY_SHAPE');
    const missing = syntheticQueue();
    missing.tasks.find((task) => task.id === '22').verificationDependsOn = [];
    expect(codes(validateQueue(missing, schema))).toContain('REQUIRED_DEPENDENCY_SHAPE');
  });
});

describe('checkStop', () => {
  it('refuses normal stop while controller preparation is available', () => {
    const queue = syntheticQueue();
    expect(checkStop(queue, { schema }).outcome).not.toBe('COMPLETE');
    const checkpoint = checkStop(queue, {
      schema,
      checkpoint: true,
      task: '02',
      nextAction: 'node scripts/audit/scanner-remediation-state.mjs validate --file owned.json',
    });
    expect(checkpoint.outcome).toBe('CHECKPOINT');
    expect(checkpoint.nextAction).toContain('validate');
  });

  it('reports COMPLETE only when every task is accepted', () => {
    const queue = markAccepted(syntheticQueue(), Object.keys(DEPENDENCIES));
    expect(checkStop(queue, { schema }).outcome).toBe('COMPLETE');
  });

  it('does not let a blocked task conceal other preparable work', () => {
    const queue = syntheticQueue();
    queue.tasks.find((task) => task.id === '22').state = 'BLOCKED_DEPENDENCY';
    const result = checkStop(queue, { schema });
    expect(result.outcome).toBe('REFUSED');
    expect(result.preparable).toContain('03');
  });

  it('rejects checkpoints without an exact next action or with an accepted task', () => {
    const queue = markAccepted(syntheticQueue(), ['01']);
    expect(checkStop(queue, { schema, checkpoint: true, task: '02', nextAction: '  ' }).errors[0].code).toBe(
      'CHECKPOINT_NEXT_ACTION_MISSING',
    );
    expect(checkStop(queue, { schema, checkpoint: true, task: '01', nextAction: 'do more work' }).errors[0].code).toBe(
      'CHECKPOINT_TASK_INVALID',
    );
    expect(checkStop(queue, { schema, checkpoint: true, task: '99', nextAction: 'do more work' }).errors[0].code).toBe(
      'CHECKPOINT_TASK_INVALID',
    );
  });
});

describe('validateReceipt', () => {
  const context = (overrides = {}) => ({
    schema,
    taskId: '02a',
    milestoneId: null,
    attempt: 1,
    state: 'ACCEPTED',
    receiptPath: `${FIXTURE}/receipt-02a-1.json`,
    ...overrides,
  });

  it('accepts a fully bound PASS receipt', () => {
    const { receipt, receiptPath } = makeReceipt();
    expect(validateReceipt(receipt, context({ receiptPath })).errors).toEqual([]);
  });

  it('rejects unknown keys and a stale evidence digest', () => {
    const unknown = makeReceipt({ extra: { surprise: true } });
    expect(codes(validateReceipt(unknown.receipt, context()))).toContain('RECEIPT_SCHEMA');
    const changed = makeReceipt();
    changed.receipt.notes.push('changed after hashing');
    expect(codes(validateReceipt(changed.receipt, context()))).toContain('EVIDENCE_DIGEST_MISMATCH');
  });

  it('rejects contradictory outcome and exit codes', () => {
    const passing = makeReceipt({
      commands: [
        {
          command: 'node check.mjs',
          cwd: '.',
          expectedExitCode: 0,
          exitCode: 1,
          selectedFiles: 1,
          selectedTests: 1,
          log: { path: `${FIXTURE}/log.log`, sha256: 'b'.repeat(64) },
        },
      ],
    });
    expect(codes(validateReceipt(passing.receipt, context()))).toContain('OUTCOME_EXIT_CONTRADICTION');
    const failing = makeReceipt({ outcome: 'FAIL', extra: { exitCode: 0 } });
    expect(codes(validateReceipt(failing.receipt, context()))).toContain('OUTCOME_EXIT_CONTRADICTION');
    const blocked = makeReceipt({ outcome: 'BLOCKED', extra: { exitCode: 0 } });
    expect(codes(validateReceipt(blocked.receipt, context()))).toContain('OUTCOME_EXIT_CONTRADICTION');
    const acceptedFail = makeReceipt({ outcome: 'FAIL' });
    expect(codes(validateReceipt(acceptedFail.receipt, context()))).toContain('ACCEPTANCE_OUTCOME');
  });

  it('requires both review verdicts to pass for acceptance', () => {
    const failed = makeReceipt({ verdict: { specVerdict: 'PASS', qualityVerdict: 'FAIL' } });
    expect(codes(validateReceipt(failed.receipt, context()))).toContain('REVIEW_NOT_PASS');
  });

  it('rejects unsafe, duplicated and forbidden evidence paths', () => {
    const unsafe = makeReceipt();
    unsafe.receipt.sourceFiles = [{ path: '../outside.mjs', sha256: 'a'.repeat(64) }];
    expect(codes(validateReceipt(unsafe.receipt, context()))).toContain('UNSAFE_PATH');
    const duplicate = makeReceipt();
    duplicate.receipt.sourceFiles = [
      { path: 'scripts/audit/a.mjs', sha256: 'a'.repeat(64) },
      { path: 'scripts/audit/a.mjs', sha256: 'b'.repeat(64) },
    ];
    expect(codes(validateReceipt(duplicate.receipt, context()))).toContain('DUPLICATE_EVIDENCE_PATH');
    const forbidden = makeReceipt();
    forbidden.receipt.review.path = 'docs/audit/2026-10-24-master-remediation/TASK-STATE-SCHEMA.json';
    expect(codes(validateReceipt(forbidden.receipt, context()))).toContain('INDEPENDENT_EVIDENCE_FORBIDDEN');
    const shared = makeReceipt();
    shared.receipt.review.path = shared.receipt.commands[0].log.path;
    expect(codes(validateReceipt(shared.receipt, context()))).toContain('EVIDENCE_PATH_COLLISION');
  });

  it('binds attempts and enforces the product-path cap and test counts', () => {
    const attempt = makeReceipt();
    expect(codes(validateReceipt(attempt.receipt, context({ attempt: 2 })))).toContain('RECEIPT_ATTEMPT_MISMATCH');
    const cap = makeReceipt();
    cap.receipt.productTestPaths = ['scripts/a.mjs', 'scripts/b.mjs', 'scripts/c.mjs', 'scripts/d.mjs', 'scripts/e.mjs', 'scripts/f.mjs'];
    cap.receipt.changedPaths = [...cap.receipt.changedPaths, ...cap.receipt.productTestPaths];
    const { evidenceDigest: _first, ...rest } = cap.receipt;
    cap.receipt.evidenceDigest = sha256(canonicalJson(rest));
    expect(codes(validateReceipt(cap.receipt, context()))).toContain('PRODUCT_TEST_PATH_CAP');
    const noTests = makeReceipt({ selectedTests: null });
    expect(codes(validateReceipt(noTests.receipt, context()))).toContain('TEST_COUNT_MISSING');
    const docsOnly = makeReceipt({
      sourceFiles: [{ path: 'docs/audit/synthetic.md', sha256: 'a'.repeat(64) }],
      selectedTests: null,
    });
    expect(codes(validateReceipt(docsOnly.receipt, context()))).not.toContain('TEST_COUNT_MISSING');
    const reportOnly = makeReceipt({
      sourceFiles: [{ path: 'pipeline/.work/scanner-final-work/report.md', sha256: 'a'.repeat(64) }],
      selectedTests: null,
    });
    expect(codes(validateReceipt(reportOnly.receipt, context()))).not.toContain('TEST_COUNT_MISSING');
  });
});

describe('planTransition', () => {
  it('allows a source-bound first acceptance and consumes exactly one attempt', () => {
    const queue = syntheticQueue();
    const result = planTransition(queue, schema, options(queue, { taskId: '01', receipt: makeReceipt({ taskId: '01' }).receipt }));
    expect(result.errors).toEqual([]);
    const task = result.next.tasks.find((candidate) => candidate.id === '01');
    expect(task.state).toBe('ACCEPTED');
    expect(task.attempts).toBe(1);
    expect(task.acceptanceReceipt.path).toContain('receipt-01-1.json');
    expect(result.next.revision).toBe(1);
    expect(task.planHeading).toBe(queue.tasks.find((candidate) => candidate.id === '01').planHeading);
  });

  it('rejects stale revisions, unknown states, no-ops and terminal resets', () => {
    const queue = syntheticQueue();
    expect(codes(planTransition(queue, schema, options(queue, { expectedRevision: 1 })))).toContain('STALE_REVISION');
    expect(codes(planTransition(queue, schema, options(queue, { taskId: '02', milestoneId: '02a', to: 'DONE' })))).toContain('UNKNOWN_STATE');
    expect(codes(planTransition(queue, schema, options(queue, { taskId: '02', milestoneId: '02a', to: 'PLANNED' })))).toContain('NOOP_TRANSITION');
    const accepted = markAccepted(syntheticQueue(), ['02a']);
    expect(codes(planTransition(accepted, schema, options(accepted, { taskId: '02', milestoneId: '02a', to: 'IN_PROGRESS' })))).toContain(
      'ILLEGAL_TRANSITION',
    );
  });

  it('requires ordinary dependencies, verification dependencies and every completion milestone', () => {
    const noDependency = syntheticQueue();
    expect(codes(planTransition(noDependency, schema, options(noDependency, { taskId: '02', receipt: makeReceipt({ taskId: '02' }).receipt })))).toContain(
      'DEPENDENCY_NOT_ACCEPTED',
    );
    const group02 = markAccepted(syntheticQueue(), ['01', '02a']);
    const missing02b = planTransition(group02, schema, options(group02, { taskId: '02', receipt: makeReceipt({ taskId: '02' }).receipt }));
    expect(codes(missing02b)).toContain('MILESTONE_NOT_ACCEPTED');
    expect(missing02b.errors.some((error) => error.message.includes('02b'))).toBe(true);
    const group06 = markAccepted(syntheticQueue(), ['01', '02', '06a', '06b']);
    expect(codes(planTransition(group06, schema, options(group06, { taskId: '06', receipt: makeReceipt({ taskId: '06' }).receipt })))).toContain(
      'MILESTONE_NOT_ACCEPTED',
    );
  });

  it('cannot accept group 22 after only synthetic 22a', () => {
    const queue = markAccepted(syntheticQueue(), ['20', '21', '22a']);
    const result = planTransition(queue, schema, options(queue, { taskId: '22', receipt: makeReceipt({ taskId: '22' }).receipt }));
    expect(result.outcome).toBe('FAIL');
    expect(codes(result)).toContain('MILESTONE_NOT_ACCEPTED');
    expect(result.errors.some((error) => error.message.includes('22b'))).toBe(true);
  });

  it('requires task 23 acceptance before group 22 and milestone 22b acceptance', () => {
    const group22 = markAccepted(syntheticQueue(), ['20', '21', '22a', '22b']);
    const result = planTransition(group22, schema, options(group22, { taskId: '22', receipt: makeReceipt({ taskId: '22' }).receipt }));
    expect(codes(result)).toContain('VERIFICATION_DEPENDENCY_NOT_ACCEPTED');
    const milestone22b = markAccepted(syntheticQueue(), ['22a']);
    const blocked = planTransition(
      milestone22b,
      schema,
      options(milestone22b, {
        taskId: '22',
        milestoneId: '22b',
        receipt: makeReceipt({ taskId: '22', milestoneId: '22b' }).receipt,
      }),
    );
    expect(codes(blocked)).toContain('DEPENDENCY_NOT_ACCEPTED');
    expect(blocked.errors.some((error) => error.message.includes('23'))).toBe(true);
  });

  it('rejects an accepted parent with an incomplete required milestone and allows task 23 with its full ledger', () => {
    const inconsistent = syntheticQueue();
    const task06 = inconsistent.tasks.find((task) => task.id === '06');
    const ref = { path: `${FIXTURE}/accepted-06.json`, sha256: 'f'.repeat(64) };
    task06.state = 'ACCEPTED';
    task06.attempts = 1;
    task06.acceptanceReceipt = ref;
    task06.receiptHistory = [{ ...ref, attempt: 1, state: 'ACCEPTED' }];
    expect(codes(validateQueue(inconsistent, schema))).toContain('ACCEPTED_MILESTONE_INCOMPLETE');
    const accepted = markAccepted(syntheticQueue(), ['02', '06', '12', '17', '19', '20', '21']);
    const acceptedResult = planTransition(
      accepted,
      schema,
      options(accepted, { taskId: '23', receipt: makeReceipt({ taskId: '23' }).receipt }),
    );
    expect(acceptedResult.errors).toEqual([]);
    expect(acceptedResult.next.tasks.find((task) => task.id === '23').state).toBe('ACCEPTED');
  });

  it('increments attempts on submission and never grants a fourth submission', () => {
    const queue = markAccepted(syntheticQueue(), ['01']);
    const submit = planTransition(queue, schema, options(queue, { taskId: '02', milestoneId: '02a', to: 'SUBMITTED', receipt: makeReceipt({ taskId: '02', milestoneId: '02a', attempt: 1 }).receipt }));
    expect(submit.errors).toEqual([]);
    expect(submit.next.tasks.find((task) => task.id === '02').milestones[0].attempts).toBe(1);
    const ceiling = markAccepted(syntheticQueue(), ['01']);
    const milestone = ceiling.tasks.find((task) => task.id === '02').milestones[0];
    milestone.state = 'REQUIRED_FIXES';
    milestone.attempts = 3;
    const fourth = planTransition(
      ceiling,
      schema,
      options(ceiling, { taskId: '02', milestoneId: '02a', to: 'SUBMITTED', attempt: 4, receipt: makeReceipt({ taskId: '02', milestoneId: '02a', attempt: 4 }).receipt }),
    );
    expect(codes(fourth)).toContain('ATTEMPT_CEILING');
  });

  it('accepts a new review receipt at the same submitted attempt without resetting', () => {
    const queue = markAccepted(syntheticQueue(), ['01']);
    const milestone = queue.tasks.find((task) => task.id === '02').milestones[0];
    const submitted = makeReceipt({ taskId: '02', milestoneId: '02a', attempt: 1 });
    milestone.state = 'SUBMITTED';
    milestone.attempts = 1;
    milestone.receiptHistory = [{ path: submitted.receiptPath, sha256: submitted.receiptSha, attempt: 1, state: 'SUBMITTED' }];
    const review = makeReceipt({
      taskId: '02',
      milestoneId: '02a',
      attempt: 1,
      sourceFiles: submitted.receipt.sourceFiles,
      logPath: `${FIXTURE}/acceptance-log-02a-1.log`,
      reviewPath: `${FIXTURE}/acceptance-review-02a-1.md`,
      receiptPath: `${FIXTURE}/acceptance-receipt-02a-1.json`,
    });
    const accepted = planTransition(
      queue,
      schema,
      options(queue, {
        taskId: '02',
        milestoneId: '02a',
        attempt: 1,
        receipt: review.receipt,
        receiptPath: review.receiptPath,
        receiptSha: review.receiptSha,
        candidate: receiptScope(submitted.receipt),
      }),
    );
    expect(accepted.errors).toEqual([]);
    expect(accepted.next.tasks.find((task) => task.id === '02').milestones[0].attempts).toBe(1);
    const fixes = planTransition(
      queue,
      schema,
      options(queue, {
        taskId: '02',
        milestoneId: '02a',
        to: 'REQUIRED_FIXES',
        attempt: 1,
        receipt: makeReceipt({ taskId: '02', milestoneId: '02a', attempt: 1, outcome: 'FAIL', extra: { exitCode: 1 } }).receipt,
      }),
    );
    expect(fixes.errors).toEqual([]);
  });

  it('rejects acceptance of an unsubmitted or changed candidate without mutation', () => {
    const queue = markAccepted(syntheticQueue(), ['01']);
    const milestone = queue.tasks.find((task) => task.id === '02').milestones[0];
    const submitted = makeReceipt({ taskId: '02', milestoneId: '02a', attempt: 1 });
    milestone.state = 'BLOCKED_DEPENDENCY';
    milestone.attempts = 1;
    milestone.receiptHistory = [{ path: submitted.receiptPath, sha256: submitted.receiptSha, attempt: 1, state: 'SUBMITTED' }];
    const changed = makeReceipt({ taskId: '02', milestoneId: '02a', attempt: 1, sourceFiles: [{ path: 'scripts/audit/changed.mjs', sha256: 'b'.repeat(64) }] });
    const changedResult = planTransition(
      queue,
      schema,
      options(queue, {
        taskId: '02',
        milestoneId: '02a',
        attempt: 1,
        receipt: changed.receipt,
        receiptPath: changed.receiptPath,
        receiptSha: changed.receiptSha,
        candidate: receiptScope(submitted.receipt),
      }),
    );
    expect(codes(changedResult)).toContain('CANDIDATE_SCOPE_MISMATCH');
    expect(changedResult.next).toBeUndefined();
    const unsubmitted = planTransition(
      queue,
      schema,
      options(queue, {
        taskId: '02',
        milestoneId: '02a',
        attempt: 1,
        receipt: changed.receipt,
        receiptPath: changed.receiptPath,
        receiptSha: changed.receiptSha,
        candidate: null,
      }),
    );
    expect(codes(unsubmitted)).toContain('CANDIDATE_NOT_VERIFIED');
  });

  it('refuses receipt reuse for a new submission', () => {
    const queue = syntheticQueue();
    const milestone = queue.tasks.find((task) => task.id === '02').milestones[0];
    milestone.state = 'REQUIRED_FIXES';
    milestone.attempts = 1;
    milestone.receiptHistory = [{ path: `${FIXTURE}/receipt-02a-1.json`, sha256: 'f'.repeat(64), attempt: 1, state: 'SUBMITTED' }];
    const reused = makeReceipt({ taskId: '02', milestoneId: '02a', attempt: 2 });
    const result = planTransition(
      queue,
      schema,
      options(queue, { taskId: '02', milestoneId: '02a', to: 'SUBMITTED', attempt: 2, receipt: reused.receipt, receiptPath: `${FIXTURE}/receipt-02a-1.json` }),
    );
    expect(codes(result)).toContain('RECEIPT_PATH_REUSED');
  });

  it('rejects transitions that would alter immutable task fields', () => {
    const queue = syntheticQueue();
    const result = planTransition(queue, schema, options(queue, { taskId: '01', receipt: makeReceipt({ taskId: '01' }).receipt }));
    for (let index = 0; index < queue.tasks.length; index += 1) {
      const before = queue.tasks[index];
      const after = result.next.tasks[index];
      expect(after.planHeading).toBe(before.planHeading);
      expect(after.dependsOn).toEqual(before.dependsOn);
      expect(after.title).toBe(before.title);
    }
    const tampered = structuredClone(queue);
    tampered.tasks[0].planHeading = 'rewritten';
    expect(codes({ errors: assertAllowedMutations(queue, tampered) })).toContain('PROTECTED_FIELD_CHANGED');
  });
});

describe('parking ceiling', () => {
  const parkOptions = (queue, overrides) => options(queue, { to: 'PARKED_AFTER_ATTEMPT_CEILING', receipt: null, receiptPath: null, receiptSha: null, ...overrides });

  it('rejects early task parking without producing a next queue', () => {
    const queue = syntheticQueue();
    const task = queue.tasks.find((candidate) => candidate.id === '03');
    task.state = 'REQUIRED_FIXES';
    task.attempts = 1;
    const result = planTransition(queue, schema, parkOptions(queue, { taskId: '03' }));
    expect(codes(result)).toContain('ATTEMPT_PARKED_EARLY');
    expect(result.next).toBeUndefined();
  });

  it('allows task parking exactly at the ceiling and validates the next queue', () => {
    const queue = syntheticQueue();
    const task = queue.tasks.find((candidate) => candidate.id === '03');
    task.state = 'REQUIRED_FIXES';
    task.attempts = 3;
    const result = planTransition(queue, schema, parkOptions(queue, { taskId: '03' }));
    expect(result.errors).toEqual([]);
    expect(result.next.tasks.find((candidate) => candidate.id === '03').state).toBe('PARKED_AFTER_ATTEMPT_CEILING');
    expect(validateQueue(result.next, schema).errors).toEqual([]);
  });

  it('rejects early milestone parking and allows it exactly at the ceiling', () => {
    const early = syntheticQueue();
    const milestone = early.tasks.find((task) => task.id === '02').milestones[0];
    milestone.state = 'REQUIRED_FIXES';
    milestone.attempts = 1;
    const rejected = planTransition(early, schema, parkOptions(early, { taskId: '02', milestoneId: '02a' }));
    expect(codes(rejected)).toContain('ATTEMPT_PARKED_EARLY');
    expect(rejected.next).toBeUndefined();
    const valid = syntheticQueue();
    const ceiling = valid.tasks.find((task) => task.id === '02').milestones[0];
    ceiling.state = 'REQUIRED_FIXES';
    ceiling.attempts = 3;
    const allowed = planTransition(valid, schema, parkOptions(valid, { taskId: '02', milestoneId: '02a' }));
    expect(allowed.errors).toEqual([]);
    expect(validateQueue(allowed.next, schema).errors).toEqual([]);
  });
});

describe('completion and stop over tasks and milestones', () => {
  it('never reports COMPLETE while a ready parked task remains', () => {
    const queue = markAccepted(syntheticQueue(), Object.keys(DEPENDENCIES));
    const parked = queue.tasks.find((task) => task.id === '03');
    parked.state = 'PARKED_AFTER_ATTEMPT_CEILING';
    parked.attempts = 3;
    parked.readiness = 'PREPARABLE_LOCAL';
    const result = checkStop(queue, { schema });
    expect(result.outcome).toBe('REFUSED');
    expect(result.outcome).not.toBe('COMPLETE');
    expect(result.preparable).toContain('03');
  });

  it('sees an active milestone under a parked parent task', () => {
    const queue = markAccepted(syntheticQueue(), Object.keys(DEPENDENCIES));
    const task = queue.tasks.find((candidate) => candidate.id === '02');
    task.state = 'PARKED_AFTER_ATTEMPT_CEILING';
    task.attempts = 3;
    const milestone = task.milestones.find((candidate) => candidate.id === '02a');
    milestone.state = 'SUBMITTED';
    milestone.attempts = 1;
    const result = checkStop(queue, { schema });
    expect(result.outcome).toBe('REFUSED');
    expect(result.active).toContain('02a');
  });

  it('returns unresolved rather than COMPLETE for an all-parked queue', () => {
    const queue = markAccepted(syntheticQueue(), Object.keys(DEPENDENCIES));
    for (const task of queue.tasks) {
      task.state = 'PARKED_AFTER_ATTEMPT_CEILING';
      task.attempts = 3;
      task.readiness = 'DEPENDENCY_OR_BRIEF_REQUIRED';
      for (const milestone of task.milestones ?? []) {
        milestone.state = 'PARKED_AFTER_ATTEMPT_CEILING';
        milestone.attempts = 3;
      }
    }
    const result = checkStop(queue, { schema });
    expect(result.outcome).not.toBe('COMPLETE');
    expect(result.outcome).toBe('BLOCKED_REMAINS');
  });

  it('rejects malformed queues and a missing schema instead of completing', () => {
    expect(checkStop({ tasks: [] }, { schema }).outcome).toBe('INVALID');
    expect(checkStop(null, { schema }).outcome).toBe('INVALID');
    expect(checkStop(syntheticQueue()).errors[0].code).toBe('SCHEMA_REQUIRED');
    expect(checkStop(syntheticQueue(), { schema: null }).errors[0].code).toBe('SCHEMA_REQUIRED');
  });
});

describe('accepted structure and receipt ledger coherence', () => {
  it('rejects an accepted parent whose required milestone is incomplete', () => {
    const queue = syntheticQueue();
    const task = queue.tasks.find((candidate) => candidate.id === '06');
    const ref = { path: `${FIXTURE}/accepted-06.json`, sha256: 'f'.repeat(64) };
    task.state = 'ACCEPTED';
    task.attempts = 1;
    task.acceptanceReceipt = ref;
    task.receiptHistory = [{ ...ref, attempt: 1, state: 'ACCEPTED' }];
    expect(codes(validateQueue(queue, schema))).toContain('ACCEPTED_MILESTONE_INCOMPLETE');
  });

  it('rejects acceptance history without a same-attempt submitted candidate', () => {
    const queue = syntheticQueue();
    const task = queue.tasks.find((candidate) => candidate.id === '03');
    const ref = { path: `${FIXTURE}/accepted-03.json`, sha256: 'f'.repeat(64) };
    task.state = 'ACCEPTED';
    task.attempts = 1;
    task.acceptanceReceipt = ref;
    task.receiptHistory = [{ path: `${FIXTURE}/submitted-03.json`, sha256: 'a'.repeat(64), attempt: 2, state: 'SUBMITTED' }];
    expect(codes(validateQueue(queue, schema))).toContain('RECEIPT_HISTORY_INCOHERENT');
    const duplicate = structuredClone(queue);
    duplicate.tasks.find((candidate) => candidate.id === '03').receiptHistory = [
      { path: `${FIXTURE}/submitted-03.json`, sha256: 'a'.repeat(64), attempt: 1, state: 'SUBMITTED' },
      { path: `${FIXTURE}/submitted-03b.json`, sha256: 'b'.repeat(64), attempt: 1, state: 'SUBMITTED' },
    ];
    expect(codes(validateQueue(duplicate, schema))).toContain('RECEIPT_HISTORY_INCOHERENT');
  });

  it('rejects non-object queues and schema rather than throwing', () => {
    expect(codes(validateQueue(null, schema))).toContain('QUEUE_SHAPE');
    expect(codes(validateQueue([], schema))).toContain('QUEUE_SHAPE');
    expect(codes(validateQueue(syntheticQueue(), null))).toContain('SCHEMA_SHAPE');
  });
});

describe('receipt source binding and identity', () => {
  const context = (overrides = {}) => ({
    schema,
    taskId: '02a',
    milestoneId: null,
    attempt: 1,
    state: 'ACCEPTED',
    receiptPath: `${FIXTURE}/receipt-02a-1.json`,
    ...overrides,
  });

  it('requires every changed code path to be byte-bound and tested', () => {
    const receipt = makeReceipt({
      sourceFiles: [],
      selectedTests: null,
      extra: { changedPaths: ['scripts/audit/unbound.mjs'], productTestPaths: ['scripts/audit/unbound.mjs'] },
    });
    const found = codes(validateReceipt(receipt.receipt, context()));
    expect(found).toContain('SOURCE_BINDING_MISSING');
    expect(found).toContain('TEST_COUNT_MISSING');
  });

  it('binds productTestPaths to sourceFiles, changedPaths and product roots', () => {
    const outsideChanged = makeReceipt({ extra: { productTestPaths: ['scripts/audit/other.mjs'] } });
    expect(codes(validateReceipt(outsideChanged.receipt, context()))).toContain('PRODUCT_TEST_PATH_SCOPE');
    const outsideRoots = makeReceipt({ extra: { productTestPaths: ['docs/audit/other.ts'] } });
    expect(codes(validateReceipt(outsideRoots.receipt, context()))).toContain('PRODUCT_TEST_PATH_ROOT');
    const missingChanged = makeReceipt({ extra: { changedPaths: [`${FIXTURE}/receipt.md`] } });
    expect(codes(validateReceipt(missingChanged.receipt, context()))).toContain('CHANGED_PATHS_INCOMPLETE');
  });

  it('allows evidence-only acceptance with null test counts', () => {
    const receipt = makeReceipt({
      sourceFiles: [],
      selectedTests: null,
      extra: { changedPaths: ['docs/audit/task01-evidence.md'], productTestPaths: [] },
    });
    expect(codes(validateReceipt(receipt.receipt, context()))).toEqual([]);
  });

  it('reports identity and sourceDigest tampering as typed errors', () => {
    const identity = makeReceipt({ extra: { taskId: '99' } });
    expect(codes(validateReceipt(identity.receipt, context()))).toContain('RECEIPT_TASK_MISMATCH');
    const digest = makeReceipt({ extra: { sourceDigest: '0'.repeat(64) } });
    expect(codes(validateReceipt(digest.receipt, context()))).toContain('SOURCE_DIGEST_MISMATCH');
  });

  it('rejects non-string evidence paths without throwing', () => {
    const receipt = makeReceipt();
    receipt.receipt.commands[0].log.path = 5;
    expect(() => validateReceipt(receipt.receipt, context())).not.toThrow();
    expect(codes(validateReceipt(receipt.receipt, context()))).toContain('UNSAFE_PATH');
  });
});
