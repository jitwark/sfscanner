import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  APPROVED_FIXTURE_PATH, BINDING_RECEIPT_SCHEMA, REQUIRED_SEARCH_ARTIFACTS,
  canonicalJson, cohortSha256, digest, fail, readRelevanceFixture, receiptValue,
  semanticFieldDiff, sha256, transactionValue,
} from './search-release-contract.mjs';
import {
  deriveSearchRelease, helperSourceIdentity, readDataIdentity, resolveSearchReleasePaths, validateJudgments,
} from './search-release-data.mjs';

export { APPROVED_FIXTURE_PATH, BINDING_RECEIPT_SCHEMA, REQUIRED_SEARCH_ARTIFACTS, cohortSha256, semanticFieldDiff };
export { deriveSearchRelease } from './search-release-data.mjs';

function json(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(`${label} is not valid JSON`); }
}

function fixture(bytes, label) {
  return readRelevanceFixture(json(bytes, label));
}

export function atomicWrite(file, bytes) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

function atomicCreate(file, bytes) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

const frozenTransaction = (transaction) => transactionValue(transaction);

function generatedFixture(baseline, release) {
  const generated = structuredClone(baseline);
  generated.release = release;
  for (const item of generated.cases) for (const judgment of item.expected) judgment.releaseId = release.releaseId;
  return generated;
}

export function bindSearchRelease({
  candidateRoot, baselineCandidateRoot, receiptPath, receiptRoot, expectedFixtureSha256,
  expectedCohortSha256, expectedBaselineDataIdentity, transaction, atomicWriter = atomicWrite,
}) {
  const paths = resolveSearchReleasePaths({ candidateRoot, baselineCandidateRoot, receiptPath, receiptRoot });
  digest(expectedFixtureSha256, 'expectedFixtureSha256');
  digest(expectedCohortSha256, 'expectedCohortSha256');
  const tx = frozenTransaction(transaction);
  if (existsSync(paths.receipt)) fail('receipt already exists');
  const originalBytes = readFileSync(paths.candidateFixture);
  const baselineBytes = readFileSync(paths.baselineFixture);
  if (sha256(originalBytes) !== expectedFixtureSha256) fail('fixture bytes do not match the pinned hash');
  if (sha256(baselineBytes) !== expectedFixtureSha256) fail('baseline fixture bytes do not match the pinned hash');
  const baseline = fixture(originalBytes, 'fixture');
  const frozenBaseline = fixture(baselineBytes, 'baseline fixture');
  if (cohortSha256(baseline) !== expectedCohortSha256 || cohortSha256(frozenBaseline) !== expectedCohortSha256) {
    fail('fixture cohort does not match the pinned digest');
  }
  const baselineDataIdentity = readDataIdentity(paths.baseline, 'baseline data');
  if (expectedBaselineDataIdentity === undefined) fail('expectedBaselineDataIdentity is required');
  if (canonicalJson(expectedBaselineDataIdentity) !== canonicalJson(baselineDataIdentity)) {
    fail('baseline data identity does not match the pinned identity');
  }
  const derived = deriveSearchRelease({ candidateRoot: paths.candidate });
  validateJudgments(baseline, derived);
  const generated = generatedFixture(baseline, derived.release);
  const generatedBytes = Buffer.from(`${JSON.stringify(generated, null, 2)}\n`);
  const fieldDiff = semanticFieldDiff(baseline, generated);
  const receipt = {
    schemaVersion: BINDING_RECEIPT_SCHEMA,
    approvedPaths: [APPROVED_FIXTURE_PATH],
    helper: helperSourceIdentity(),
    transaction: tx,
    baseline: {
      fixtureSha256: sha256(baselineBytes), cohortSha256: expectedCohortSha256, dataIdentity: baselineDataIdentity,
    },
    generated: {
      fixtureSha256: sha256(generatedBytes), cohortSha256: cohortSha256(generated),
      release: derived.release, dataIdentity: derived.dataIdentity,
    },
    fieldDiff,
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  atomicWriter(paths.candidateFixture, generatedBytes);
  try {
    (atomicWriter === atomicWrite ? atomicCreate : atomicWriter)(paths.receipt, receiptBytes);
  } catch (error) {
    if (sha256(readFileSync(paths.candidateFixture)) === sha256(generatedBytes)) {
      try { atomicWrite(paths.candidateFixture, originalBytes); }
      catch (restoreError) {
        throw new AggregateError([error, restoreError], 'receipt publication failed and owned fixture restoration failed');
      }
    } else {
      throw new AggregateError([error, new Error('fixture changed concurrently; owned rollback was not performed')], 'receipt publication failed');
    }
    try {
      if (existsSync(paths.receipt) && sha256(readFileSync(paths.receipt)) === sha256(receiptBytes)) rmSync(paths.receipt);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'receipt publication failed and owned receipt cleanup failed');
    }
    throw error;
  }
  return receipt;
}

export function verifySearchReleaseReceipt({ candidateRoot, baselineCandidateRoot, receiptPath, receiptRoot, transaction }) {
  const paths = resolveSearchReleasePaths({ candidateRoot, baselineCandidateRoot, receiptPath, receiptRoot });
  const receiptBytes = readFileSync(paths.receipt);
  const receipt = receiptValue(json(receiptBytes, 'receipt'));
  if (canonicalJson(receipt.transaction) !== canonicalJson(frozenTransaction(transaction))) fail('receipt belongs to another transaction attempt');
  if (canonicalJson(receipt.helper) !== canonicalJson(helperSourceIdentity())) fail('receipt helper identity is stale');
  const currentBytes = readFileSync(paths.candidateFixture);
  const baselineBytes = readFileSync(paths.baselineFixture);
  if (sha256(currentBytes) !== receipt.generated.fixtureSha256) fail('fixture no longer matches the generated receipt');
  if (sha256(baselineBytes) !== receipt.baseline.fixtureSha256) fail('baseline fixture no longer matches the receipt');
  const current = fixture(currentBytes, 'fixture');
  const baseline = fixture(baselineBytes, 'baseline fixture');
  if (cohortSha256(current) !== receipt.generated.cohortSha256 || cohortSha256(baseline) !== receipt.baseline.cohortSha256) fail('receipt cohort identity is stale');
  const baselineDataIdentity = readDataIdentity(paths.baseline, 'baseline data');
  const generatedDataIdentity = readDataIdentity(paths.candidate, 'generated data');
  if (canonicalJson(baselineDataIdentity) !== canonicalJson(receipt.baseline.dataIdentity)) fail('baseline full-tree identity is stale');
  if (canonicalJson(generatedDataIdentity) !== canonicalJson(receipt.generated.dataIdentity)) fail('generated full-tree identity is stale');
  const derived = deriveSearchRelease({ candidateRoot: paths.candidate });
  validateJudgments(current, derived);
  if (canonicalJson(current.release) !== canonicalJson(receipt.generated.release) || canonicalJson(derived.release) !== canonicalJson(receipt.generated.release)) fail('receipt or fixture release is stale');
  if (canonicalJson(semanticFieldDiff(baseline, current)) !== canonicalJson(receipt.fieldDiff)) fail('receipt semantic field diff is stale');
  return { receipt, receiptSha256: sha256(receiptBytes), release: derived.release, fixture: current, dataIdentity: generatedDataIdentity, paths };
}
