import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { artifactSetSha256, sha256Bytes } from './release-contract.mjs';
import { runPreflight, validateActionPreflight } from './preflight.mjs';

const here = import.meta.dirname;
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'receipt-vectors.json'), 'utf8'));
const scriptPath = path.join(here, 'preflight.mjs');
const actionPath = path.resolve(here, '../../.github/actions/scan/action.yml');
const temporary = [];

function makeCase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'action-preflight-'));
  temporary.push(root);
  const receipt = structuredClone(fixture.receipt);
  receipt.artifactSetSha256 = artifactSetSha256(receipt.artifacts);
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  const receiptSha256 = sha256Bytes(receiptBytes);
  const policy = { ...fixture.policy, releaseReceiptSha256: receiptSha256 };
  const policyPath = path.join(root, 'release-policy.json');
  const receiptPath = path.join(root, 'release-receipt.json');
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  fs.writeFileSync(receiptPath, receiptBytes);
  return { root, receipt, receiptBytes, receiptSha256, policy, policyPath, receiptPath };
}

afterEach(() => {
  while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true });
});

describe('Action release preflight', () => {
  it('admits one exact accepted receipt owned by the fixed Action repository and commit', () => {
    const item = makeCase();
    const result = runPreflight({ policyPath: item.policyPath, receiptPath: item.receiptPath, actionRepository: fixture.policy.actionRepository });
    expect(result).toMatchObject({
      ok: true,
      status: 'PASS',
      releaseId: fixture.receipt.releaseId,
      scannerRepository: fixture.policy.scannerRepository,
      scannerRef: fixture.receipt.scannerRef,
      receiptSha256: item.receiptSha256,
    });
  });

  it('refuses an explicit pending policy before scanner checkout', () => {
    const policy = { ...fixture.policy, status: 'PENDING_FINAL_CANDIDATE', releaseReceiptSha256: null };
    const result = validateActionPreflight({
      policy,
      receipt: fixture.receipt,
      receiptSha256: policy.releaseReceiptSha256,
      actionRepository: policy.actionRepository,
    });
    expect(result).toMatchObject({ ok: false, code: 'FINAL_RELEASE_RECEIPT_NOT_CONFIGURED' });
  });

  it('refuses a different Action repository', () => {
    const item = makeCase();
    const result = runPreflight({ policyPath: item.policyPath, receiptPath: item.receiptPath, actionRepository: 'attacker/scanner' });
    expect(result).toMatchObject({ ok: false, code: 'ACTION_REPOSITORY_MISMATCH' });
  });

  it('refuses receipt bytes that no longer match the Action-owned digest', () => {
    const item = makeCase();
    fs.appendFileSync(item.receiptPath, ' ');
    const result = runPreflight({ policyPath: item.policyPath, receiptPath: item.receiptPath, actionRepository: fixture.policy.actionRepository });
    expect(result).toMatchObject({ ok: false, code: 'RELEASE_RECEIPT_DIGEST_MISMATCH' });
  });

  it.each([
    ['policy', 'RELEASE_POLICY_DUPLICATE_KEY'],
    ['receipt', 'RELEASE_RECEIPT_DUPLICATE_KEY'],
  ])('refuses duplicate JSON keys in the %s', (target, expectedCode) => {
    const item = makeCase();
    const pathValue = target === 'policy' ? item.policyPath : item.receiptPath;
    const original = fs.readFileSync(pathValue, 'utf8');
    const duplicate = target === 'policy'
      ? original.replace('"status": "ACCEPTED",', '"status": "ACCEPTED",\n  "status": "ACCEPTED",')
      : original.replace('"name": "sfscanner",', '"name": "sfscanner",\n      "name": "sfscanner",');
    const bytes = Buffer.from(duplicate, 'utf8');
    fs.writeFileSync(pathValue, bytes);
    if (target === 'receipt') {
      item.policy.releaseReceiptSha256 = sha256Bytes(bytes);
      fs.writeFileSync(item.policyPath, `${JSON.stringify(item.policy, null, 2)}\n`);
    }
    const result = runPreflight({ policyPath: item.policyPath, receiptPath: item.receiptPath, actionRepository: fixture.policy.actionRepository });
    expect(result).toMatchObject({ ok: false, code: expectedCode });
  });

  it.each([
    ['missing receipt', (item) => fs.rmSync(item.receiptPath), 'RELEASE_RECEIPT_MISSING'],
    ['non-accepted status', (item) => { item.receipt.status = 'TEST_ONLY'; item.receipt.artifactSetSha256 = artifactSetSha256(item.receipt.artifacts); }, 'RELEASE_RECEIPT_NOT_ACCEPTED'],
    ['unknown receipt property', (item) => { item.receipt.extra = true; }, 'RELEASE_RECEIPT_SCHEMA_INVALID'],
    ['mutable scanner ref', (item) => { item.receipt.scannerRef = 'main'; }, 'SCANNER_REF_INVALID'],
    ['missing worker artifact', (item) => {
      item.receipt.artifacts = item.receipt.artifacts.filter(({ path: file }) => !file.endsWith('/scan-worker.js'));
    }, 'REQUIRED_ARTIFACT_MISSING'],
    ['unsorted artifacts', (item) => { item.receipt.artifacts.reverse(); }, 'ARTIFACT_ORDER_INVALID'],
    ['unsafe artifact path', (item) => { item.receipt.artifacts[1].path = 'packages/scanner-cli/dist/../main.js'; }, 'ARTIFACT_ENTRY_INVALID'],
  ])('refuses %s', (_label, mutate, expectedCode) => {
    const item = makeCase();
    mutate(item);
    if (fs.existsSync(item.receiptPath)) {
      item.receipt.artifactSetSha256 = artifactSetSha256(item.receipt.artifacts);
      const bytes = Buffer.from(`${JSON.stringify(item.receipt, null, 2)}\n`, 'utf8');
      fs.writeFileSync(item.receiptPath, bytes);
      item.policy.releaseReceiptSha256 = sha256Bytes(bytes);
      fs.writeFileSync(item.policyPath, `${JSON.stringify(item.policy, null, 2)}\n`);
    }
    const result = runPreflight({ policyPath: item.policyPath, receiptPath: item.receiptPath, actionRepository: fixture.policy.actionRepository });
    expect(result).toMatchObject({ ok: false, code: expectedCode });
  });

  it('prints a refusal and does not publish step outputs for a pending policy with no receipt', () => {
    const item = makeCase();
    const pending = { ...item.policy, status: 'PENDING_FINAL_CANDIDATE', releaseReceiptSha256: null };
    fs.writeFileSync(item.policyPath, `${JSON.stringify(pending, null, 2)}\n`);
    fs.rmSync(item.receiptPath);
    const outputPath = path.join(item.root, 'github-output');
    fs.writeFileSync(outputPath, '');
    const result = spawnSync(process.execPath, [scriptPath, '--policy', item.policyPath, '--receipt', path.join(item.root, 'missing-release-receipt.json'), '--action-repository', pending.actionRepository], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: 'FINAL_RELEASE_RECEIPT_NOT_CONFIGURED' });
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('');
  });

  it('publishes only validated receipt-bound values to GITHUB_OUTPUT', () => {
    const item = makeCase();
    const outputPath = path.join(item.root, 'github-output');
    fs.writeFileSync(outputPath, '');
    const result = spawnSync(process.execPath, [scriptPath, '--policy', item.policyPath, '--receipt', item.receiptPath, '--action-repository', fixture.policy.actionRepository], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, status: 'PASS', releaseId: fixture.receipt.releaseId });
    expect(fs.readFileSync(outputPath, 'utf8')).toBe([
      `release-id=${fixture.receipt.releaseId}`,
      `receipt-sha256=${item.receiptSha256}`,
      `scanner-repository=${fixture.receipt.scannerRepository}`,
      `scanner-ref=${fixture.receipt.scannerRef}`,
      `source-tree-sha256=${fixture.receipt.sourceTreeSha256}`,
      `lockfile-sha256=${fixture.receipt.lockfileSha256}`,
      `package-version=${fixture.receipt.package.version}`,
      `package-tarball-sha256=${fixture.receipt.package.tarballSha256}`,
      `artifact-set-sha256=${artifactSetSha256(fixture.receipt.artifacts)}`,
      '',
    ].join('\n'));
  });
});

