import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildMaintenancePlan, MODULE_ROOT, stableJson } from './lib/maintenance-plan.mjs';
import { runMaintenanceCandidate } from './lib/maintenance-runner.mjs';
import { safePath } from './lib/maintenance-identity.mjs';

const fail = (message) => { throw new Error(`maintenance: ${message}`); };
export function writePlanOutput(target, output, root = MODULE_ROOT) {
  const resolved = path.resolve(target);
  const relative = path.relative(path.join(root, '.work'), resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('plan output must use private .work storage');
  safePath(path.dirname(resolved), 'plan output directory', { kind: 'directory' });
  writeFileSync(resolved, output, { flag: 'wx' });
}
function parseArgs(argv) {
  const mode = argv[0]; const flags = new Map();
  if (!['plan', 'candidate'].includes(mode)) fail('usage: maintenance.mjs plan --request <file> [--out <file>] | candidate --plan <file>');
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index]; const allowed = mode === 'plan' ? ['--request', '--out'] : ['--plan'];
    if (!allowed.includes(flag) || flags.has(flag) || !argv[index + 1] || argv[index + 1].startsWith('--')) fail(`invalid or incomplete option ${flag}`);
    flags.set(flag, argv[++index]);
  }
  if (mode === 'plan' && !flags.has('--request') || mode === 'candidate' && !flags.has('--plan')) fail('required request/plan path is missing');
  return { mode, flags };
}

async function main(argv = process.argv.slice(2)) {
  const { mode, flags } = parseArgs(argv); const scriptRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (scriptRoot !== MODULE_ROOT) fail('script root identity is inconsistent');
  if (mode === 'plan') {
    const requestPath = safePath(path.resolve(flags.get('--request')), 'request file', { kind: 'file' });
    const request = JSON.parse(readFileSync(requestPath, 'utf8'));
    const plan = buildMaintenancePlan(request, { sourceRoot: MODULE_ROOT, scriptRoot }); const output = stableJson(plan);
    if (flags.has('--out')) {
      writePlanOutput(flags.get('--out'), output);
    }
    process.stdout.write(output); return;
  }
  const planPath = safePath(path.resolve(flags.get('--plan')), 'reviewed plan file', { kind: 'file' });
  const result = await runMaintenanceCandidate(JSON.parse(readFileSync(planPath, 'utf8')), { scriptRoot: MODULE_ROOT });
  process.stdout.write(`${stableJson(result)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
