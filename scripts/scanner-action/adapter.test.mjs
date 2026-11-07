import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildArtifactSnapshot, buildSourceSnapshot, inspectCheckedSource, verifyArtifacts, verifyCheckedSource } from './adapter.mjs';
import { collectArtifactEntries, hashRegularFile } from './artifact-digest.mjs';
import { artifactSetSha256, sha256Bytes } from './release-contract.mjs';

const REPOSITORY = 'jitwark/sfscanner';
const roots = [];
const releaseFixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'receipt-vectors.json'), 'utf8'));
const actionModules = ['adapter.mjs', 'artifact-digest.mjs', 'preflight.mjs', 'release-contract.mjs'];

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function sourceCheckout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'action-adapter-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'packages/scanner-cli/dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(root, 'packages/scanner-cli/package.json'), '{"name":"sfscanner","version":"0.2.1"}\n');
  fs.writeFileSync(path.join(root, 'packages/scanner-cli/dist/index.js'), 'index\n');
  fs.writeFileSync(path.join(root, 'packages/scanner-cli/dist/main.js'), 'main\n');
  fs.writeFileSync(path.join(root, 'packages/scanner-cli/dist/scan-worker.js'), 'worker\n');
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Action Test']);
  git(root, ['remote', 'add', 'origin', `https://github.com/${REPOSITORY}.git`]);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
}

function receiptFor(root) {
  const ref = git(root, ['rev-parse', 'HEAD']);
  const source = inspectCheckedSource(root, REPOSITORY, ref);
  if (!source.ok) throw new Error(source.code);
  const artifacts = collectArtifactEntries(root);
  const lockfile = hashRegularFile(path.join(root, 'package-lock.json'), 'package-lock.json');
  return {
    schemaVersion: 'secureflow-action-release-receipt-v1',
    status: 'ACCEPTED',
    releaseId: 'adapter-fixture-v1',
    scannerRepository: REPOSITORY,
    scannerRef: ref,
    sourceTreeSha256: source.sourceTreeSha256,
    lockfileSha256: lockfile.sha256,
    package: { name: 'sfscanner', version: '0.2.1', tarballSha256: '1'.repeat(64) },
    artifacts: artifacts.artifacts,
    artifactSetSha256: artifactSetSha256(artifacts.artifacts),
  };
}

function writeReceipt(receipt) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'action-receipt-'));
  roots.push(root);
  const file = path.join(root, 'receipt.json');
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  fs.writeFileSync(file, bytes);
  return { file, sha256: sha256Bytes(bytes) };
}

