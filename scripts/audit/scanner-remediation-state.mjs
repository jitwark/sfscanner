import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isObject, isSafeRelative, list, nextAttempt, sha256, validateReceipt } from './scanner-remediation-state-receipts.mjs';
import { checkStop, planTransition, validateQueue } from './scanner-remediation-state-rules.mjs';

export { checkStop, validateQueue };
export const WORKSPACE = path.resolve(import.meta.dirname, '../..');
const SUBMISSION = new Set(['SUBMITTED', 'ACCEPTED', 'REQUIRED_FIXES']);
const reject = (code, message, details = {}) => Object.assign(new Error(`${code}: ${message}`), { code, details });
const failAll = (errors, details = {}) => Object.assign(new Error(errors.map((item) => `${item.code}: ${item.message}`).join('; ')), { code: errors[0]?.code ?? 'REJECTED', errors, details });
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text), usage = (message) => reject('USAGE', message);
const insidePath = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);
const samePath = (left, right) => (process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right);

async function loadSchema(io) { return JSON.parse(stripBom(await io.readFile(path.join(WORKSPACE, 'docs/audit/2026-10-24-master-remediation/TASK-STATE-SCHEMA.json'), 'utf8'))); }

async function assertContained(rel, roots, io, label, forbidden = []) {
  if (!isSafeRelative(rel)) throw reject('UNSAFE_PATH', `${label} is not a safe workspace-relative path`);
  let absolute, real;
  try { absolute = path.resolve(WORKSPACE, rel); real = await io.realpath(absolute); } catch (error) {
    if (error.code === 'ENOENT') throw reject('EVIDENCE_FILE_MISSING', `${label} ${rel} does not exist`);
    throw reject('UNSAFE_PATH', `${label} ${rel} cannot be resolved: ${error.message}`);
  }
  const realWorkspace = await io.realpath(WORKSPACE); if (!insidePath(real, realWorkspace)) throw reject('UNSAFE_PATH', `${label} resolves outside the workspace`);
  const realForbidden = await Promise.all(forbidden.map(async (entry) => io.realpath(path.resolve(WORKSPACE, entry)).catch(() => null))); if (realForbidden.includes(real)) throw reject('INDEPENDENT_EVIDENCE_FORBIDDEN', `${label} resolves to mutable state authority`);
  if (roots) { const realRoots = await Promise.all(roots.map(async (root) => io.realpath(path.resolve(WORKSPACE, root)))); if (!realRoots.some((root) => insidePath(real, root))) throw reject('UNSAFE_PATH', `${label} resolves outside evidenceRoots`); }
  return real;
}

async function verifyEvidence(receipt, context) {
  const drift = [];
  const check = async (rel, expected, roots, label, historicalSource = false, forbidden = []) => {
    let bytes;
    try { bytes = await context.io.readFile(await assertContained(rel, roots, context.io, label, forbidden)); } catch (error) {
      if (historicalSource && error.code === 'EVIDENCE_FILE_MISSING') { drift.push({ taskId: context.taskId, milestoneId: context.milestoneId, path: rel, expectedSha256: expected, liveSha256: null }); return; }
      throw error;
    }
    const actual = sha256(bytes);
    if (actual !== expected && historicalSource) drift.push({ taskId: context.taskId, milestoneId: context.milestoneId, path: rel, expectedSha256: expected, liveSha256: actual });
    else if (actual !== expected) throw reject('EVIDENCE_DIGEST_MISMATCH', `${label} ${rel} does not match its declared sha256`);
  };
  for (const command of list(receipt.commands)) await check(command?.log?.path, command?.log?.sha256, context.schema.evidenceRoots, 'command log', false, context.schema.independentEvidenceForbiddenPaths);
  await check(receipt.review?.path, receipt.review?.sha256, context.schema.evidenceRoots, 'review', false, context.schema.independentEvidenceForbiddenPaths);
  for (const file of list(receipt.sourceFiles)) await check(file?.path, file?.sha256, null, 'source file', context.mode === 'historical');
  return drift;
}

async function verifyProtectedFixtures(queue, schema, io) {
  for (const fixture of list(queue.protectedFixtures)) {
    try {
      const bytes = await io.readFile(await assertContained(fixture.path, null, io, 'protected fixture'));
      if (sha256(bytes) !== fixture.sha256) throw reject('PROTECTED_FIXTURE_CHANGED', `protected fixture ${fixture.path} changed`);
    } catch (error) {
      if (error.code === 'PROTECTED_FIXTURE_CHANGED') throw error;
      throw reject('PROTECTED_FIXTURE_CHANGED', `protected fixture ${fixture.path} is not readable evidence: ${error.message}`);
    }
  }
}

