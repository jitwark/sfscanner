import { assertAllowedMutations, candidateMatches, canonicalJson, checkAcceptanceLedger, checkHistory, checkRef, consumedReceipts, isObject, isSafeRelative, list, nextAttempt, push } from './scanner-remediation-state-receipts.mjs';

const TASK_ID = /^[0-9]{2}$/u, MILESTONE_ID = /^[0-9]{2}[a-z]$/u, DIGEST = /^[0-9a-f]{64}$/u;
const GRAPH = { PLANNED: ['IN_PROGRESS', 'SUBMITTED', 'BLOCKED_DEPENDENCY', 'ACCEPTED'], IN_PROGRESS: ['SUBMITTED', 'BLOCKED_DEPENDENCY'], SUBMITTED: ['ACCEPTED', 'REQUIRED_FIXES', 'BLOCKED_DEPENDENCY'], REQUIRED_FIXES: ['IN_PROGRESS', 'SUBMITTED', 'PARKED_AFTER_ATTEMPT_CEILING'], BLOCKED_DEPENDENCY: ['IN_PROGRESS', 'SUBMITTED', 'ACCEPTED'], ACCEPTED: [], PARKED_AFTER_ATTEMPT_CEILING: [] };
const TERMINAL = new Set(['ACCEPTED', 'PARKED_AFTER_ATTEMPT_CEILING']), SUBMISSION = new Set(['SUBMITTED', 'ACCEPTED', 'REQUIRED_FIXES']), START = new Set(['IN_PROGRESS', 'SUBMITTED', 'ACCEPTED']), ACTIVE = new Set(['IN_PROGRESS', 'SUBMITTED', 'REQUIRED_FIXES']);
const TOP_INVARIANTS = ['canonicalLeafCount', 'originalChunkCount', 'executionWaveCount', 'restrictionState', 'acceptedLeafCount', 'completionPercent'], MANDATORY_MILESTONES = [['02a', '01'], ['02b', '02a'], ['06c', '02'], ['22b', '23']];
const MANDATORY_EDGES = [['02', 'completionRequiresMilestones', '02b'], ['06', 'completionRequiresMilestones', '06c'], ['22', 'completionRequiresMilestones', '22a'], ['22', 'completionRequiresMilestones', '22b'], ['22', 'verificationDependsOn', '23']];

