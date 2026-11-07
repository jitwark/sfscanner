import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, safePath, sha, sourceIdentity } from './maintenance-identity.mjs';
import {
  APPROVED_FIXTURE_PATH, HELPER_PATHS, cohortSha256, readRelevanceFixture, sha256,
} from './search-release-contract.mjs';
import { bindSearchRelease, verifySearchReleaseReceipt } from './search-release-binding.mjs';

export const MODULE_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const SEARCH_BINDING_ALLOWED_FIXTURE = APPROVED_FIXTURE_PATH;
export const SEARCH_BINDING_COHORT_SHA256 = 'e459d1384a3e3ca3513dcd220e672a35fa6d4a4238fc9200ef4d7032eed945be';
export const SEARCH_BINDING_RECEIPT_NAME = 'receipt.json';
export const SEARCH_BINDING_STEP_ID = 'bind-search-release';
const HANDLER = 'maintenance-search-binding-v1';
const HELPER_TEST = 'scripts/lib/search-release-binding.test.mjs';
const ACCEPTED_HELPERS = Object.freeze([
  ['scripts/lib/search-release-binding.mjs', 'fad96038947847ae2cd71765c5fe68cfd81d2b163c803c6eda3dcec81ff469ff'],
  ['scripts/lib/search-release-contract.mjs', '42e5ef940abc5f9394c4962f740d6182f18401a75a258d4edf36b47e5ad113c2'],
  ['scripts/lib/search-release-data.mjs', '4327d711bf1bd88cf58b1a2520f27cbeb405d2494ad6a51bd9dc886c7fbfcb0e'],
  ['scripts/lib/search-release-rollback.mjs', '9a10d2e50ff0615d3803b421a755401676759b8ae794240a9d0b2e90db901005'],
  ['scripts/lib/search-release-index.mjs', '81c559b45f2996d5223aa335a98c95a2de675a24c10ab52feace08deb6b69045'],
  [HELPER_TEST, 'f85b654942ab257dc3db65f4d2e67e7f1544601903399d0b8fc9dc0e3075119d'],
].map(([relative, expected]) => ({ path: relative, sha256: expected })));

const fail = (message) => { throw new Error(`maintenance search binding refused: ${message}`); };
const samePath = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right;

function pathRows(identity) {
  return identity.files.map(({ path: file, sha256: digest }) => ({ path: file, sha256: digest }));
}

function withoutFixture(identity) {
  return pathRows(identity).filter((row) => row.path !== SEARCH_BINDING_ALLOWED_FIXTURE);
}

export function helperClosureIdentity(root = MODULE_ROOT) {
  const safeRoot = safePath(root, 'helper source root', { kind: 'directory' });
  return [...HELPER_PATHS, HELPER_TEST].map((relative) => ({
    path: relative, sha256: sha256(readFileSync(safePath(path.join(safeRoot, relative), `helper ${relative}`, { kind: 'file' }))),
  }));
}

export function assertHelperClosure(root = MODULE_ROOT) {
  const actual = helperClosureIdentity(root);
  if (canonical(actual) !== canonical(ACCEPTED_HELPERS)) fail('accepted helper-source inventory drifted');
  return actual;
}

