/**
 * Q08.3d — bounded static caller-workflow policy validator for the n8n
 * SecureFlow composite scan Action. Only observable caller policy passes:
 * missing permissions, reusable workflows, unresolved expressions and
 * unapproved Action commits yield UNKNOWN, because a composite Action cannot
 * prove caller permissions, secrets, environments or event type.
 * CLI: --workflow <path> --action-sha <40-hex>; 0 PASS, 1 FAIL, 2 UNKNOWN.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export const DEFAULT_ACTION_PATH = 'jitwark/sfscanner/.github/actions/scan';
export const APPROVED_ACTION_PATHS = new Set([DEFAULT_ACTION_PATH.toLowerCase()]);
const MAX_WORKFLOW_BYTES = 256 * 1024;
const MAX_WALK_DEPTH = 32;
const EXPRESSION = /\$\{\{/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const CHECKOUT = /^actions\/checkout(?:@|\/|$)/iu;
const SARIF_UPLOAD = /^github\/codeql-action\/upload-sarif(?:@|\/|$)/iu;
const SECRET_REFERENCE = /\$\{\{\s*secrets(?:\.|\[)/iu;
const GITHUB_TOKEN_REFERENCE = /\$\{\{\s*github(?:\.token|\['token'\]|\["token"\])/iu;
const RESERVED_SCANNER_INPUTS = new Set(['scanner-ref', 'scanner-repository', 'repository', 'ref']);
const PASS_REASON = 'caller workflow matches the static caller policy';

const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Depth- and cycle-bounded search for a pattern in every string value. */
function hasMatch(value, pattern, depth = 0, seen = new Set(), onLimit = null) {
  if (typeof value === 'string') return pattern.test(value);
  if (!isMapping(value) && !Array.isArray(value)) return false;
  if (depth >= MAX_WALK_DEPTH) { onLimit?.(); return false; }
  if (seen.has(value)) return false;
  seen.add(value);
  return (Array.isArray(value) ? value : Object.values(value)).some((child) => hasMatch(child, pattern, depth + 1, seen, onLimit));
}

function parseWorkflow(input) {
  if (isMapping(input) || Array.isArray(input)) return { ok: true, value: input };
  if (typeof input !== 'string') return { ok: false, reason: 'workflow must be YAML text or a parsed mapping' };
  if (Buffer.byteLength(input, 'utf8') > MAX_WORKFLOW_BYTES) return { ok: false, reason: 'workflow text exceeds the static parse bound' };
  try { return { ok: true, value: yaml.load(input) }; } catch (error) { return { ok: false, reason: `workflow YAML did not parse: ${error.message}` }; }
}

function splitUses(uses) {
  const at = uses.lastIndexOf('@');
  const target = (at === -1 ? uses : uses.slice(0, at)).toLowerCase().replace(/\/action\.ya?ml$/u, '').replace(/\/+$/u, '');
  return { target, ref: at === -1 ? null : uses.slice(at + 1) };
}

const normalizeActionPath = (value) => String(value).trim().toLowerCase().replace(/\/action\.ya?ml$/u, '').replace(/\/+$/u, '');
const stepsOf = (job) => (Array.isArray(job.steps) ? job.steps.filter(isMapping) : []);
const jobPermissions = (workflow, job) => (Object.hasOwn(job, 'permissions') ? job.permissions : workflow.permissions);

function checkTrigger(workflow, fails, unknowns) {
  const hasOn = Object.hasOwn(workflow, 'on');
  if (hasOn && Object.hasOwn(workflow, 'true')) { unknowns.push('workflow declares both "on" and a boolean trigger key; the event cannot be resolved'); return; }
  const trigger = hasOn ? workflow.on : workflow.true;
  let events;
  if (typeof trigger === 'string') events = [trigger];
  else if (Array.isArray(trigger)) events = trigger.filter((event) => typeof event === 'string');
  else if (isMapping(trigger)) events = Object.keys(trigger);
  else { unknowns.push('workflow has no resolvable trigger event'); return; }
  if (events.length === 0) { unknowns.push('workflow declares no trigger event'); return; }
  if (events.some((event) => EXPRESSION.test(event)) || hasMatch(trigger, EXPRESSION)) {
    unknowns.push('workflow event depends on an unresolved expression');
    return;
  }
  const reusable = events.includes('workflow_call');
  if (reusable) unknowns.push('reusable workflow (workflow_call) delegates the caller policy and cannot be proven');
  if (events.includes('pull_request_target')) fails.push('event pull_request_target is never allowed; the caller must use pull_request');
  const other = events.filter((event) => !['pull_request', 'workflow_call', 'pull_request_target'].includes(event));
  if (other.length > 0) fails.push(`event(s) other than pull_request are not allowed: ${other.join(', ')}`);
  if (!reusable && !events.includes('pull_request')) fails.push('workflow must trigger on pull_request');
}