describe('composite Action integration', () => {
  const action = yaml.load(fs.readFileSync(actionPath, 'utf8'));
  const steps = action.runs.steps;
  const index = (name) => steps.findIndex((step) => step.name === name);

  it('removes caller-owned scanner repository and ref inputs', () => {
    expect(action.inputs).not.toHaveProperty('scanner-ref');
    expect(action.inputs).not.toHaveProperty('scanner-repository');
    expect(action.outputs).toHaveProperty('sarif-file');
    expect(action.outputs).toHaveProperty('exit-code');
  });

  it('sets up pinned Node, preflights receipt, then checks out only the receipt-bound source', () => {
    const setup = steps[index('Set up Node.js 22 for trust preflight')];
    const preflight = steps[index('Verify Action-owned release receipt before scanner checkout')];
    const reserve = steps[index('Refuse a pre-existing scanner checkout path')];
    const checkout = steps[index('Check out receipt-bound scanner source')];
    expect(setup.uses).toMatch(/@[0-9a-f]{40}$/u);
    expect(checkout.uses).toMatch(/@[0-9a-f]{40}$/u);
    expect(index(setup.name)).toBeLessThan(index(preflight.name));
    expect(index(preflight.name)).toBeLessThan(index(reserve.name));
    expect(index(reserve.name)).toBeLessThan(index(checkout.name));
    expect(preflight.env.PREFLIGHT_SCRIPT).toContain('scripts/scanner-action/preflight.mjs');
    expect(checkout.with.repository).toBe('${{ steps.preflight.outputs.scanner-repository }}');
    expect(checkout.with.ref).toBe('${{ steps.preflight.outputs.scanner-ref }}');
    expect(checkout.with['persist-credentials']).toBe(false);
  });

  it('resolves every Action-owned script path from the real nested action directory', () => {
    const actionDirectory = path.dirname(actionPath);
    expect(path.resolve(actionDirectory, '../../../')).toBe(path.resolve(here, '../..'));
    const expressions = [
      steps[index('Verify Action-owned release receipt before scanner checkout')].env.PREFLIGHT_SCRIPT,
      steps[index('Verify Action-owned release receipt before scanner checkout')].env.PREFLIGHT_POLICY,
      steps[index('Verify Action-owned release receipt before scanner checkout')].env.PREFLIGHT_RECEIPT,
      steps[index('Verify checked scanner source')].env.SOURCE_RECEIPT,
      steps[index('Verify built scanner artifacts')].env.ARTIFACT_RECEIPT,
    ];
    for (const expression of expressions) expect(expression).toContain('/../../../scripts/scanner-action/');
    expect(steps[index('Verify checked scanner source')].run).toContain('$GITHUB_ACTION_PATH/../../../scripts/scanner-action/adapter.mjs');
    expect(steps[index('Verify built scanner artifacts')].run).toContain('$GITHUB_ACTION_PATH/../../../scripts/scanner-action/adapter.mjs');
  });

  it('verifies source before install and artifacts before scanner execution', () => {
    const order = ['Refuse a pre-existing scanner checkout path', 'Check out receipt-bound scanner source', 'Verify checked scanner source', 'Install locked scanner dependencies', 'Build scanner CLI', 'Verify built scanner artifacts', 'Run v2 scanner'].map(index);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(order.every((value) => value >= 0)).toBe(true);
    expect(steps[index('Verify checked scanner source')].run).toContain('adapter.mjs" source');
    expect(steps[index('Verify built scanner artifacts')].run).toContain('adapter.mjs" artifacts');
  });
});