export function validateQueue(queue, schema) {
  const errors = [], add = (code, message, extra) => push(errors, code, message, extra);
  if (!isObject(schema)) { add('SCHEMA_SHAPE', 'schema object is required'); return { outcome: 'FAIL', errors, ready: [], preparable: [], frontier: [] }; }
  if (!isObject(queue)) { add('QUEUE_SHAPE', 'queue must be an object'); return { outcome: 'FAIL', errors, ready: [], preparable: [], frontier: [] }; }
  const tasks = list(queue.tasks), taskById = new Map(), milestoneById = new Map();
  if (queue.schemaVersion !== schema.queueSchemaVersion) add('QUEUE_SCHEMA_VERSION', 'queue schemaVersion is not the schema revision');
  if (!Number.isSafeInteger(queue.revision) || queue.revision < 0) add('QUEUE_REVISION', 'revision must be a non-negative integer');
  if (!schema.queueStatuses.includes(queue.status)) add('UNKNOWN_QUEUE_STATUS', `${queue.status} is not a queue status`);
  if (tasks.length !== schema.invariants.taskCount) add('TASK_COUNT', `expected ${schema.invariants.taskCount} tasks`);
  for (const field of TOP_INVARIANTS) if (JSON.stringify(queue[field]) !== JSON.stringify(schema.invariants[field])) add('INVARIANT_CHANGED', `${field} must remain ${JSON.stringify(schema.invariants[field])}`, { field });
  tasks.forEach((task, index) => {
    if (!isObject(task)) return add('TASK_SHAPE', `tasks[${index}] must be an object`);
    const label = `task ${task.id}`, max = task.maxSubmittedAttempts, attempts = task.attempts;
    if (typeof task.id !== 'string' || !TASK_ID.test(task.id)) add('TASK_ID_PATTERN', `tasks[${index}] id must match ^[0-9]{2}$`);
    else if (taskById.has(task.id)) add('TASK_ID_DUPLICATE', `${label} is declared twice`, { taskId: task.id }); else taskById.set(task.id, task);
    if (!schema.taskStates.includes(task.state)) add('UNKNOWN_STATE', `${label} state ${task.state} is unknown`, { taskId: task.id });
    if (!schema.readinessStates.includes(task.readiness)) add('UNKNOWN_READINESS', `${label} readiness ${task.readiness} is unknown`, { taskId: task.id });
    if (!Number.isSafeInteger(attempts) || attempts < 0) add('ATTEMPT_INVALID', `${label} attempts must be a non-negative integer`, { taskId: task.id });
    if (max !== schema.invariants.maxSubmittedAttempts || task.maxChangedProductTestPathsPerChild !== schema.invariants.maxChangedProductTestPathsPerChild) add('INVARIANT_CHANGED', `${label} caps drifted`, { taskId: task.id });
    if (Number.isSafeInteger(attempts) && Number.isSafeInteger(max)) {
      if (attempts > max) add('ATTEMPT_CEILING', `${label} exceeds its attempt ceiling`, { taskId: task.id });
      if (task.state === 'PARKED_AFTER_ATTEMPT_CEILING' && attempts < max) add('ATTEMPT_PARKED_EARLY', `${label} parked below its attempt ceiling`, { taskId: task.id });
    }
    if (['SUBMITTED', 'REQUIRED_FIXES'].includes(task.state) && !(attempts >= 1)) add('ATTEMPT_MONOTONIC', `${label} ${task.state} without a consumed attempt`, { taskId: task.id });
    if (task.state === 'ACCEPTED' && (!(attempts >= 1) || !task.acceptanceReceipt)) add('ACCEPTANCE_RECEIPT_MISSING', `${label} accepted without attempt-bound evidence`, { taskId: task.id });
    checkRef(task.acceptanceReceipt, `${label} acceptanceReceipt`, add); checkHistory(task.receiptHistory, label, add); if (task.state === 'ACCEPTED') checkAcceptanceLedger(task, label, attempts, add);
    for (const milestone of list(task.milestones)) {
      if (!isObject(milestone)) { add('MILESTONE_SHAPE', `${label} has a non-object milestone`); continue; }
      const mid = milestone.id, state = milestone.state ?? 'PLANNED', milestoneAttempts = milestone.attempts ?? 0;
      if (typeof mid !== 'string' || !MILESTONE_ID.test(mid)) add('MILESTONE_ID_PATTERN', `${label} milestone id ${mid} must match ^[0-9]{2}[a-z]$`);
      else if (milestoneById.has(mid)) add('MILESTONE_ID_DUPLICATE', `milestone ${mid} is declared twice`, { milestoneId: mid }); else milestoneById.set(mid, { task, milestone });
      if (typeof mid === 'string' && mid.slice(0, 2) !== task.id) add('MILESTONE_OWNER', `milestone ${mid} is not owned by task ${task.id}`, { milestoneId: mid });
      if (!schema.milestoneStates.includes(state)) add('UNKNOWN_MILESTONE_STATE', `milestone ${mid} state ${state} is unknown`, { milestoneId: mid });
      if (!Number.isSafeInteger(milestoneAttempts) || milestoneAttempts < 0) add('ATTEMPT_INVALID', `milestone ${mid} attempts must be a non-negative integer`, { milestoneId: mid });
      else if (Number.isSafeInteger(max)) {
        if (milestoneAttempts > max) add('ATTEMPT_CEILING', `milestone ${mid} exceeds its attempt ceiling`, { milestoneId: mid });
        if (state === 'PARKED_AFTER_ATTEMPT_CEILING' && milestoneAttempts < max) add('ATTEMPT_PARKED_EARLY', `milestone ${mid} parked below its attempt ceiling`, { milestoneId: mid });
      }
      if (['SUBMITTED', 'REQUIRED_FIXES'].includes(state) && milestoneAttempts < 1) add('ATTEMPT_MONOTONIC', `milestone ${mid} ${state} without a consumed attempt`, { milestoneId: mid });
      if (state === 'ACCEPTED' && (milestoneAttempts < 1 || !milestone.acceptanceReceipt)) add('ACCEPTANCE_RECEIPT_MISSING', `milestone ${mid} accepted without attempt-bound evidence`, { milestoneId: mid });
      checkRef(milestone.acceptanceReceipt, `milestone ${mid} acceptanceReceipt`, add); checkHistory(milestone.receiptHistory, `milestone ${mid}`, add); if (state === 'ACCEPTED') checkAcceptanceLedger(milestone, `milestone ${mid}`, milestoneAttempts, add);
    }
    if (task.state === 'ACCEPTED') {
      for (const id of list(task.completionRequiresMilestones)) {
        const owned = milestoneById.get(id);
        if (owned && (owned.milestone.state ?? 'PLANNED') !== 'ACCEPTED') add('ACCEPTED_MILESTONE_INCOMPLETE', `${label} is accepted while required milestone ${id} is not`, { taskId: task.id, milestoneId: id });
      }
    }
  });
  for (let number = 1; number <= schema.invariants.taskCount; number += 1) {
    const id = String(number).padStart(2, '0');
    if (!taskById.has(id)) add('TASK_ID_SET', `required task identity ${id} is missing`, { taskId: id });
  }
  for (const task of tasks) {
    if (!isObject(task)) continue;
    for (const id of list(task.dependsOn)) if (!taskById.has(id)) add('TASK_DEPENDENCY_MISSING', `task ${task.id} depends on missing task ${id}`, { taskId: task.id, dependency: id });
    for (const id of list(task.verificationDependsOn)) if (!taskById.has(id)) add('TASK_DEPENDENCY_MISSING', `task ${task.id} verifies against missing task ${id}`, { taskId: task.id, dependency: id });
    for (const id of list(task.dependencyMilestones)) if (!milestoneById.has(id)) add('DANGLING_MILESTONE', `task ${task.id} depends on missing milestone ${id}`, { taskId: task.id, dependency: id });
    const own = list(task.milestones).map((milestone) => milestone?.id).filter(Boolean), completion = list(task.completionRequiresMilestones);
    for (const id of completion) {
      const owned = milestoneById.get(id);
      if (!owned) add('DANGLING_MILESTONE', `task ${task.id} requires missing milestone ${id}`, { taskId: task.id, dependency: id });
      else if (owned.task !== task) add('MILESTONE_MEMBERSHIP', `milestone ${id} is not owned by task ${task.id}`, { taskId: task.id, milestoneId: id });
    }
    if ((own.length || completion.length) && JSON.stringify([...own].sort()) !== JSON.stringify([...completion].sort())) add('COMPLETION_SET_MISMATCH', `task ${task.id} completion set does not equal its milestones`, { taskId: task.id });
  }
  const edges = new Map(), link = (from, to) => { if (from && to) { if (!edges.has(from)) edges.set(from, []); edges.get(from).push(to); } };
  const resolve = (id) => (taskById.has(id) ? `T:${id}` : milestoneById.has(id) ? `M:${id}` : null);
  for (const task of tasks) {
    if (!isObject(task) || !task.id) continue;
    for (const id of list(task.dependsOn).concat(list(task.verificationDependsOn))) link(`T:${task.id}`, `T:${id}`);
    for (const id of list(task.dependencyMilestones).concat(list(task.completionRequiresMilestones))) link(`T:${task.id}`, `M:${id}`);
  }
  for (const { milestone } of milestoneById.values()) {
    for (const id of list(milestone.dependsOn)) {
      if (!taskById.has(id) && !milestoneById.has(id)) add('MILESTONE_DEPENDENCY_MISSING', `milestone ${milestone.id} depends on missing ${id}`, { milestoneId: milestone.id, dependency: id });
      link(`M:${milestone.id}`, resolve(id));
    }
  }
  const nodes = [...taskById.keys()].map((id) => `T:${id}`).concat([...milestoneById.keys()].map((id) => `M:${id}`)), indegree = new Map(nodes.map((node) => [node, 0]));
  for (const targets of edges.values()) for (const target of targets) if (indegree.has(target)) indegree.set(target, indegree.get(target) + 1);
  const readyNodes = nodes.filter((node) => indegree.get(node) === 0);
  let visited = 0;
  while (readyNodes.length) {
    const node = readyNodes.pop(); visited += 1;
    for (const target of edges.get(node) ?? []) if (indegree.has(target) && indegree.set(target, indegree.get(target) - 1).get(target) === 0) readyNodes.push(target);
  }
  if (visited !== nodes.length) add('DEPENDENCY_CYCLE', 'task and milestone dependencies contain a cycle');
  const task23 = taskById.get('23');
  for (const [taskId, field, id] of MANDATORY_EDGES) {
    const task = taskById.get(taskId);
    if (!task) add('REQUIRED_DEPENDENCY_SHAPE', `required task ${taskId} is missing`); else if (!list(task[field]).includes(id)) add('REQUIRED_DEPENDENCY_SHAPE', `task ${taskId} must declare ${field} ${id}`, { taskId, dependency: id });
  }
  for (const [milestoneId, id] of MANDATORY_MILESTONES) {
    const entry = milestoneById.get(milestoneId);
    if (!entry) add('REQUIRED_DEPENDENCY_SHAPE', `required milestone ${milestoneId} is missing`); else if (!list(entry.milestone.dependsOn).includes(id)) add('REQUIRED_DEPENDENCY_SHAPE', `milestone ${milestoneId} must depend on ${id}`, { milestoneId, dependency: id });
  }
  if (task23) {
    for (const id of ['06c', '02b']) if (!list(task23.dependencyMilestones).includes(id)) add('REQUIRED_DEPENDENCY_SHAPE', `task 23 must require ${id}`, { taskId: '23', dependency: id });
    for (const field of ['dependsOn', 'verificationDependsOn', 'dependencyMilestones']) for (const id of list(task23[field])) if (['22', '22a', '22b'].includes(id)) add('REQUIRED_DEPENDENCY_SHAPE', 'task 23 must not wait for group 22', { taskId: '23', dependency: id });
  }
  if (queue.protectedFixtures !== undefined) {
    if (!Array.isArray(queue.protectedFixtures)) add('PROTECTED_FIXTURE_SHAPE', 'protectedFixtures must be an array');
    else queue.protectedFixtures.forEach((fixture, index) => {
      if (!isObject(fixture) || !isSafeRelative(fixture.path) || !DIGEST.test(String(fixture.sha256))) add('PROTECTED_FIXTURE_SHAPE', `protectedFixtures[${index}] is not a safe measured pin`);
    });
  }
  const unfinished = tasks.filter((task) => isObject(task) && task.state !== 'ACCEPTED');
  const ready = unfinished.filter((task) => task.readiness === 'READY_LOCAL').map((task) => task.id).sort(), preparable = unfinished.filter((task) => task.readiness === 'PREPARABLE_LOCAL').map((task) => task.id).sort();
  return { outcome: errors.length ? 'FAIL' : 'PASS', errors, ready, preparable, frontier: [...new Set([...ready, ...preparable])] };
}

