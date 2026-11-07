import { createHash } from 'node:crypto';

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//iu;
const DIGEST = /^[0-9a-f]{64}$/u;
const CODE_EXTENSION = /\.(ts|tsx|js|jsx|mjs|cjs)$/u;
const REF_KEYS = ['path', 'sha256'];
const HISTORY_KEYS = ['path', 'sha256', 'attempt', 'state'];
const REVIEW_KEYS = ['specVerdict', 'qualityVerdict', 'path', 'sha256'];
const COMMAND_KEYS = ['command', 'cwd', 'expectedExitCode', 'exitCode', 'selectedFiles', 'selectedTests', 'log'];
const RECEIPT_KEYS = ['schemaVersion', 'taskId', 'milestoneId', 'attempt', 'outcome', 'exitCode', 'commands', 'sourceFiles', 'sourceDigest', 'review', 'evidenceDigest', 'changedPaths', 'productTestPaths', 'notes'];
const ALLOWED = [/^revision$/u, /^status$/u, /^updatedAt$/u, /^checkpoint(\.|$)/u, /^tasks\[\d+\]\.(state|readiness|attempts|acceptanceReceipt|receiptHistory)(\.|\[|$)/u, /^tasks\[\d+\]\.milestones\[\d+\]\.(state|attempts|acceptanceReceipt|receiptHistory)(\.|\[|$)/u];

export const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const list = (value) => (Array.isArray(value) ? value : []);
export const push = (errors, code, message, extra = {}) => errors.push({ code, message, ...extra });
export const closed = (value, keys) => isObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function isSafeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.includes('\\') &&
    !value.startsWith('/') && !/^[A-Za-z]:/u.test(value) && !URL_LIKE.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export const underRoots = (value, roots) => {
  if (typeof value !== 'string' || !Array.isArray(roots)) return false;
  return roots.some((root) => value === root || value.startsWith(`${root.replace(/\/+$/u, '')}/`));
};

export const isCodePath = (value) => typeof value === 'string' && CODE_EXTENSION.test(value);
export const isEvidenceOnly = (value, schema) => typeof value === 'string' && (value.startsWith('docs/') || (underRoots(value, schema.evidenceRoots) && !isCodePath(value)));

function sortedPaths(paths) { return [...new Set(paths)].sort(); }

export function checkRef(ref, label, add, options = {}) {
  if (ref === null || ref === undefined) return;
  if (!closed(ref, REF_KEYS)) return add('ACCEPTANCE_RECEIPT_SHAPE', `${label} must be {path,sha256}`);
  if (!isSafeRelative(ref.path)) {
    add('UNSAFE_PATH', `${label} path is not safe workspace-relative`);
    return;
  }
  if (!DIGEST.test(String(ref.sha256))) add('ACCEPTANCE_RECEIPT_SHAPE', `${label} sha256 is not a digest`);
  if (options.roots && !underRoots(ref.path, options.roots)) add('UNSAFE_PATH', `${label} is outside evidenceRoots`);
  if (options.forbidden?.includes(ref.path)) add('INDEPENDENT_EVIDENCE_FORBIDDEN', `${label} is mutable state authority`);
}

export function checkHistory(history, label, add) {
  if (history === undefined) return;
  if (!Array.isArray(history)) return add('RECEIPT_HISTORY_SHAPE', `${label} receiptHistory must be an array`);
  let previousAttempt = 0;
  history.forEach((entry, index) => {
    if (!closed(entry, HISTORY_KEYS)) return add('RECEIPT_HISTORY_SHAPE', `${label} receiptHistory[${index}] must be {path,sha256,attempt,state}`);
    if (!isSafeRelative(entry.path) || !DIGEST.test(String(entry.sha256))) add('UNSAFE_PATH', `${label} receiptHistory[${index}] must carry a safe path and digest`);
    if (!Number.isSafeInteger(entry.attempt) || entry.attempt < 1) add('ATTEMPT_INVALID', `${label} receiptHistory[${index}] attempt must be positive`);
    else {
      if (entry.attempt < previousAttempt) add('RECEIPT_HISTORY_INCOHERENT', `${label} receiptHistory attempts must not decrease`);
      previousAttempt = entry.attempt;
    }
  });
}

function checkCommand(command, index, errors, context) {
  const add = (code, message) => push(errors, code, message);
  if (!closed(command, COMMAND_KEYS)) return add('RECEIPT_SCHEMA', `commands[${index}] must be a closed command record`);
  if (typeof command.command !== 'string' || !command.command.trim()) add('RECEIPT_SCHEMA', `commands[${index}].command must be nonempty`);
  if (command.cwd !== '.' && !isSafeRelative(command.cwd)) add('UNSAFE_PATH', `commands[${index}].cwd is unsafe`);
  if (!Number.isSafeInteger(command.expectedExitCode)) add('RECEIPT_SCHEMA', `commands[${index}].expectedExitCode must be an integer`);
  if (!(command.exitCode === null || Number.isSafeInteger(command.exitCode))) add('RECEIPT_SCHEMA', `commands[${index}].exitCode must be an integer or null`);
  for (const field of ['selectedFiles', 'selectedTests']) {
    if (!(command[field] === null || (Number.isSafeInteger(command[field]) && command[field] >= 0))) add('RECEIPT_SCHEMA', `commands[${index}].${field} must be a non-negative integer or null`);
  }
  checkRef(command.log, `commands[${index}].log`, add, { roots: context.schema.evidenceRoots, forbidden: context.schema.independentEvidenceForbiddenPaths });
}

function checkCrossFieldPaths(receipt, context, errors) {
  const add = (code, message) => push(errors, code, message);
  const sourceFiles = list(receipt.sourceFiles);
  const changedPaths = list(receipt.changedPaths);
  const productTestPaths = list(receipt.productTestPaths);
  for (const field of ['changedPaths', 'productTestPaths']) {
    const paths = receipt[field];
    if (!Array.isArray(paths) || paths.some((entry) => !isSafeRelative(entry))) add('RECEIPT_SCHEMA', `${field} must be an array of safe relative paths`);
    else if (new Set(paths).size !== paths.length) add('DUPLICATE_EVIDENCE_PATH', `${field} repeats a path`);
  }
  const changed = new Set(changedPaths);
  const source = new Set(sourceFiles.map((file) => file?.path));
  for (const file of sourceFiles) if (!changed.has(file?.path)) add('CHANGED_PATHS_INCOMPLETE', `changedPaths omits ${file?.path}`);
  for (const path of productTestPaths) {
    if (!source.has(path)) add('PRODUCT_TEST_PATH_SCOPE', `${path} is not declared in sourceFiles`);
    if (!changed.has(path)) add('CHANGED_PATHS_INCOMPLETE', `changedPaths omits ${path}`);
    if (!context.schema.productTestRoots.some((root) => path === root || path.startsWith(`${root}/`))) add('PRODUCT_TEST_PATH_ROOT', `${path} is not a product path`);
  }
  for (const path of changedPaths) {
    if (!isEvidenceOnly(path, context.schema) && !source.has(path)) add('SOURCE_BINDING_MISSING', `${path} changes content but is not in sourceFiles`);
  }
  if (productTestPaths.length > context.schema.receipt.maxProductTestPaths) add('PRODUCT_TEST_PATH_CAP', `productTestPaths exceeds ${context.schema.receipt.maxProductTestPaths}`);
  const logPaths = list(receipt.commands).map((command) => command?.log?.path);
  const reviewPath = receipt.review?.path;
  for (const sourcePath of source) {
    if (logPaths.includes(sourcePath) || sourcePath === reviewPath || sourcePath === context.receiptPath) add('EVIDENCE_PATH_COLLISION', `${sourcePath} is used as both source and evidence`);
  }
  if (reviewPath && (logPaths.includes(reviewPath) || reviewPath === context.receiptPath)) add('EVIDENCE_PATH_COLLISION', 'review path must differ from logs and the receipt');
  if (new Set(logPaths).size !== logPaths.length) add('DUPLICATE_EVIDENCE_PATH', 'command logs repeat a path');
  if (new Set(sourceFiles.map((file) => file?.path)).size !== sourceFiles.length) add('DUPLICATE_EVIDENCE_PATH', 'sourceFiles repeats a path');
  const behaviorPaths = sortedPaths([...changedPaths, ...productTestPaths].filter((path) => isCodePath(path)));
  if (context.state === 'ACCEPTED' && behaviorPaths.length > 0 && !list(receipt.commands).some((command) => Number.isSafeInteger(command?.selectedTests) && command.selectedTests > 0)) {
    add('TEST_COUNT_MISSING', 'behavior-changing source acceptance requires a positive selected test count');
  }
}

export function checkAcceptanceLedger(entry, label, attempts, add) {
  if (!entry.acceptanceReceipt) return;
  const history = list(entry.receiptHistory);
  if (!history.length) return add('RECEIPT_HISTORY_INCOHERENT', `${label} acceptance requires receipt history`);
  if (history.some((item) => item.attempt > attempts)) return add('RECEIPT_HISTORY_INCOHERENT', `${label} history exceeds its attempt`);
  const submissions = history.filter((item) => item.state === 'SUBMITTED');
  if (!submissions.length) {
    if (attempts > 1 || history.some((item) => item.state !== 'ACCEPTED')) add('RECEIPT_HISTORY_INCOHERENT', `${label} acceptance lacks a submitted candidate`);
    return;
  }
  const atAttempt = submissions.filter((item) => item.attempt === attempts);
  if (atAttempt.length !== 1) add('RECEIPT_HISTORY_INCOHERENT', `${label} acceptance requires exactly one submitted candidate at attempt ${attempts}`);
}

export function consumedReceipts(queue) {
  const entries = [];
  for (const task of list(queue.tasks)) {
    if (!isObject(task)) continue;
    if (task.acceptanceReceipt) entries.push({ ...task.acceptanceReceipt, taskId: task.id, milestoneId: null, attempt: task.attempts });
    for (const entry of list(task.receiptHistory)) entries.push({ ...entry, taskId: task.id, milestoneId: null });
    for (const milestone of list(task.milestones)) {
      if (!isObject(milestone)) continue;
      if (milestone.acceptanceReceipt) entries.push({ ...milestone.acceptanceReceipt, taskId: task.id, milestoneId: milestone.id, attempt: milestone.attempts ?? 0 });
      for (const entry of list(milestone.receiptHistory)) entries.push({ ...entry, taskId: task.id, milestoneId: milestone.id });
    }
  }
  return entries;
}

export function validateReceipt(receipt, context) {
  const errors = [];
  const add = (code, message) => push(errors, code, message);
  const schema = context?.schema;
  if (!isObject(schema)) {
    add('SCHEMA_SHAPE', 'schema object is required');
    return { errors };
  }
  if (!isObject(receipt)) {
    add('RECEIPT_SCHEMA', 'receipt must be an object');
    return { errors };
  }
  const spec = schema.receipt;
  if (!closed(receipt, RECEIPT_KEYS)) add('RECEIPT_SCHEMA', 'receipt keys are not the closed receipt set');
  if (receipt.schemaVersion !== spec.schemaVersion) add('RECEIPT_SCHEMA', 'receipt schemaVersion is not supported');
  if (receipt.taskId !== context.taskId) add('RECEIPT_TASK_MISMATCH', `receipt taskId ${receipt.taskId} does not match ${context.taskId}`);
  if ((receipt.milestoneId ?? null) !== (context.milestoneId ?? null)) add('RECEIPT_MILESTONE_MISMATCH', 'receipt milestoneId does not match the transition target');
  if (!Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1) add('RECEIPT_SCHEMA', 'attempt must be a positive integer');
  else if (receipt.attempt !== context.attempt) add('RECEIPT_ATTEMPT_MISMATCH', `receipt attempt ${receipt.attempt} is not ${context.attempt}`);
  if (!spec.outcomes.includes(receipt.outcome)) add('RECEIPT_SCHEMA', `outcome ${receipt.outcome} is unknown`);
  if (!(receipt.exitCode === null || Number.isSafeInteger(receipt.exitCode))) add('RECEIPT_SCHEMA', 'exitCode must be an integer or null');
  const commands = list(receipt.commands);
  if (!Array.isArray(receipt.commands)) add('RECEIPT_SCHEMA', 'commands must be an array'); else commands.forEach((command, index) => checkCommand(command, index, errors, context));
  if (receipt.outcome === 'PASS') {
    if (receipt.exitCode !== 0 || !commands.length) add('OUTCOME_EXIT_CONTRADICTION', 'PASS must carry exitCode 0 and at least one command');
    for (const command of commands) if (command?.exitCode !== command?.expectedExitCode) add('OUTCOME_EXIT_CONTRADICTION', 'PASS commands must match their expected exits');
  } else if (receipt.outcome === 'FAIL') {
    if (receipt.exitCode === 0) add('OUTCOME_EXIT_CONTRADICTION', 'FAIL cannot claim exit 0');
  } else if (receipt.exitCode === 0) add('OUTCOME_EXIT_CONTRADICTION', `${receipt.outcome} cannot carry exit 0`);
  const review = receipt.review;
  if (!closed(review, REVIEW_KEYS)) add('RECEIPT_SCHEMA', 'review must be {specVerdict,qualityVerdict,path,sha256}');
  else {
    if (!spec.reviewVerdicts.includes(review.specVerdict) || !spec.reviewVerdicts.includes(review.qualityVerdict)) add('RECEIPT_SCHEMA', 'review verdicts are outside the closed set');
    checkRef({ path: review.path, sha256: review.sha256 }, 'review', add, { roots: schema.evidenceRoots, forbidden: schema.independentEvidenceForbiddenPaths });
  }
  if (context.state === 'ACCEPTED') {
    if (receipt.outcome !== 'PASS') add('ACCEPTANCE_OUTCOME', 'accepted evidence must have a PASS outcome');
    if (review?.specVerdict !== 'PASS' || review?.qualityVerdict !== 'PASS') add('REVIEW_NOT_PASS', 'both review verdicts must be PASS for acceptance');
  }
  const sourceFiles = list(receipt.sourceFiles);
  if (!Array.isArray(receipt.sourceFiles)) add('RECEIPT_SCHEMA', 'sourceFiles must be an array'); else sourceFiles.forEach((file, index) => checkRef(file, `sourceFiles[${index}]`, add));
  if (!isSafeRelative(context.receiptPath ?? '')) add('UNSAFE_PATH', 'receipt path is not safe workspace-relative');
  else if (!underRoots(context.receiptPath, schema.evidenceRoots)) add('UNSAFE_PATH', 'receipt path is outside evidenceRoots');
  else if (schema.independentEvidenceForbiddenPaths.includes(context.receiptPath)) add('INDEPENDENT_EVIDENCE_FORBIDDEN', 'receipt is mutable state authority');
  checkCrossFieldPaths(receipt, context, errors);
  const sortedSources = [...sourceFiles].sort((left, right) => (String(left?.path) < String(right?.path) ? -1 : 1));
  if (receipt.sourceDigest !== sha256(canonicalJson(sortedSources))) add('SOURCE_DIGEST_MISMATCH', 'sourceDigest does not hash the declared sourceFiles');
  const { evidenceDigest: _omitted, ...withoutDigest } = receipt;
  if (receipt.evidenceDigest !== sha256(canonicalJson(withoutDigest))) add('EVIDENCE_DIGEST_MISMATCH', 'evidenceDigest does not hash this receipt without itself');
  return { errors };
}

export function receiptScope(receipt) {
  return {
    taskId: receipt.taskId,
    milestoneId: receipt.milestoneId ?? null,
    attempt: receipt.attempt,
    sourceDigest: receipt.sourceDigest,
    sourceFiles: [...list(receipt.sourceFiles)].sort((left, right) => (String(left?.path) < String(right?.path) ? -1 : 1)),
    changedPaths: sortedPaths(list(receipt.changedPaths)),
    productTestPaths: sortedPaths(list(receipt.productTestPaths)),
  };
}

export function candidateMatches(acceptance, candidate) {
  if (!candidate || acceptance.taskId !== candidate.taskId || (acceptance.milestoneId ?? null) !== candidate.milestoneId || acceptance.attempt !== candidate.attempt) return false;
  if (acceptance.sourceDigest !== candidate.sourceDigest) return false;
  const acceptanceScope = receiptScope(acceptance), candidateScope = receiptScope(candidate);
  if (canonicalJson(acceptanceScope.sourceFiles) !== canonicalJson(candidateScope.sourceFiles)) return false;
  if (canonicalJson(acceptanceScope.productTestPaths) !== canonicalJson(candidateScope.productTestPaths)) return false;
  const codeScope = (scope) => canonicalJson(sortedPaths([...scope.changedPaths, ...scope.productTestPaths].filter((path) => isCodePath(path))));
  return codeScope(acceptanceScope) === codeScope(candidateScope);
}

export function assertAllowedMutations(before, after) {
  const changes = [];
  const walk = (left, right, prefix) => {
    if (canonicalJson(left) === canonicalJson(right)) return;
    if (isObject(left) && isObject(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) walk(left[key], right[key], prefix ? `${prefix}.${key}` : key);
      return;
    }
    if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
      left.forEach((value, index) => walk(value, right[index], `${prefix}[${index}]`));
      return;
    }
    changes.push(prefix || '<root>');
  };
  walk(before, after, '');
  return changes
    .filter((field) => !ALLOWED.some((pattern) => pattern.test(field)))
    .map((field) => ({ code: 'PROTECTED_FIELD_CHANGED', message: `${field} may not change through a transition`, field }));
}

export function nextAttempt(queue, taskId, milestoneId, to) {
  const task = list(queue.tasks).find((candidate) => candidate?.id === taskId);
  const entry = milestoneId ? list(task?.milestones).find((candidate) => candidate?.id === milestoneId) : task;
  const currentState = entry?.state ?? 'PLANNED';
  const currentAttempts = entry?.attempts ?? 0;
  if (to === 'SUBMITTED') return currentAttempts + 1;
  if (to === 'ACCEPTED' && currentState !== 'SUBMITTED' && currentAttempts === 0) return 1;
  return currentAttempts;
}