function permissionEntries(value, label, fails, unknowns) {
  if (typeof value === 'string') {
    if (EXPRESSION.test(value)) unknowns.push(`${label} permissions depend on an unresolved expression`);
    else fails.push(`${label} permissions "${value}" are not an explicit mapping`);
    return null;
  }
  if (!isMapping(value)) { unknowns.push(`${label} permissions have an unsupported shape`); return null; }
  const entries = Object.entries(value);
  if (entries.some(([key, level]) => EXPRESSION.test(key) || (typeof level === 'string' && EXPRESSION.test(level)))) {
    unknowns.push(`${label} permissions depend on an unresolved expression`);
    return null;
  }
  return entries;
}

function checkScannerPermissions(workflow, job, fails, unknowns) {
  const permissions = jobPermissions(workflow, job);
  if (permissions === undefined) {
    unknowns.push('scanner job has no explicit permissions and no workflow-level permissions; repository defaults are never assumed');
    return;
  }
  const entries = permissionEntries(permissions, 'scanner job', fails, unknowns);
  if (!entries) return;
  const extra = entries.map(([key]) => key).filter((key) => key !== 'contents');
  if (extra.length > 0) fails.push(`scanner job grants permissions beyond contents: read (${extra.join(', ')})`);
  if (permissions.contents === undefined) fails.push('scanner job does not grant contents: read');
  else if (permissions.contents !== 'read') fails.push(`scanner job must grant contents: read, found contents: ${String(permissions.contents)}`);
}

function checkScannerIsolation(job, jobId, scanStep, fails, unknowns) {
  if (Object.hasOwn(job, 'secrets')) fails.push(`scanner job "${jobId}" must not declare secrets`);
  if (Object.hasOwn(job, 'environment')) fails.push(`scanner job "${jobId}" must not declare a deployment environment`);
  const withArgs = isMapping(scanStep.with) ? scanStep.with : {};
  for (const key of Object.keys(withArgs)) {
    if (RESERVED_SCANNER_INPUTS.has(key.toLowerCase())) fails.push(`scan step passes caller-supplied ${key}; the Action must own its scanner repository and ref`);
  }
  const onDepth = () => unknowns.push(`scanner job "${jobId}" exceeds maximum inspection depth; security properties cannot be proven`);
  if (hasMatch(job, SECRET_REFERENCE, 0, new Set(), onDepth)) fails.push('scanner job references the secrets context');
  if (hasMatch(job, GITHUB_TOKEN_REFERENCE, 0, new Set(), onDepth)) fails.push('scanner job references github.token and would expose it to the scan');
}

function checkCheckout(job, jobId, fails, unknowns) {
  const checkouts = stepsOf(job).filter((step) => typeof step.uses === 'string' && CHECKOUT.test(step.uses));
  if (checkouts.length === 0) { unknowns.push(`scanner job "${jobId}" has no actions/checkout step; credential persistence cannot be proven`); return; }
  for (const checkout of checkouts) {
    const persist = isMapping(checkout.with) ? checkout.with['persist-credentials'] : undefined;
    if (typeof persist === 'string' && EXPRESSION.test(persist)) {
      unknowns.push(`actions/checkout persist-credentials in job "${jobId}" depends on an unresolved expression`);
    } else if (persist !== false && persist !== 'false') {
      fails.push(`actions/checkout in job "${jobId}" must set persist-credentials: false (actions/checkout defaults to true)`);
    }
  }
}

function checkActionPin(uses, approvedSha, fails, unknowns) {
  const { ref } = splitUses(uses);
  if (ref === null || ref.length === 0) fails.push('scan step must pin the approved Action commit, not omit the ref');
  else if (!FULL_SHA.test(ref)) fails.push(`scan step uses the mutable ref "${ref}"; only the approved full 40-hex commit is allowed`);
  else if (approvedSha === '') unknowns.push('approved Action commit was not supplied; a well-formed SHA is not approval by itself');
  else if (ref !== approvedSha) fails.push(`scan step pins ${ref} but the approved Action commit is ${approvedSha}`);
}

function checkSarif(jobs, jobIds, workflow, scannerJobId, fails, unknowns) {
  const scannerIndex = jobIds.indexOf(scannerJobId);
  for (const jobId of jobIds) {
    const job = jobs[jobId];
    if (!isMapping(job)) continue;
    if (!stepsOf(job).some((step) => typeof step.uses === 'string' && SARIF_UPLOAD.test(step.uses))) continue;
    if (jobId === scannerJobId) {
      fails.push('the scanner job must not run github/codeql-action/upload-sarif; SARIF upload belongs in a separate subsequent job');
      continue;
    }
    if (jobIds.indexOf(jobId) < scannerIndex) fails.push(`SARIF upload job "${jobId}" must come after the scanner job "${scannerJobId}"`);
    const permissions = jobPermissions(workflow, job);
    if (permissions === undefined) { unknowns.push(`SARIF job "${jobId}" has no explicit permissions; security-events: write cannot be proven`); continue; }
    const entries = permissionEntries(permissions, `SARIF job "${jobId}"`, fails, unknowns);
    if (!entries) continue;
    if (permissions['security-events'] !== 'write') fails.push(`SARIF job "${jobId}" must grant security-events: write`);
    const extraWrites = entries.filter(([scope, level]) => scope !== 'security-events' && level === 'write').map(([scope]) => scope);
    if (extraWrites.length > 0) fails.push(`SARIF job "${jobId}" grants write beyond security-events: ${extraWrites.join(', ')}`);
  }
}