async function verifyAcceptedEvidence(queue, schema, io) {
  const drift = [];
  for (const task of list(queue.tasks)) {
    const entries = [{ entry: task, taskId: task?.id, milestoneId: null }]; for (const milestone of list(task?.milestones)) entries.push({ entry: milestone, taskId: task?.id, milestoneId: milestone?.id });
    for (const { entry, taskId, milestoneId } of entries) {
      if ((entry?.state ?? 'PLANNED') !== 'ACCEPTED' || !entry.acceptanceReceipt) continue;
      const ref = entry.acceptanceReceipt;
      let bytes;
      try { bytes = await io.readFile(await assertContained(ref.path, schema.evidenceRoots, io, 'accepted receipt', schema.independentEvidenceForbiddenPaths), 'utf8'); } catch (error) { if (['UNSAFE_PATH', 'INDEPENDENT_EVIDENCE_FORBIDDEN'].includes(error.code)) throw error; throw reject('ACCEPTED_RECEIPT_MISSING', `accepted receipt ${ref.path} cannot be read: ${error.message}`); }
      if (sha256(bytes) !== ref.sha256) throw reject('ACCEPTED_RECEIPT_CHANGED', `accepted receipt ${ref.path} no longer matches its recorded sha256`);
      let receipt; try { receipt = JSON.parse(stripBom(bytes)); } catch (error) { throw reject('ACCEPTED_RECEIPT_UNREADABLE', `accepted receipt ${ref.path} is not JSON: ${error.message}`); }
      const errors = validateReceipt(receipt, { schema, taskId, milestoneId, attempt: entry.attempts ?? 0, state: 'ACCEPTED', receiptPath: ref.path }).errors; if (errors.length) throw failAll(errors, { taskId, milestoneId });
      drift.push(...await verifyEvidence(receipt, { schema, io, mode: 'historical', taskId, milestoneId }));
    }
  }
  return drift;
}

async function loadSubmittedCandidate(queue, schema, io, taskId, milestoneId, attempt) {
  const task = list(queue.tasks).find((candidate) => candidate?.id === taskId);
  const entry = milestoneId ? list(task?.milestones).find((candidate) => candidate?.id === milestoneId) : task;
  const submission = list(entry?.receiptHistory).find((item) => item.state === 'SUBMITTED' && item.attempt === attempt);
  if (!submission) return null;
  let bytes;
  try { bytes = await io.readFile(await assertContained(submission.path, schema.evidenceRoots, io, 'submitted receipt', schema.independentEvidenceForbiddenPaths), 'utf8'); } catch (error) { if (['UNSAFE_PATH', 'INDEPENDENT_EVIDENCE_FORBIDDEN'].includes(error.code)) throw error; throw reject('ACCEPTED_RECEIPT_MISSING', `submitted candidate ${submission.path} cannot be read: ${error.message}`); }
  if (sha256(bytes) !== submission.sha256) throw reject('ACCEPTED_RECEIPT_CHANGED', `submitted candidate ${submission.path} no longer matches its history hash`);
  let receipt; try { receipt = JSON.parse(stripBom(bytes)); } catch (error) { throw reject('ACCEPTED_RECEIPT_UNREADABLE', `submitted candidate ${submission.path} is not JSON: ${error.message}`); }
  const checked = validateReceipt(receipt, { schema, taskId, milestoneId, attempt, state: 'SUBMITTED', receiptPath: submission.path }); if (checked.errors.length) throw failAll(checked.errors);
  await verifyEvidence(receipt, { schema, io, mode: 'strict', taskId, milestoneId });
  return receipt;
}

function allowedQueuePath(file, schema) {
  return isSafeRelative(file) && (schema.writeTargets.includes(file) || (typeof schema.scratchRoot === 'string' && (file === schema.scratchRoot || file.startsWith(`${schema.scratchRoot}/`))));
}

