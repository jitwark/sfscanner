import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const canaryPath = resolve(root, 'packages', 'scanner-core', 'src', 'testing', 'fail-open-canaries.test.ts');
const vitestPath = resolve(root, 'node_modules', 'vitest', 'vitest.mjs');
const configPath = resolve(root, 'vitest.config.ts');

function normalized(value) {
  return value.replaceAll('\\', '/');
}

function failure(message, detail = '') {
  console.error(`Scanner mutation gate failed: ${message}`);
  if (detail) console.error(detail);
  return 1;
}

export function runMutationGate() {
  const child = spawnSync(process.execPath, [
    vitestPath,
    'run',
    '--config', configPath,
    '--project', 'scanner-core',
    canaryPath,
    '--reporter=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (child.error) return failure('unable to start the named canary command.', child.error.message);
  if (child.status !== 0) return failure(`canaries failed with exit status ${child.status ?? 'unknown'}.`, child.stderr.trim() || child.stdout.trim());
  if (typeof child.stdout !== 'string' || child.stdout.trim().length === 0) return failure('canary command returned empty output.');

  let summary;
  try { summary = JSON.parse(child.stdout); } catch { return failure('canary command returned malformed JSON output.'); }
  if (summary === null || typeof summary !== 'object' || summary.success !== true || !Array.isArray(summary.testResults)) {
    return failure('canary command returned an incomplete test summary.');
  }
  if (summary.numTotalTests < 1 || summary.numFailedTests !== 0 || summary.numFailedTestSuites !== 0) {
    return failure('canary command reported failed or empty tests.');
  }
  const expectedPath = normalized(canaryPath);
  const canaryResult = summary.testResults.find((result) => result && normalized(String(result.name)) === expectedPath);
  if (!canaryResult || !Array.isArray(canaryResult.assertionResults) || canaryResult.assertionResults.length < 1) {
    return failure('named canary file did not produce a valid assertion result.');
  }
  if (canaryResult.assertionResults.some((assertion) => assertion?.status !== 'passed')) {
    return failure('named canary file contains a non-passing assertion.');
  }
  console.log(`Scanner mutation gate passed: ${canaryResult.assertionResults.length} fail-open canaries.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) process.exit(runMutationGate());