function findScanInvocations(jobs, jobIds, actionPath, unknowns) {
  const invocations = [];
  for (const jobId of jobIds) {
    const job = jobs[jobId];
    if (!isMapping(job)) { unknowns.push(`job "${jobId}" is not a mapping; caller policy cannot be proven`); continue; }
    if (typeof job.uses === 'string') unknowns.push(`job "${jobId}" delegates to a reusable workflow; caller policy cannot be proven`);
    for (const step of stepsOf(job)) {
      if (typeof step.uses !== 'string') continue;
      if (EXPRESSION.test(step.uses)) { unknowns.push(`job "${jobId}" has a step whose uses depends on an unresolved expression`); continue; }
      const target = splitUses(step.uses).target;
      if (actionPath ? target === actionPath : APPROVED_ACTION_PATHS.has(target)) invocations.push({ jobId, job, step, uses: step.uses });
    }
  }
  return invocations;
}

function finalize(fails, unknowns) {
  if (fails.length > 0) return { status: 'FAIL', reasons: [...new Set([...fails, ...unknowns])] };
  if (unknowns.length > 0) return { status: 'UNKNOWN', reasons: [...new Set(unknowns)] };
  return { status: 'PASS', reasons: [PASS_REASON] };
}

/**
 * @param {string|object} workflowYamlOrParsed YAML text or parsed workflow mapping.
 * @param {{approvedActionSha?: string, actionPath?: string}} [options]
 * @returns {{status: 'PASS'|'FAIL'|'UNKNOWN', reasons: string[]}}
 */
export function validateCallerPolicy(workflowYamlOrParsed, options = {}) {
  const fails = [];
  const unknowns = [];
  const parsed = parseWorkflow(workflowYamlOrParsed);
  if (!parsed.ok) return { status: 'UNKNOWN', reasons: [parsed.reason] };
  if (!isMapping(parsed.value)) return { status: 'UNKNOWN', reasons: ['workflow document is not a mapping; caller policy cannot be proven'] };
  const workflow = parsed.value;
  const actionPath = typeof options.actionPath === 'string' && options.actionPath.trim() !== '' ? normalizeActionPath(options.actionPath) : undefined;
  const rawApproved = typeof options.approvedActionSha === 'string' ? options.approvedActionSha.trim().toLowerCase() : '';
  const approvedSha = FULL_SHA.test(rawApproved) ? rawApproved : '';

  checkTrigger(workflow, fails, unknowns);
  const jobs = workflow.jobs;
  if (!isMapping(jobs) || Object.keys(jobs).length === 0) {
    unknowns.push('workflow has no jobs mapping; caller policy cannot be proven');
    return finalize(fails, unknowns);
  }
  const jobIds = Object.keys(jobs);
  const invocations = findScanInvocations(jobs, jobIds, actionPath, unknowns);
  if (invocations.length === 0) {
    unknowns.push(`no job invokes ${actionPath ?? DEFAULT_ACTION_PATH}; caller policy cannot be proven`);
    return finalize(fails, unknowns);
  }
  if (invocations.length > 1) {
    fails.push(`approved scan action is invoked ${invocations.length} times; expected exactly one scanner job`);
    return finalize(fails, unknowns);
  }
  const { jobId, job, step, uses } = invocations[0];
  checkScannerPermissions(workflow, job, fails, unknowns);
  checkScannerIsolation(job, jobId, step, fails, unknowns);
  checkCheckout(job, jobId, fails, unknowns);
  checkActionPin(uses, approvedSha, fails, unknowns);
  checkSarif(jobs, jobIds, workflow, jobId, fails, unknowns);
  return finalize(fails, unknowns);
}

function parseCliArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--workflow', '--action-sha'].includes(argv[index]) || argv[index + 1] === undefined) {
      throw new Error('expected --workflow <path> --action-sha <40-hex>');
    }
    args[argv[index].slice(2)] = argv[index + 1];
  }
  return args;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirect = invoked !== '' && (process.platform === 'win32' ? invoked.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() : invoked === fileURLToPath(import.meta.url));
if (isDirect) {
  let code = 2;
  try {
    const args = parseCliArgs(process.argv.slice(2));
    if (!args.workflow || !args['action-sha']) throw new Error('missing --workflow or --action-sha');
    const verdict = validateCallerPolicy(fs.readFileSync(path.resolve(args.workflow), 'utf8'), { approvedActionSha: args['action-sha'] });
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    code = verdict.status === 'PASS' ? 0 : verdict.status === 'FAIL' ? 1 : 2;
  } catch (error) { process.stderr.write(`validate-caller-policy: ${error.message}\n`); }
  process.exitCode = code;
}