async function queueTarget(file, schema, io) {
  if (!allowedQueuePath(file, schema)) throw reject('UNSAFE_PATH', '--file is not a schema write target or a queue under owned scratch');
  const absolute = path.resolve(WORKSPACE, file);
  const real = await io.realpath(absolute).catch((error) => { throw reject('UNSAFE_PATH', `queue ${file} cannot be resolved: ${error.message}`); });
  const realWorkspace = await io.realpath(WORKSPACE); if (!insidePath(real, realWorkspace)) throw reject('UNSAFE_PATH', `queue ${file} resolves outside the workspace`);
  const literalParent = path.resolve(WORKSPACE, path.dirname(file)), realParent = await io.realpath(literalParent).catch((error) => { throw reject('UNSAFE_PATH', `queue parent cannot be resolved: ${error.message}`); });
  if (schema.writeTargets.includes(file)) {
    if (!samePath(realParent, literalParent) || !samePath(real, path.join(literalParent, path.basename(absolute)))) throw reject('UNSAFE_PATH', `authority write target ${file} resolves through an alias`);
  } else {
    const realScratch = await io.realpath(path.resolve(WORKSPACE, schema.scratchRoot));
    if (!insidePath(real, realScratch) || !insidePath(realParent, realScratch)) throw reject('UNSAFE_PATH', `queue ${file} resolves outside owned scratch`);
  }
  return { absolute, real };
}

async function inspectQueue(file, io) {
  const schema = await loadSchema(io), { queue, real } = await queueTarget(file, schema, io);
  let parsed;
  try { parsed = JSON.parse(stripBom(await io.readFile(real, 'utf8'))); } catch (error) { throw reject('QUEUE_UNREADABLE', `queue ${file} is not readable JSON: ${error.message}`); }
  const structural = validateQueue(parsed, schema), errors = [...structural.errors];
  let sourceDrift = [];
  if (!errors.length) {
    try { await verifyProtectedFixtures(parsed, schema, io); sourceDrift = await verifyAcceptedEvidence(parsed, schema, io); } catch (error) { errors.push(...(error.errors ?? [{ code: error.code ?? 'EVIDENCE_UNVERIFIED', message: error.message }])); }
  }
  return { schema, queue: parsed, real, structural, errors, sourceDrift };
}

export async function validateQueueFile(file, { io = fsp } = {}) {
  const inspected = await inspectQueue(file, io);
  return { command: 'validate', outcome: inspected.errors.length ? 'FAIL' : 'PASS', file, revision: inspected.queue?.revision ?? null, errors: inspected.errors, ready: inspected.structural.ready, preparable: inspected.structural.preparable, frontier: inspected.structural.frontier, stop: checkStop(inspected.queue, { schema: inspected.schema }), sourceDrift: inspected.sourceDrift, limitations: ['Evidence digests are host-verified bytes, not a security verdict.', 'Historical source drift is reported, never rewritten.'] };
}

