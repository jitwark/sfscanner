import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The export precondition lives in `app/e2e/export-precondition.ts`, imported by
// `playwright.config.ts`, which enforces it before any spec on BOTH entry paths
// (this script and a bare `npx playwright test`). It is deliberately not duplicated
// here: Playwright loads its config as CJS and cannot import this .mjs file, and a
// second copy is exactly the drift this project keeps paying for.

function main() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'test:e2e', '--workspace', 'app'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, PLAYWRIGHT_SKIP_BUILD: '1' },
  });

  return result.status ?? 1;
}

// Guard the side-effecting entry point: importing this module (from
// playwright.config.ts, or from run-e2e.test.mjs) must never spawn Playwright.
// Only running it directly (`node scripts/run-e2e.mjs`) does.
const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) process.exit(main());
