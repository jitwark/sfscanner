import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadBundledRelease } from './preflight.mjs';
import { verifyArtifacts } from './adapter.mjs';

const ENV_KEYS = new Set(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'LANG', 'LC_ALL']);
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu;

export function scannerEnvironment(input) {
  return Object.fromEntries(Object.entries(input).filter(([key, value]) =>
    ENV_KEYS.has(key.toUpperCase()) && typeof value === 'string'));
}

function checkedPath(root, raw, output = false) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024 || raw.startsWith('-')
    || /[\\:\u0000-\u001f\u007f]/u.test(raw) || raw.startsWith('/')) throw new Error('SCAN_PATH_INVALID');
  const parts = raw.split('/');
  if (raw !== '.' && parts.some((part) => part === '' || part === '.' || part === '..'
    || /[. ]$/u.test(part) || DEVICE.test(part))) throw new Error('SCAN_PATH_INVALID');
  if (['.scanner-source', '.git'].includes(parts[0].toLowerCase())) throw new Error('SCAN_RESERVED_PATH');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === '.') continue;
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (output && index === parts.length - 1 && error.code === 'ENOENT') return current;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('SCAN_SYMLINK_REFUSED');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('SCAN_PARENT_INVALID');
    if (stat.isFile() && stat.nlink !== 1) throw new Error('SCAN_HARDLINK_REFUSED');
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('SCAN_SPECIAL_FILE_REFUSED');
    if (output && index === parts.length - 1 && !stat.isFile()) throw new Error('SCAN_OUTPUT_INVALID');
  }
  return current;
}

export function prepareScan({ workspace, scanPath, sarifPath, failOn }) {
  if (fs.lstatSync(workspace).isSymbolicLink()) throw new Error('SCAN_WORKSPACE_SYMLINK_REFUSED');
  const root = fs.realpathSync(workspace);
  const input = checkedPath(root, scanPath);
  const output = checkedPath(root, sarifPath, true);
  if (input.toLowerCase() === output.toLowerCase()) throw new Error('SCAN_INPUT_OUTPUT_COLLISION');
  const severity = typeof failOn === 'string' ? failOn.toUpperCase() : '';
  if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].includes(severity)) throw new Error('SCAN_FAIL_ON_INVALID');
  return Object.freeze({ root, sarifPath, args: Object.freeze([
    '--schema', 'v2', 'scan', input, '--format=sarif', `--fail-on=${severity}`,
    '--exclude=.git/**', '--exclude=node_modules/**', '--exclude=.scanner-source/**', `--output=${sarifPath}`,
  ]) });
}

/** Low-level fake-CLI test seam; production runAction always verifies its bundled release. */
export async function executeScan({ plan, executable, environment = process.env, signal }) {
  if (signal?.aborted) return { exitCode: 130 };
  return new Promise((resolve) => {
    let aborted = false;
    const child = spawn(process.execPath, [executable, ...plan.args], {
      cwd: plan.root, shell: false, windowsHide: true,
      env: scannerEnvironment(environment), stdio: ['ignore', 'inherit', 'inherit'],
    });
    let timer;
    const abort = () => {
      aborted = true;
      child.kill('SIGTERM');
      timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      timer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', () => { cleanup(); resolve({ exitCode: aborted ? 130 : 4 }); });
    child.once('close', (code) => { cleanup(); resolve({ exitCode: aborted ? 130 : (code ?? 4) }); });
  });
}

export async function runAction(options) {
  const trusted = loadBundledRelease();
  if (!trusted.ok) return { ...trusted, exitCode: 1 };
  try {
    const plan = prepareScan(options);
    const sourceRoot = path.join(plan.root, '.scanner-source');
    const verified = verifyArtifacts({ sourceRoot, receiptPath: trusted.receiptPath, receiptSha256: trusted.receiptSha256 });
    if (!verified.ok) return { ...verified, exitCode: 1 };
    const executable = path.join(sourceRoot, 'packages/scanner-cli/dist/main.js');
    const result = await executeScan({ plan, executable, signal: options.signal });
    return { ok: result.exitCode === 0, sarifPath: plan.sarifPath, ...result };
  } catch (error) {
    return { ok: false, code: error.message, exitCode: 2 };
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const result = await runAction({
    workspace: process.env.GITHUB_WORKSPACE, scanPath: process.env.SCAN_PATH,
    sarifPath: process.env.SARIF_FILE, failOn: process.env.FAIL_ON, signal: controller.signal,
  });
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
  if (result.sarifPath && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `sarif-file=${result.sarifPath}\nexit-code=${result.exitCode}\n`);
  }
  if (result.code) process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