export function checkStop(queue, options = {}) {
  const settings = isObject(options) ? options : {}, empty = { ready: [], preparable: [], active: [], blocked: [], frontier: [] };
  if (!isObject(settings.schema)) return { ...empty, outcome: 'INVALID', errors: [{ code: 'SCHEMA_REQUIRED', message: 'checkStop requires the validated schema' }] };
  const validation = validateQueue(queue, settings.schema);
  if (validation.errors.length) return { ...empty, outcome: 'INVALID', errors: validation.errors };
  const tasks = list(queue.tasks), unfinished = tasks.filter((task) => task.state !== 'ACCEPTED');
  const ready = unfinished.filter((task) => task.readiness === 'READY_LOCAL').map((task) => task.id).sort(), preparable = unfinished.filter((task) => task.readiness === 'PREPARABLE_LOCAL').map((task) => task.id).sort();
  const active = [], blocked = [], parked = [];
  let milestonesComplete = true;
  for (const task of tasks) {
    if (ACTIVE.has(task.state)) active.push(task.id);
    if (task.state === 'BLOCKED_DEPENDENCY') blocked.push(task.id);
    if (task.state === 'PARKED_AFTER_ATTEMPT_CEILING') parked.push(task.id);
    for (const milestone of list(task.milestones)) {
      const state = milestone.state ?? 'PLANNED';
      if (state !== 'ACCEPTED') milestonesComplete = false;
      if (ACTIVE.has(state)) active.push(milestone.id);
      if (state === 'BLOCKED_DEPENDENCY') blocked.push(milestone.id);
      if (state === 'PARKED_AFTER_ATTEMPT_CEILING') parked.push(milestone.id);
    }
  }
  active.sort(); blocked.sort(); parked.sort();
  const base = { ready, preparable, active, blocked, parked, frontier: [...new Set([...ready, ...preparable])] };
  if (!settings.checkpoint) {
    const complete = tasks.every((task) => task.state === 'ACCEPTED') && milestonesComplete;
    if (complete) return { ...base, outcome: 'COMPLETE' };
    if (ready.length || preparable.length || active.length) return { ...base, outcome: 'REFUSED', reason: 'READY_WORK_REMAINS' };
    return { ...base, outcome: 'BLOCKED_REMAINS', reason: 'NO_RUNNABLE_WORK' };
  }
  const task = tasks.find((candidate) => candidate?.id === settings.task), nextAction = typeof settings.nextAction === 'string' ? settings.nextAction.trim() : '';
  const fail = (code, message) => ({ ...base, outcome: 'REJECTED', nextAction, errors: [{ code, message }] });
  if (!task || !TASK_ID.test(String(task.id))) return fail('CHECKPOINT_TASK_INVALID', `${settings.task} is not a task`);
  if (TERMINAL.has(task.state)) return fail('CHECKPOINT_TASK_INVALID', `${task.id} is already terminal`);
  if (!nextAction) return fail('CHECKPOINT_NEXT_ACTION_MISSING', 'checkpoint requires a nonempty exact next action');
  return { ...base, outcome: 'CHECKPOINT', task: task.id, nextAction };
}

