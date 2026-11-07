import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateSearchGovernance } from './lib/search-governance.mjs';

const root = resolve(import.meta.dirname, '..');
const defaultFixture = resolve(root, 'app', 'src', 'search', '__fixtures__', 'relevance-set.json');

function optionValue(args, index, name) {
  const value = args[index + 1];
  if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error(`${name} value is required`);
  return value;
}

function parseArgs(args, env, cwd) {
  let fixture = env.SEARCH_GOVERNANCE_FIXTURE ?? defaultFixture;
  let expectedReleaseId = env.SEARCH_GOVERNANCE_RELEASE_ID;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--fixture') { fixture = optionValue(args, index, '--fixture'); index += 1; }
    else if (argument?.startsWith('--fixture=')) fixture = argument.slice('--fixture='.length);
    else if (argument === '--release-id') { expectedReleaseId = optionValue(args, index, '--release-id'); index += 1; }
    else if (argument?.startsWith('--release-id=')) expectedReleaseId = argument.slice('--release-id='.length);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (typeof fixture !== 'string' || !fixture.trim()) throw new Error('fixture path is required');
  return { fixturePath: resolve(cwd, fixture), expectedReleaseId };
}

function failureReport(message) {
  const report = validateSearchGovernance({ fixture: null });
  report.errors = [...new Set([...report.errors, message])].sort();
  return report;
}

export function runSearchGovernanceCheck({ args = [], env = process.env, cwd = process.cwd() } = {}) {
  let options;
  try { options = parseArgs(args, env, cwd); }
  catch (error) { return failureReport(error instanceof Error ? error.message : 'invalid arguments'); }
  let fixture;
  try { fixture = JSON.parse(readFileSync(options.fixturePath, 'utf8')); }
  catch { return failureReport(`fixture could not be read or parsed: ${options.fixturePath}`); }
  return validateSearchGovernance({ fixture, expectedReleaseId: options.expectedReleaseId });
}

export function main(args = process.argv.slice(2), io = { stdout: process.stdout }) {
  const report = runSearchGovernanceCheck({ args });
  io.stdout.write(`${JSON.stringify(report)}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'check-search-governance.mjs')) {
  process.exitCode = main();
}
