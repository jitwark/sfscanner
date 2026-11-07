import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { executeScan, prepareScan, scannerEnvironment } from './run-scan.mjs';
import { collectArtifactEntries } from './artifact-digest.mjs';
import { sha256Bytes } from './release-contract.mjs';
import { parseArgumentsV2 } from '../../packages/scanner-cli/src/v2/arguments.ts';

const roots = [];
const actionModules = ['adapter.mjs', 'artifact-digest.mjs', 'preflight.mjs', 'release-contract.mjs', 'run-scan.mjs'];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'action-run-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'input.json'), '{}');
  return { root, options: { workspace: root, scanPath: 'input.json', sarifPath: 'scan.sarif', failOn: 'high' } };
}
function copiedAction(root, name) {
  const action = path.join(root, name);
  fs.mkdirSync(action);
  for (const file of actionModules) fs.copyFileSync(path.join(import.meta.dirname, file), path.join(action, file));
  return action;
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

it.each(['scan.sarif', 'reports/action scan.sarif'])('passes CLI-admitted relative output %s', (sarifPath) => {
  const { root, options } = fixture();
  fs.mkdirSync(path.join(root, 'reports'));
  const plan = prepareScan({ ...options, sarifPath });
  expect(plan.root).toBe(fs.realpathSync(root));
  expect(plan.args).toContain(`--output=${sarifPath}`);
  expect(parseArgumentsV2(plan.args)).toMatchObject({ ok: true, command: { kind: 'scan', output: sarifPath, format: 'sarif' } });
  const absoluteOutputArgs = plan.args.map((arg) => arg.startsWith('--output=') ? `--output=${path.join(root, sarifPath)}` : arg);
  expect(parseArgumentsV2(absoluteOutputArgs)).toMatchObject({ ok: false, error: { code: 'REMOTE_PATH', argument: '--output' } });
});

const builtCli = path.resolve(import.meta.dirname, '../../packages/scanner-cli/dist/main.js');
it.skipIf(!fs.existsSync(builtCli))('executes the existing CLI artifact with relative output in workspace cwd', async () => {
  const { root, options } = fixture();
  fs.writeFileSync(path.join(root, 'input.json'), JSON.stringify({
    name: 'Action regression', nodes: [{ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
    connections: {}, active: false, settings: {},
  }));
  fs.mkdirSync(path.join(root, 'reports'));
  const sarifPath = 'reports/action scan.sarif';
  const result = await executeScan({ plan: prepareScan({ ...options, sarifPath }), executable: builtCli });
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(fs.readFileSync(path.join(root, sarifPath), 'utf8'));
  expect(report.version).toBe('2.1.0');
  expect(report.runs).toHaveLength(1);
  expect(report.runs[0].results).toEqual([]);
});

it.each(['../input.json', '/tmp/x', 'C:input.json', 'file:stream', 'x\ny', '\\\\host\\share', 'NUL.json', 'dir/../x', 'x.', 'x ', '-x'])
('refuses unsafe input %s', (scanPath) => {
  const { options } = fixture();
  expect(() => prepareScan({ ...options, scanPath })).toThrow('SCAN_PATH_INVALID');
});

it('rejects linked parents and existing SARIF aliases', () => {
  const { root, options } = fixture();
  const outside = fixture().root;
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  expect(() => prepareScan({ ...options, sarifPath: 'linked/report.sarif' })).toThrow('SCAN_SYMLINK_REFUSED');
  fs.linkSync(path.join(root, 'input.json'), path.join(root, 'scan.sarif'));
  expect(() => prepareScan(options)).toThrow('SCAN_HARDLINK_REFUSED');
});

it('rejects input/output collisions, reserved paths and invalid severity', () => {
  const { options } = fixture();
  expect(() => prepareScan({ ...options, sarifPath: 'input.json' })).toThrow('SCAN_INPUT_OUTPUT_COLLISION');
  expect(() => prepareScan({ ...options, sarifPath: '.scanner-source/result' })).toThrow('SCAN_RESERVED_PATH');
  expect(() => prepareScan({ ...options, failOn: 'high; echo bad' })).toThrow('SCAN_FAIL_ON_INVALID');
});

it('forwards shell metacharacters as literal argv and removes secrets and Node injection', async () => {
  const { root, options } = fixture();
  const scanPath = 'input; $(touch injected).json';
  fs.renameSync(path.join(root, 'input.json'), path.join(root, scanPath));
  const plan = prepareScan({ ...options, scanPath });
  const executable = path.join(root, 'fake.mjs');
  fs.writeFileSync(executable, `import fs from 'node:fs'; fs.writeFileSync('observed.json', JSON.stringify({args:process.argv.slice(2),env:process.env})); process.exitCode=3;`);
  const environment = { ...process.env, NODE_OPTIONS: '--bad-option', GITHUB_TOKEN: 'canary', CUSTOM_SECRET: 'canary' };
  expect(scannerEnvironment(environment)).not.toHaveProperty('NODE_OPTIONS');
  expect(await executeScan({ plan, executable, environment })).toEqual({ exitCode: 3 });
  const observed = JSON.parse(fs.readFileSync(path.join(root, 'observed.json'), 'utf8'));
  expect(observed.args[3]).toBe(path.join(root, scanPath));
  expect(observed.args).toContain('--fail-on=HIGH');
  expect(observed.env).not.toHaveProperty('GITHUB_TOKEN');
  expect(observed.env).not.toHaveProperty('CUSTOM_SECRET');
  expect(observed.env).not.toHaveProperty('NODE_OPTIONS');
  expect(fs.existsSync(path.join(root, 'injected'))).toBe(false);
});

it('returns 130 before spawn when cancelled', async () => {
  const { options } = fixture();
  const controller = new AbortController(); controller.abort();
  expect(await executeScan({ plan: prepareScan(options), executable: 'does-not-exist', signal: controller.signal })).toEqual({ exitCode: 130 });
});

it('terminates an active scanner on cancellation', async () => {
  const { root, options } = fixture();
  const executable = path.join(root, 'wait.mjs');
  fs.writeFileSync(executable, 'setInterval(() => {}, 100);');
  const controller = new AbortController();
  const running = executeScan({ plan: prepareScan(options), executable, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  expect(await running).toEqual({ exitCode: 130 });
});

it('refuses production execution from an explicit pending Action bundle', async () => {
  const { root, options } = fixture();
  const action = copiedAction(root, 'pending-action');
  const fixtureValue = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'receipt-vectors.json'), 'utf8'));
  const pending = { ...fixtureValue.policy, status: 'PENDING_FINAL_CANDIDATE', releaseReceiptSha256: null };
  fs.writeFileSync(path.join(action, 'release-policy.json'), `${JSON.stringify(pending, null, 2)}\n`);
  const { runAction: runPendingAction } = await import(pathToFileURL(path.join(action, 'run-scan.mjs')).href);
  expect(await runPendingAction(options)).toMatchObject({ ok: false, code: 'FINAL_RELEASE_RECEIPT_NOT_CONFIGURED', exitCode: 1 });
});

it('runs a copied Action with synthetic accepted bytes and rechecks authority before every execution', () => {
  const { root, options } = fixture();
  const action = copiedAction(root, 'synthetic-action');
  const source = path.join(root, '.scanner-source');
  const dist = path.join(source, 'packages/scanner-cli/dist');
  fs.mkdirSync(dist, { recursive: true });
  const fake = `import fs from 'node:fs'; const out=process.argv.find(x=>x.startsWith('--output=')).slice(9); fs.writeFileSync(out, JSON.stringify({argv:process.argv.slice(2), token:process.env.GITHUB_TOKEN??null})); process.exitCode=1;`;
  fs.writeFileSync(path.join(dist, 'main.js'), fake);
  fs.writeFileSync(path.join(dist, 'index.js'), '');
  fs.writeFileSync(path.join(dist, 'scan-worker.js'), '');
  const fixtureValue = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'receipt-vectors.json'), 'utf8'));
  const receipt = { ...fixtureValue.receipt, ...collectArtifactEntries(source) };
  const receiptBytes = JSON.stringify(receipt);
  const policy = { ...fixtureValue.policy, releaseReceiptSha256: sha256Bytes(receiptBytes) };
  const policyPath = path.join(action, 'release-policy.json');
  fs.writeFileSync(path.join(action, 'release-receipt.json'), receiptBytes);
  fs.writeFileSync(policyPath, JSON.stringify(policy));
  const output = path.join(root, 'github-output');
  fs.writeFileSync(output, '');
  const invoke = () => spawnSync(process.execPath, [path.join(action, 'run-scan.mjs')], {
    encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: root, GITHUB_OUTPUT: output,
      SCAN_PATH: options.scanPath, SARIF_FILE: options.sarifPath, FAIL_ON: 'high', GITHUB_TOKEN: 'canary' },
  });
  const passed = invoke();
  expect(passed.status, passed.stderr).toBe(1);
  const report = JSON.parse(fs.readFileSync(path.join(root, options.sarifPath), 'utf8'));
  expect(report.token).toBeNull();
  expect(report.argv).toContain('--format=sarif');
  expect(fs.readFileSync(output, 'utf8')).toBe('sarif-file=scan.sarif\nexit-code=1\n');
  fs.writeFileSync(output, '');
  fs.writeFileSync(path.join(dist, 'main.js'), 'throw new Error("must not execute");');
  expect(invoke().stderr).toContain('ARTIFACT_SIZE_MISMATCH');
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  fs.writeFileSync(policyPath, JSON.stringify({ ...policy, releaseReceiptSha256: '0'.repeat(64) }));
  expect(invoke().stderr).toContain('RELEASE_RECEIPT_DIGEST_MISMATCH');
});