export function createMaintenanceSearchBinding({ sourceRoot, candidateRoot, runDir, runId, baselineDataIdentity }) {
  const baseline = safePath(sourceRoot, 'baseline candidate root', { kind: 'directory' });
  const candidate = safePath(candidateRoot, 'mutable candidate root', { kind: 'directory' });
  const ownedRun = safePath(runDir, 'maintenance run root', { missing: true });
  if (samePath(baseline, candidate)) fail('baseline and candidate roots must be distinct');
  assertHelperClosure(baseline); assertHelperClosure(candidate);
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(runId)) fail('runId is invalid');
  const fixtureBytes = readFileSync(safePath(path.join(baseline, SEARCH_BINDING_ALLOWED_FIXTURE), 'baseline relevance fixture', { kind: 'file' }));
  const fixture = readRelevanceFixture(JSON.parse(fixtureBytes.toString('utf8')));
  if (cohortSha256(fixture) !== SEARCH_BINDING_COHORT_SHA256) fail('baseline fixture does not match the immutable cohort');
  const receiptRoot = path.join(ownedRun, 'search-release-binding');
  const receiptPath = path.join(receiptRoot, SEARCH_BINDING_RECEIPT_NAME);
  return {
    operation: 'bind-search-release-v2', fixturePath: SEARCH_BINDING_ALLOWED_FIXTURE,
    expectedFixtureSha256: sha256(fixtureBytes), cohortSha256: SEARCH_BINDING_COHORT_SHA256,
    baselineRoot: baseline, candidateRoot: candidate, receiptRoot, receiptPath,
    expectedBaselineDataIdentity: structuredClone(baselineDataIdentity), helper: assertHelperClosure(),
    transaction: { id: `maintenance-${runId}`, attempt: 1 },
  };
}

function planBody(plan) {
  const body = structuredClone(plan); delete body.digest;
  delete body.bindings?.searchBinding?.transaction?.planSha256;
  return body;
}

function bindStep(plan) {
  const rows = plan.steps?.filter((step) => step.id === SEARCH_BINDING_STEP_ID) ?? [];
  if (rows.length !== 1) fail('plan must contain exactly one bind-search-release step');
  const step = rows[0];
  if (step.handler !== HANDLER || step.internal !== true || canonical(step.argv) !== canonical([])) fail('bind step handler or argv is not fixed');
  const promote = plan.steps.findIndex((item) => item.id === 'promote');
  const bind = plan.steps.indexOf(step); const exportStep = plan.steps.findIndex((item) => item.id === 'export');
  if (promote < 0 || exportStep < 0 || bind !== promote + 1 || bind >= exportStep) fail('bind step order is invalid');
  return step;
}

export function sealMaintenancePlan(unsignedPlan) {
  if (!unsignedPlan?.bindings?.searchBinding || !Array.isArray(unsignedPlan.steps)) fail('unsigned plan lacks search binding');
  bindStep(unsignedPlan);
  const digest = sha(Buffer.from(canonical(planBody(unsignedPlan))));
  const sealed = structuredClone(unsignedPlan);
  sealed.bindings.searchBinding.transaction.planSha256 = digest; sealed.digest = digest;
  return sealed;
}

export function verifyMaintenancePlanLink(plan) {
  if (plan?.schemaVersion !== 'maintenance-plan-v2') fail('plan schema must be maintenance-plan-v2');
  const binding = plan.bindings?.searchBinding; bindStep(plan);
  if (binding.operation !== 'bind-search-release-v2' || binding.fixturePath !== SEARCH_BINDING_ALLOWED_FIXTURE) fail('search binding operation is invalid');
  if (binding.cohortSha256 !== SEARCH_BINDING_COHORT_SHA256 || binding.transaction?.attempt !== 1) fail('cohort or transaction attempt is invalid');
  if (binding.transaction.id !== `maintenance-${plan.request?.runId}` || binding.candidateRoot !== plan.request?.candidateRoot) fail('transaction identity is invalid');
  if (binding.receiptRoot !== path.join(plan.request.candidateRoot, '.work/maintenance', plan.request.runId, 'search-release-binding') ||
      binding.receiptPath !== path.join(binding.receiptRoot, SEARCH_BINDING_RECEIPT_NAME)) fail('receipt path is not the fixed owned path');
  if (canonical(binding.helper) !== canonical(ACCEPTED_HELPERS)) fail('helper inventory is not the accepted closure');
  const digest = sha(Buffer.from(canonical(planBody(plan))));
  if (digest !== plan.digest || binding.transaction.planSha256 !== plan.digest) fail('plan digest or transaction link drifted');
  return plan;
}

export function assertPreBindSource(plan) {
  const current = sourceIdentity(plan.request.candidateRoot);
  if (canonical(pathRows(current)) !== canonical(pathRows(plan.bindings.candidate))) fail('candidate source/config/lock inventory drifted before bind');
  if (canonical(pathRows(sourceIdentity(plan.bindings.searchBinding.baselineRoot))) !== canonical(pathRows(plan.bindings.source))) fail('immutable source/config/lock inventory drifted before bind');
  return current;
}