export async function transitionQueue(options) {
  if (!isObject(options)) throw reject('USAGE', 'transitionQueue requires an options object');
  const io = options.io ?? fsp, schema = options.schema ?? await loadSchema(io), file = options.file; if ('schema' in options && !isObject(options.schema)) throw reject('SCHEMA_SHAPE', 'schema object is required');
  if (!file) throw reject('UNSAFE_PATH', '--file is required');
  if (options.receiptPath && !SUBMISSION.has(options.to)) throw reject('RECEIPT_NOT_CONSUMED', 'receipt is not consumed by this transition');
  const target = await queueTarget(file, schema, io), lockPath = `${target.real}.lock`, token = `${process.pid}:${randomUUID()}`;
  let lock, failure = null, result, tempPath = null, releaseError = null, releaseSkipped = null;
  try { lock = await io.open(lockPath, 'wx'); await lock.writeFile(token, 'utf8'); await lock.sync(); } catch (error) {
    if (lock) { await lock.close().catch(() => {}); await io.unlink(lockPath).catch(() => {}); }
    if (error.code === 'EEXIST') throw reject('LOCK_HELD', `lock ${lockPath} already exists; controller recovery is required`, { lockPath });
    throw reject('LOCK_FAILED', `cannot acquire ${lockPath}: ${error.message}`, { lockPath });
  }
  try {
    const initialBytes = await io.readFile(target.real, 'utf8'), initialHash = sha256(initialBytes), eol = initialBytes.includes('\r\n') ? '\r\n' : '\n';
    let queue; try { queue = JSON.parse(stripBom(initialBytes)); } catch (error) { throw reject('QUEUE_UNREADABLE', `queue ${file} is not JSON: ${error.message}`); }
    const structural = validateQueue(queue, schema); if (structural.errors.length) throw failAll(structural.errors);
    await verifyProtectedFixtures(queue, schema, io);
    const drift = await verifyAcceptedEvidence(queue, schema, io);
    let receipt = null, receiptPath = null, receiptSha = null, currentDrift = [], candidate = null;
    if (SUBMISSION.has(options.to) && options.receiptPath) {
      receiptPath = options.receiptPath;
      let bytes;
      try { bytes = await io.readFile(await assertContained(receiptPath, schema.evidenceRoots, io, 'receipt', schema.independentEvidenceForbiddenPaths), 'utf8'); } catch (error) { if (['UNSAFE_PATH', 'INDEPENDENT_EVIDENCE_FORBIDDEN'].includes(error.code)) throw error; throw reject('EVIDENCE_FILE_MISSING', `receipt ${receiptPath} cannot be read: ${error.message}`); }
      receiptSha = sha256(bytes); try { receipt = JSON.parse(stripBom(bytes)); } catch (error) { throw reject('RECEIPT_UNREADABLE', `receipt ${receiptPath} is not JSON: ${error.message}`); }
      const attempt = nextAttempt(queue, options.taskId, options.milestoneId ?? null, options.to), checked = validateReceipt(receipt, { schema, taskId: options.taskId, milestoneId: options.milestoneId ?? null, attempt, state: options.to, receiptPath });
      if (checked.errors.length) throw failAll(checked.errors);
      currentDrift = await verifyEvidence(receipt, { schema, io, mode: 'strict', taskId: options.taskId, milestoneId: options.milestoneId ?? null });
      if (options.to === 'ACCEPTED' && attempt > 0) candidate = await loadSubmittedCandidate(queue, schema, io, options.taskId, options.milestoneId ?? null, attempt);
    }
    const plan = planTransition(queue, schema, { ...options, receipt, receiptPath, receiptSha, candidate, evidenceVerified: true }); if (plan.errors.length) throw failAll(plan.errors);
    const planned = validateQueue(plan.next, schema); if (planned.errors.length) throw failAll(planned.errors);
    const serialized = `${JSON.stringify(plan.next, null, 2).replace(/\n/gu, eol)}${eol}`, intendedHash = sha256(serialized);
    tempPath = `${target.real}.tmp-${process.pid}-${randomUUID()}`;
    const temp = await io.open(tempPath, 'wx');
    try { await temp.writeFile(serialized, 'utf8'); await temp.sync(); } finally { await temp.close(); }
    const currentTarget = await queueTarget(file, schema, io);
    if (!samePath(currentTarget.real, target.real)) throw reject('TARGET_IDENTITY_CHANGED', `queue ${file} resolved to a different file before replacement`, { targetPath: target.absolute });
    if (sha256(await io.readFile(target.real, 'utf8')) !== initialHash) throw reject('CONCURRENT_REVISION', `queue ${file} changed while the transition was prepared`, { targetPath: target.absolute });
    try { await io.rename(tempPath, target.real); } catch (error) {
      throw reject('REPLACE_FAILED', `replace failed for ${target.absolute}: ${error.message}; recovery: close the holding process, confirm the stated revision, remove ${tempPath}, rerun with the current revision`, { targetPath: target.absolute, tempPath, recovery: 'confirm-revision-and-remove-owned-temp' });
    }
    const readback = await io.readFile(target.real, 'utf8');
    if (sha256(readback) !== intendedHash) throw reject('READBACK_MISMATCH', `queue ${file} readback does not match the intended bytes; revalidate before rerun`, { targetPath: target.absolute, intendedHash, readbackHash: sha256(readback), recovery: 'revalidate-before-rerun' });
    result = { command: 'transition', outcome: 'PASS', file, previousRevision: queue.revision, revision: plan.next.revision, taskId: options.taskId, milestoneId: options.milestoneId ?? null, to: options.to, attempt: plan.attempt, receipt: receiptPath ? { path: receiptPath, sha256: receiptSha } : null, queueSha256: intendedHash, sourceDrift: [...drift, ...currentDrift], limitations: ['Evidence checks bind declared bytes at transition time; they do not prove command execution or reviewer independence.', 'No crash or power-loss atomicity guarantee.'] };
  } catch (error) {
    failure = error;
    if (tempPath && !['REPLACE_FAILED', 'READBACK_MISMATCH'].includes(error.code)) await io.unlink(tempPath).catch(() => {});
  } finally {
    try { await lock.close(); } catch (error) { releaseError = error; }
    try {
      const current = await io.readFile(lockPath, 'utf8').catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
      if (current === token) await io.unlink(lockPath);
      else if (current !== null) releaseSkipped = { lockPath, reason: 'lock-replaced-by-another-invocation' };
    } catch (error) { releaseError = releaseError ?? error; }
  }
  if (failure) {
    if (releaseError) failure.details = { ...(failure.details ?? {}), releaseError: { code: releaseError.code, message: releaseError.message } };
    if (releaseSkipped) failure.details = { ...(failure.details ?? {}), releaseSkipped };
    throw failure;
  }
  if (releaseError) result.warnings = [{ code: 'LOCK_RELEASE_FAILED', message: releaseError.message }];
  if (releaseSkipped) result.warnings = [...(result.warnings ?? []), { code: 'LOCK_RELEASE_SKIPPED', message: releaseSkipped.reason }];
  return result;
}