function copiedActionBundle({ status, receipt } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'action-bundle-'));
  roots.push(root);
  for (const file of actionModules) fs.copyFileSync(path.join(import.meta.dirname, file), path.join(root, file));
  const policy = { ...releaseFixture.policy, status, releaseReceiptSha256: null };
  if (status === 'ACCEPTED') {
    const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(root, 'release-receipt.json'), bytes);
    policy.releaseReceiptSha256 = sha256Bytes(bytes);
  }
  fs.writeFileSync(path.join(root, 'release-policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
  return { adapterPath: path.join(root, 'adapter.mjs') };
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('checked-source adapter', () => {
  it('excludes the self-referential Action policy and receipt from the scanner source-tree digest', () => {
    const root = sourceCheckout();
    const trustDir = path.join(root, 'scripts/scanner-action');
    fs.mkdirSync(trustDir, { recursive: true });
    fs.writeFileSync(path.join(trustDir, 'release-policy.json'), '{"status":"pending"}\n');
    fs.writeFileSync(path.join(trustDir, 'release-receipt.json'), '{"release":1}\n');
    git(root, ['add', '.']);
    git(root, ['commit', '--quiet', '-m', 'trust one']);
    const first = inspectCheckedSource(root, REPOSITORY, git(root, ['rev-parse', 'HEAD']));
    fs.writeFileSync(path.join(trustDir, 'release-policy.json'), '{"status":"accepted","receiptSha256":"x"}\n');
    fs.writeFileSync(path.join(trustDir, 'release-receipt.json'), '{"release":2}\n');
    git(root, ['add', '.']);
    git(root, ['commit', '--quiet', '-m', 'trust two']);
    const second = inspectCheckedSource(root, REPOSITORY, git(root, ['rev-parse', 'HEAD']));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.sourceTreeSha256).toBe(first.sourceTreeSha256);
  });

  it('exports deterministic source and artifact snapshot fields for receipt construction', () => {
    const root = sourceCheckout();
    const ref = git(root, ['rev-parse', 'HEAD']);
    const source = buildSourceSnapshot(root, REPOSITORY, ref);
    const artifacts = buildArtifactSnapshot(root);
    expect(source).toMatchObject({ ok: true, source: { repository: REPOSITORY, ref }, package: { name: 'sfscanner', version: '0.2.1' } });
    expect(artifacts).toMatchObject({ ok: true, artifactSetSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(artifacts.artifacts).toHaveLength(3);
  });

  it('binds repository, exact commit, clean tree, index and lockfile', () => {
    const root = sourceCheckout();
    const receipt = receiptFor(root);
    const stored = writeReceipt(receipt);
    const result = verifyCheckedSource({ sourceRoot: root, receiptPath: stored.file, receiptSha256: stored.sha256, repository: REPOSITORY, ref: receipt.scannerRef });
    expect(result).toMatchObject({ ok: true, status: 'SOURCE_VERIFIED', sourceTreeSha256: receipt.sourceTreeSha256, lockfileSha256: receipt.lockfileSha256 });
  });

  it('refuses dirty, untracked, wrong-commit and wrong-repository checkouts', () => {
    const root = sourceCheckout();
    const receipt = receiptFor(root);
    const stored = writeReceipt(receipt);
    fs.appendFileSync(path.join(root, 'package-lock.json'), ' ');
    expect(verifyCheckedSource({ sourceRoot: root, receiptPath: stored.file, receiptSha256: stored.sha256, repository: REPOSITORY, ref: receipt.scannerRef })).toMatchObject({ ok: false, code: 'SOURCE_TREE_DIRTY' });
    expect(inspectCheckedSource(root, REPOSITORY, 'f'.repeat(40))).toMatchObject({ ok: false, code: 'SOURCE_REF_MISMATCH' });
    expect(inspectCheckedSource(root, 'other/scanner', receipt.scannerRef)).toMatchObject({ ok: false, code: 'SOURCE_REPOSITORY_MISMATCH' });

    const second = sourceCheckout();
    const secondReceipt = receiptFor(second);
    writeReceipt(secondReceipt);
    fs.writeFileSync(path.join(second, 'untracked.js'), 'untracked\n');
    expect(inspectCheckedSource(second, REPOSITORY, secondReceipt.scannerRef)).toMatchObject({ ok: false, code: 'SOURCE_UNTRACKED_FILES_PRESENT' });
  });

  it('refuses source entries whose Git mode is not a regular file', () => {
    const root = sourceCheckout();
    const link = path.join(root, 'link.js');
    fs.writeFileSync(link, 'packages/scanner-cli/dist/main.js\n');
    const objectId = git(root, ['hash-object', '-w', 'link.js']);
    git(root, ['update-index', '--add', '--cacheinfo', `120000,${objectId},link.js`]);
    git(root, ['commit', '--quiet', '-m', 'symlink mode fixture']);
    const result = inspectCheckedSource(root, REPOSITORY, git(root, ['rev-parse', 'HEAD']));
    expect(result).toMatchObject({ ok: false, code: 'GIT_ENTRY_MODE_REFUSED', detail: 'link.js' });
  });

  it('refuses receipt digests swapped after preflight', () => {
    const root = sourceCheckout();
    const receipt = receiptFor(root);
    const stored = writeReceipt(receipt);
    const result = verifyCheckedSource({ sourceRoot: root, receiptPath: stored.file, receiptSha256: '0'.repeat(64), repository: REPOSITORY, ref: receipt.scannerRef });
    expect(result).toMatchObject({ ok: false, code: 'RELEASE_RECEIPT_DIGEST_MISMATCH' });
  });

  it('refuses a trusted receipt whose package identity differs from checked source', () => {
    const root = sourceCheckout();
    const receipt = receiptFor(root);
    receipt.package.version = '9.9.9';
    const stored = writeReceipt(receipt);
    const result = verifyCheckedSource({ sourceRoot: root, receiptPath: stored.file, receiptSha256: stored.sha256, repository: REPOSITORY, ref: receipt.scannerRef });
    expect(result).toMatchObject({ ok: false, code: 'PACKAGE_IDENTITY_MISMATCH' });
  });
});

describe('built-artifact adapter', () => {
  it('accepts only the exact receipt-listed artifact tree', () => {
    const root = sourceCheckout();
    const receipt = receiptFor(root);
    const stored = writeReceipt(receipt);
    expect(verifyArtifacts({ sourceRoot: root, receiptPath: stored.file, receiptSha256: stored.sha256 })).toMatchObject({ ok: true, status: 'ARTIFACTS_VERIFIED', artifactCount: 3 });
    fs.writeFileSync(path.join(root, 'packages/scanner-cli/dist/main.js'), 'MAIN\n');
    expect(verifyArtifacts({ sourceRoot: root, receiptPath: stored.file, receiptSha256: stored.sha256 })).toMatchObject({ ok: false, code: 'ARTIFACT_DIGEST_MISMATCH' });
  });

  it('refuses an extra executable after the build', () => {
    const root = sourceCheckout();
    const receipt = receiptFor(root);
    const stored = writeReceipt(receipt);
    fs.writeFileSync(path.join(root, 'packages/scanner-cli/dist/extra.exe'), 'unexpected\n');
    expect(verifyArtifacts({ sourceRoot: root, receiptPath: stored.file, receiptSha256: stored.sha256 })).toMatchObject({ ok: false, code: 'ARTIFACT_SET_SIZE_MISMATCH' });
  });

  it('refuses caller-selected receipt authority while the bundled policy is pending', () => {
    const root = sourceCheckout();
    const receipt = receiptFor(root);
    const stored = writeReceipt(receipt);
    const bundle = copiedActionBundle({ status: 'PENDING_FINAL_CANDIDATE' });
    for (const argv of [
      ['source', '--source-root', root, '--receipt', stored.file, '--receipt-sha256', stored.sha256, '--repository', REPOSITORY, '--ref', receipt.scannerRef],
      ['artifacts', '--source-root', root, '--receipt', stored.file, '--receipt-sha256', stored.sha256],
    ]) {
      const result = spawnSync(process.execPath, [bundle.adapterPath, ...argv], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: 'FINAL_RELEASE_RECEIPT_NOT_CONFIGURED' });
    }
  });

  it('refuses caller-selected receipt authority while the bundled policy is accepted', () => {
    const root = sourceCheckout();
    const receipt = receiptFor(root);
    const stored = writeReceipt(receipt);
    const bundle = copiedActionBundle({ status: 'ACCEPTED', receipt });
    for (const argv of [
      ['source', '--source-root', root, '--receipt', stored.file, '--receipt-sha256', stored.sha256, '--repository', REPOSITORY, '--ref', receipt.scannerRef],
      ['artifacts', '--source-root', root, '--receipt', stored.file, '--receipt-sha256', stored.sha256],
    ]) {
      const result = spawnSync(process.execPath, [bundle.adapterPath, ...argv], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: 'ACTION_AUTHORITY_MISMATCH' });
    }
  });
});