export function assertImmutableSourceGit(plan, current) {
  const expected = plan.bindings.sourceGit;
  if (!expected || !current.clean || current.root !== expected.root || current.head !== expected.head) fail('immutable source Git identity/HEAD or cleanliness drifted');
}

export function assertPostBindSource(plan, verification) {
  const binding = verification?.receipt;
  if (!binding?.generated || !binding?.helper) fail('verified binding state is missing');
  const source = sourceIdentity(plan.bindings.searchBinding.baselineRoot);
  if (canonical(pathRows(source)) !== canonical(pathRows(plan.bindings.source))) fail('immutable source workspace changed during the run');
  const current = sourceIdentity(plan.request.candidateRoot);
  if (canonical(withoutFixture(current)) !== canonical(withoutFixture(plan.bindings.candidate))) fail('candidate source inventory changed outside the approved fixture');
  const fixture = readFileSync(path.join(plan.request.candidateRoot, SEARCH_BINDING_ALLOWED_FIXTURE));
  if (sha256(fixture) !== binding.generated.fixtureSha256) fail('candidate fixture does not match the generated receipt');
  const planHelpers = plan.bindings.searchBinding.helper.slice(0, HELPER_PATHS.length);
  if (canonical(planHelpers) !== canonical(binding.helper)) fail('receipt helper inventory differs from the accepted plan');
  return { source: source.sha256, fixtureSha256: sha256(fixture), sourceFiles: current.fileCount };
}

export function bindMaintenanceSearchRelease(plan, bind = bindSearchRelease) {
  const item = plan.bindings.searchBinding;
  return bind({
    candidateRoot: item.candidateRoot, baselineCandidateRoot: item.baselineRoot,
    receiptPath: item.receiptPath, receiptRoot: item.receiptRoot,
    expectedFixtureSha256: item.expectedFixtureSha256, expectedCohortSha256: item.cohortSha256,
    expectedBaselineDataIdentity: item.expectedBaselineDataIdentity, transaction: item.transaction,
  });
}

export function verifyMaintenanceSearchRelease(plan, verify = verifySearchReleaseReceipt) {
  const item = plan.bindings.searchBinding;
  return verify({
    candidateRoot: item.candidateRoot, baselineCandidateRoot: item.baselineRoot,
    receiptPath: item.receiptPath, receiptRoot: item.receiptRoot, transaction: item.transaction,
  });
}

function normalizedPaths(paths) {
  if (!Array.isArray(paths)) fail('change paths must be an array');
  return [...new Set(paths.map((item) => {
    if (typeof item !== 'string' || !item || path.isAbsolute(item) || item.includes('\\') || item.endsWith('/') ||
        item.split('/').some((part) => part === '' || part === '.' || part === '..')) fail('change path is malformed');
    return item;
  }))].sort();
}

export function assertCandidateChangePaths(paths) {
  const values = normalizedPaths(paths);
  if (!values.some((item) => item.startsWith('data/'))) fail(`candidate must contain generated data under data/: ${values.join(', ') || '(clean)'}`);
  if (!values.includes(SEARCH_BINDING_ALLOWED_FIXTURE)) fail('candidate two-path allowlist requires the exact fixture');
  const rejected = values.filter((item) => !item.startsWith('data/') && item !== SEARCH_BINDING_ALLOWED_FIXTURE);
  if (rejected.length) fail(`candidate paths are outside the exact allowlist: ${rejected.join(', ')}`);
  return values;
}

export function assertExactDirtyStaged(dirtyPaths, stagedPaths) {
  const dirty = assertCandidateChangePaths(dirtyPaths); const staged = assertCandidateChangePaths(stagedPaths);
  if (canonical(dirty) !== canonical(staged)) fail('dirty and staged candidate paths are not equal');
  return { dirtyPaths: dirty, stagedPaths: staged };
}