function parseFlags(args, allowed) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) throw usage(`unexpected argument ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) throw usage(`unexpected flag --${key}`);
    if (flags.has(key)) throw usage(`duplicate flag --${key}`);
    if (allowed.get(key) === true) { flags.set(key, true); continue; }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw usage(`--${key} requires a value`);
    flags.set(key, value);
    index += 1;
  }
  return flags;
}
const required = (flags, key) => { const value = flags.get(key); if (typeof value !== 'string' || !value) throw usage(`--${key} is required`); return value; };

export async function runCli(argv = [], { io = fsp, stdout = (line) => process.stdout.write(line), stderr = (line) => process.stderr.write(line) } = {}) {
  try {
    const [command, ...rest] = argv;
    if (command === 'validate') {
      const flags = parseFlags(rest, new Map([['file', false]])), result = await validateQueueFile(required(flags, 'file'), { io });
      stdout(`${JSON.stringify(result, null, 2)}\n`); return result.errors.length ? 1 : 0;
    }
    if (command === 'transition') {
      const flags = parseFlags(rest, new Map([['file', false], ['expected-revision', false], ['task', false], ['milestone', false], ['to', false], ['receipt', false]]));
      const revision = required(flags, 'expected-revision'), to = required(flags, 'to'), receiptPath = flags.get('receipt') ?? null;
      if (!/^(0|[1-9][0-9]*)$/u.test(revision)) throw usage('--expected-revision must be a non-negative integer');
      if (receiptPath && !SUBMISSION.has(to)) throw usage('--receipt is not consumed by this transition');
      const result = await transitionQueue({ io, file: required(flags, 'file'), expectedRevision: Number(revision), taskId: required(flags, 'task'), milestoneId: flags.get('milestone') ?? null, to, receiptPath });
      stdout(`${JSON.stringify(result, null, 2)}\n`); return 0;
    }
    if (command === 'stop') {
      const flags = parseFlags(rest, new Map([['file', false], ['checkpoint', true], ['task', false], ['next-action', false]]));
      const checkpoint = flags.get('checkpoint') === true, task = flags.get('task') ?? null, nextAction = flags.get('next-action') ?? null;
      if (!checkpoint && (task || nextAction)) throw usage('--task and --next-action require --checkpoint');
      if (checkpoint && (!task || !nextAction)) throw usage('--checkpoint requires --task and --next-action');
      const inspected = await inspectQueue(required(flags, 'file'), io);
      const result = inspected.errors.length
        ? { command: 'stop', file: flags.get('file'), outcome: 'INVALID', errors: inspected.errors }
        : { command: 'stop', file: flags.get('file'), ...checkStop(inspected.queue, { schema: inspected.schema, checkpoint, task, nextAction }) };
      stdout(`${JSON.stringify(result, null, 2)}\n`); return ['COMPLETE', 'CHECKPOINT'].includes(result.outcome) ? 0 : 1;
    }
    throw usage(`unknown command ${command}`);
  } catch (error) {
    const errors = error.errors ?? [{ code: error.code ?? 'INTERNAL_ERROR', message: error.message }], payload = { command: 'error', outcome: 'FAIL', errors, ...(error.details ? { details: error.details } : {}) };
    if (error.code === 'USAGE') { stderr(`${JSON.stringify(payload)}\n`); return 2; }
    stdout(`${JSON.stringify(payload, null, 2)}\n`);
    if (!error.code) stderr(`${error.stack}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
