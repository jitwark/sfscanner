import { randomUUID } from 'node:crypto';
import {
  closeSync, copyFileSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { dataIdentity, safePath } from './maintenance-identity.mjs';
import { atomicWrite, verifySearchReleaseReceipt } from './search-release-binding.mjs';
import { APPROVED_FIXTURE_PATH, canonicalJson, fail, sha256, transactionValue } from './search-release-contract.mjs';
import { resolveSearchReleasePaths } from './search-release-data.mjs';

const JOURNAL_SCHEMA = 'search-release-rollback-journal-v1';
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function identity(pathname) {
  return dataIdentity(pathname);
}

function createJournal(file, journal) {
  let fd;
  try {
    fd = openSync(file, 'wx', 0o600);
    writeFileSync(fd, stableJson(journal));
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ownedIdentity(stage) {
  return identity(path.join(stage, 'owned'));
}

function fixtureHash(file) {
  return sha256(readFileSync(file));
}

function removeIfOwned(target, expected) {
  if (!existsSync(target)) fail(`owned installed target is missing before compensation: ${target}`);
  if (canonicalJson(identity(path.dirname(target))) !== canonicalJson(expected)) fail('compensation target is foreign; refusing to remove it');
  rmSync(target, { recursive: true, force: false });
}

function recoveryError(journalPath, stage, initial, errors) {
  const details = errors.map((error) => error.message).join('; ');
  return new AggregateError(
    [initial, ...errors],
    `search release binding refused: RECOVERY_REQUIRED; journal=${journalPath}; recovery=${stage}${details ? `; ${details}` : ''}`,
  );
}

export function rollbackSearchReleaseBinding({
  candidateRoot, baselineCandidateRoot, receiptPath, receiptRoot, transaction, faultInjector = () => {},
}) {
  const paths = resolveSearchReleasePaths({ candidateRoot, baselineCandidateRoot, receiptPath, receiptRoot });
  const tx = transactionValue(transaction);
  const journalPath = safePath(path.join(paths.receiptRoot, `search-release-rollback-${tx.id}.json`),
    'rollback journal', { missing: true });
  const journalRelative = path.relative(paths.receiptRoot, journalPath);
  if (!journalRelative || journalRelative.startsWith('..') || path.isAbsolute(journalRelative)) {
    fail('rollback journal escapes the receipt root');
  }
  if (existsSync(journalPath)) fail(`RECOVERY_REQUIRED; rollback journal already exists at ${journalPath}`);
  const verified = verifySearchReleaseReceipt({ candidateRoot: paths.candidate, baselineCandidateRoot: paths.baseline, receiptPath: paths.receipt, receiptRoot: paths.receiptRoot, transaction: tx });
  const operation = (name, action) => {
    const event = { operation: name, state: 'started' };
    journal.operations.push(event); journal.phase = name;
    atomicWrite(journalPath, Buffer.from(stableJson(journal)));
    faultInjector(name, 'before');
    action();
    event.state = 'completed'; journal.phase = `${name}:completed`;
    atomicWrite(journalPath, Buffer.from(stableJson(journal)));
    faultInjector(name, 'after');
  };
  const stage = safePath(path.join(paths.candidate, `.search-release-recovery-${tx.id}-${randomUUID()}`),
    'rollback recovery stage', { missing: true });
  const stageRelative = path.relative(paths.candidate, stage);
  if (!stageRelative || stageRelative.startsWith('..') || path.isAbsolute(stageRelative)) {
    fail('rollback recovery stage escapes the candidate root');
  }
  const staged = path.join(stage, 'staged');
  const owned = path.join(stage, 'owned');
  mkdirSync(staged, { recursive: true }); mkdirSync(owned, { recursive: true });
  cpSync(paths.baselineData, path.join(staged, 'data'), { recursive: true, errorOnExist: true, force: false });
  copyFileSync(paths.baselineFixture, path.join(staged, 'fixture'));
  if (canonicalJson(identity(staged)) !== canonicalJson(verified.receipt.baseline.dataIdentity) ||
      fixtureHash(path.join(staged, 'fixture')) !== verified.receipt.baseline.fixtureSha256) {
    rmSync(stage, { recursive: true, force: true }); fail('staged baseline pair failed verification');
  }
  const journal = {
    schemaVersion: JOURNAL_SCHEMA, transaction: verified.receipt.transaction, receiptSha256: verified.receiptSha256,
    candidateRoot: paths.candidate, baselineRoot: paths.baseline, receiptPath: paths.receipt, journalPath,
    baseline: verified.receipt.baseline, generated: verified.receipt.generated,
    staged: { data: path.join(staged, 'data'), fixture: path.join(staged, 'fixture') },
    owned: { data: path.join(owned, 'data'), fixture: path.join(owned, 'fixture') },
    installed: { data: paths.candidateData, fixture: paths.candidateFixture },
    recoveryPath: stage, phase: 'prepared', status: 'started', operations: [], compensationErrors: [],
  };
  createJournal(journalPath, journal);
  const flags = { dataMoved: false, dataInstalled: false, fixtureMoved: false, fixtureInstalled: false };
  try {
    verifySearchReleaseReceipt({ candidateRoot: paths.candidate, baselineCandidateRoot: paths.baseline, receiptPath: paths.receipt, receiptRoot: paths.receiptRoot, transaction });
    operation('move-data', () => { renameSync(paths.candidateData, path.join(owned, 'data')); flags.dataMoved = true; });
    operation('install-data', () => { renameSync(path.join(staged, 'data'), paths.candidateData); flags.dataInstalled = true; });
    operation('move-fixture', () => { renameSync(paths.candidateFixture, path.join(owned, 'fixture')); flags.fixtureMoved = true; });
    operation('install-fixture', () => { renameSync(path.join(staged, 'fixture'), paths.candidateFixture); flags.fixtureInstalled = true; });
    faultInjector('verify-restored', 'before');
    if (canonicalJson(identity(paths.candidate)) !== canonicalJson(verified.receipt.baseline.dataIdentity) ||
        fixtureHash(paths.candidateFixture) !== verified.receipt.baseline.fixtureSha256) fail('restored baseline pair failed verification');
    journal.phase = 'verified-restored';
    atomicWrite(journalPath, Buffer.from(stableJson(journal)));
    faultInjector('verify-restored', 'after');
    journal.status = 'rolled-back'; journal.phase = 'complete';
    atomicWrite(journalPath, Buffer.from(stableJson(journal)));
    rmSync(stage, { recursive: true, force: true });
    return { status: 'rolled-back', journalPath, recoveryPath: stage, baseline: verified.receipt.baseline };
  } catch (initial) {
    const compensationErrors = [];
    const compensate = (name, action) => {
      const event = { operation: `compensate-${name}`, state: 'started' };
      try {
        journal.operations.push(event); atomicWrite(journalPath, Buffer.from(stableJson(journal)));
        faultInjector(`compensate-${name}`, 'before'); action(); faultInjector(`compensate-${name}`, 'after');
        event.state = 'completed'; atomicWrite(journalPath, Buffer.from(stableJson(journal)));
      } catch (error) { compensationErrors.push({ operation: `compensate-${name}`, message: error.message }); }
    };
    compensate('fixture', () => {
      if (flags.fixtureMoved) {
        if (flags.fixtureInstalled) {
          if (!existsSync(paths.candidateFixture) || fixtureHash(paths.candidateFixture) !== verified.receipt.baseline.fixtureSha256) fail('foreign fixture replaced the owned target');
          rmSync(paths.candidateFixture, { force: false });
        }
        if (existsSync(paths.candidateFixture)) fail('foreign fixture blocks owned restoration');
        if (!existsSync(path.join(owned, 'fixture')) || fixtureHash(path.join(owned, 'fixture')) !== verified.receipt.generated.fixtureSha256) fail('owned fixture recovery copy is missing');
        renameSync(path.join(owned, 'fixture'), paths.candidateFixture);
      }
    });
    if (!compensationErrors.length) compensate('data', () => {
      if (flags.dataMoved) {
        if (!existsSync(path.join(owned, 'data'))) fail(`owned data recovery copy is missing at ${path.join(owned, 'data')}`);
        if (flags.dataInstalled) removeIfOwned(paths.candidateData, verified.receipt.baseline.dataIdentity);
        if (existsSync(paths.candidateData)) fail('foreign data blocks owned restoration');
        if (!existsSync(path.join(owned, 'data')) || canonicalJson(ownedIdentity(stage)) !== canonicalJson(verified.receipt.generated.dataIdentity)) fail('owned data recovery copy is missing');
        renameSync(path.join(owned, 'data'), paths.candidateData);
      }
    });
    const restored = !compensationErrors.length && fixtureHash(paths.candidateFixture) === verified.receipt.generated.fixtureSha256 &&
      canonicalJson(identity(paths.candidate)) === canonicalJson(verified.receipt.generated.dataIdentity);
    journal.compensationErrors = compensationErrors;
    if (restored) {
      journal.status = 'compensated'; journal.phase = 'compensated';
      atomicWrite(journalPath, Buffer.from(stableJson(journal)));
      rmSync(stage, { recursive: true, force: true });
    } else {
      journal.status = 'recovery-required'; journal.phase = 'recovery-required';
      atomicWrite(journalPath, Buffer.from(stableJson(journal)));
    }
    if (!restored) throw recoveryError(journalPath, stage, initial, compensationErrors);
    throw initial;
  }
}