export function planTransition(queue, schema, options) {
  const errors = [], add = (code, message, extra = {}) => push(errors, code, message, extra);
  if (!isObject(schema)) { add('SCHEMA_SHAPE', 'schema object is required'); return { outcome: 'FAIL', errors }; }
  const settings = isObject(options) ? options : {};
  const { taskId, milestoneId = null, to, expectedRevision, receipt = null, receiptPath = null, receiptSha = null, candidate = null, evidenceVerified = false } = settings;
  errors.push(...validateQueue(queue, schema).errors);
  if (queue.revision !== expectedRevision) add('STALE_REVISION', `expected revision ${expectedRevision}, found ${queue.revision}`);
  const tasks = list(queue.tasks), task = tasks.find((candidateEntry) => candidateEntry?.id === taskId);
  if (!task) return { outcome: 'FAIL', errors: [...errors, { code: 'TASK_NOT_FOUND', message: `task ${taskId} does not exist` }] };
  const entry = milestoneId ? list(task.milestones).find((candidateEntry) => candidateEntry?.id === milestoneId) : task;
  if (!entry) return { outcome: 'FAIL', errors: [...errors, { code: 'MILESTONE_NOT_FOUND', message: `milestone ${milestoneId} is not owned by task ${taskId}` }] };
  const currentState = entry.state ?? 'PLANNED', currentAttempts = entry.attempts ?? 0, max = Number.isSafeInteger(task.maxSubmittedAttempts) ? task.maxSubmittedAttempts : schema.invariants.maxSubmittedAttempts;
  if (!(milestoneId ? schema.milestoneStates : schema.taskStates).includes(to)) add('UNKNOWN_STATE', `${to} is not a known ${milestoneId ? 'milestone' : 'task'} state`, { taskId });
  if (currentState === to) add('NOOP_TRANSITION', `task or milestone is already ${to}`, { taskId });
  if (!(GRAPH[currentState] ?? []).includes(to)) add('ILLEGAL_TRANSITION', `${currentState} cannot move to ${to}`, { taskId });
  if (to === 'PARKED_AFTER_ATTEMPT_CEILING' && currentAttempts !== max) add('ATTEMPT_PARKED_EARLY', `parking requires exactly ${max} attempts`, { taskId });
  const attempt = nextAttempt(queue, taskId, milestoneId, to);
  if (SUBMISSION.has(to) && (attempt < 1 || attempt > max)) add(attempt < 1 ? 'ATTEMPT_MONOTONIC' : 'ATTEMPT_CEILING', `attempt ${attempt} is outside 1..${max}`, { taskId });
  if (SUBMISSION.has(to)) {
    if (!receipt || !receiptPath) add('RECEIPT_MISSING', `${to} requires an existing receipt file`, { taskId });
    else {
      if (!evidenceVerified) add('RECEIPT_NOT_VERIFIED', 'receipt evidence bytes were not verified by the host', { taskId });
      if (!DIGEST.test(String(receiptSha))) add('RECEIPT_SCHEMA', 'receipt sha256 must be a digest', { taskId });
      if (receipt.attempt !== attempt) add('RECEIPT_ATTEMPT_MISMATCH', `receipt attempt ${receipt.attempt} is not ${attempt}`, { taskId });
      if (receipt.taskId !== task.id || (receipt.milestoneId ?? null) !== (milestoneId ?? null)) add('RECEIPT_IDENTITY_MISMATCH', 'receipt identity does not match the transition target', { taskId });
      if (to === 'ACCEPTED' && currentAttempts > 0) {
        const submitted = list(entry.receiptHistory).filter((item) => item.state === 'SUBMITTED' && item.attempt === attempt);
        if (submitted.length !== 1) add('ACCEPTANCE_RECEIPT_NOT_SUBMITTED', `attempt ${attempt} has no single submitted candidate`, { taskId });
        if (!candidate) add('CANDIDATE_NOT_VERIFIED', 'the submitted candidate was not verified by the host', { taskId });
        else if (!candidateMatches(receipt, candidate)) add('CANDIDATE_SCOPE_MISMATCH', 'acceptance changes the submitted source or path scope', { taskId });
      }
      const prior = consumedReceipts(queue).filter((item) => item.path === receiptPath);
      if (prior.length) {
        const foreign = prior.some((item) => item.taskId !== task.id || (item.milestoneId ?? null) !== (milestoneId ?? null));
        if (to === 'SUBMITTED' || foreign || prior.every((item) => item.sha256 !== receiptSha)) add('RECEIPT_PATH_REUSED', 'a consumed receipt path was reused', { taskId });
      }
    }
  }
  const byId = new Map(tasks.map((candidateEntry) => [candidateEntry?.id, candidateEntry])), milestonesById = new Map();
  for (const candidateEntry of tasks) for (const milestone of list(candidateEntry?.milestones)) milestonesById.set(milestone?.id, milestone);
  const acceptedTask = (id) => byId.get(id)?.state === 'ACCEPTED', acceptedMilestone = (id) => (milestonesById.get(id)?.state ?? 'PLANNED') === 'ACCEPTED';
  if (START.has(to)) {
    for (const id of list(task.dependsOn)) if (!acceptedTask(id)) add('DEPENDENCY_NOT_ACCEPTED', `task ${task.id} requires accepted task ${id}`, { taskId, dependency: id });
    for (const id of list(task.dependencyMilestones)) if (!acceptedMilestone(id)) add('DEPENDENCY_MILESTONE_NOT_ACCEPTED', `task ${task.id} requires accepted milestone ${id}`, { taskId, dependency: id });
    if (milestoneId) for (const id of list(entry.dependsOn)) if (!acceptedTask(id) && !acceptedMilestone(id)) add('DEPENDENCY_NOT_ACCEPTED', `milestone ${milestoneId} requires accepted ${id}`, { milestoneId, dependency: id });
  }
  if (to === 'ACCEPTED' && !milestoneId) {
    for (const id of list(task.verificationDependsOn)) if (!acceptedTask(id)) add('VERIFICATION_DEPENDENCY_NOT_ACCEPTED', `task ${task.id} requires accepted verification task ${id}`, { taskId, dependency: id });
    for (const id of list(task.completionRequiresMilestones)) if (!acceptedMilestone(id)) add('MILESTONE_NOT_ACCEPTED', `task ${task.id} requires accepted milestone ${id}`, { taskId, dependency: id });
  }
  if (errors.length) return { outcome: 'FAIL', errors };
  const next = structuredClone(queue);
  next.revision = queue.revision + 1;
  const nextTask = next.tasks.find((candidateEntry) => candidateEntry.id === task.id), target = milestoneId ? nextTask.milestones.find((candidateEntry) => candidateEntry.id === milestoneId) : nextTask;
  target.state = to;
  if (SUBMISSION.has(to)) target.attempts = attempt;
  if (to === 'ACCEPTED') target.acceptanceReceipt = { path: receiptPath, sha256: receiptSha };
  if (SUBMISSION.has(to) && receiptPath) {
    target.receiptHistory = list(target.receiptHistory);
    if (!target.receiptHistory.some((candidateEntry) => candidateEntry.path === receiptPath)) target.receiptHistory.push({ path: receiptPath, sha256: receiptSha, attempt, state: to });
  }
  const beforeHistory = list(entry.receiptHistory), afterHistory = list(target.receiptHistory);
  if (afterHistory.length < beforeHistory.length || beforeHistory.some((item, index) => canonicalJson(item) !== canonicalJson(afterHistory[index]))) add('RECEIPT_HISTORY_REWRITTEN', 'receiptHistory is append-only', { taskId });
  if (entry.acceptanceReceipt && canonicalJson(entry.acceptanceReceipt) !== canonicalJson(target.acceptanceReceipt) && !afterHistory.some((item) => item.path === entry.acceptanceReceipt.path)) add('RECEIPT_HISTORY_REWRITTEN', 'previous acceptance receipt must remain in history', { taskId });
  errors.push(...assertAllowedMutations(queue, next));
  errors.push(...validateQueue(next, schema).errors);
  if (errors.length) return { outcome: 'FAIL', errors };
  return { outcome: 'PASS', errors: [], next, attempt };
}
