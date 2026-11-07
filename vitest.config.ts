import { defineConfig } from 'vitest/config';
import path from 'node:path';

const workspaceRoot = import.meta.dirname;
const appRoot = path.resolve(workspaceRoot, 'app');
const pipelineRoot = path.resolve(workspaceRoot, 'pipeline');
const contractsRoot = path.resolve(workspaceRoot, 'contracts');
const scannerCoreRoot = path.resolve(workspaceRoot, 'packages/scanner-core');
const scannerCliRoot = path.resolve(workspaceRoot, 'packages/scanner-cli');
const alias = {
  '@': appRoot,
};

/**
 * Shared cloud runners have CPU jitter that produces false-positive failures on
 * millisecond thresholds. Owner policy (2026-10-18): apply the same CI tolerance
 * the p95 gate's cross-machine mode uses — `run-gates.mjs` selects it when
 * `CI === 'true'` — to vitest's per-test timeout. The multiplier is 2.0x because
 * the measured stage-36 overshoot was 118.60 ms against a 75 ms bound (1.58x),
 * which 1.5x did not cover. Applied once here at the config level rather than
 * per test, and without reducing parallelism: a per-test tweak would hide the
 * jitter the policy is about, and fewer workers would mask the cause instead of
 * stating the policy. Local runs keep the strict 5,000 ms bound; CI uses
 * 10,000 ms.
 */
const DEFAULT_TEST_TIMEOUT_MS = 5_000;
const CI_TIMEOUT_TOLERANCE = 2.0;
const ciTolerance = process.env.CI === 'true' ? CI_TIMEOUT_TOLERANCE : 1;
const testTimeout = DEFAULT_TEST_TIMEOUT_MS * ciTolerance;
// Printed on every run so a CI-tolerated pass can never be mistaken for a strict
// one. The config module is evaluated once per project (plus the root) — seven
// evaluations here — so this reports once per process instead of seven times.
const reportState = globalThis as typeof globalThis & { __vitestTimeoutMeasurementReported?: boolean };
if (!reportState.__vitestTimeoutMeasurementReported) {
  reportState.__vitestTimeoutMeasurementReported = true;
  // stderr, never stdout: a consumer that parses this process's stdout as JSON —
  // `run-scanner-mutation-gate.mjs` does exactly that against a `--reporter=json`
  // canary — treats any leading line as malformed output. The line stays visible
  // without becoming part of a machine-readable payload.
  console.error(
    `[MEASUREMENT] vitest testTimeout ${testTimeout} ms ` +
      `(default ${DEFAULT_TEST_TIMEOUT_MS} ms × ${ciTolerance} CI tolerance; CI=${process.env.CI === 'true'})`,
  );
}

export default defineConfig({
  test: {
    alias,
    testTimeout,
    // One forked worker per core means sixteen jsdom environments on a 16-core
    // machine, and V8 starts failing zone allocations long before the JS heap
    // looks full: "FATAL ERROR: Zone Allocation failed - process out of memory"
    // at a 60 MB heap, taking whole test files down with it and turning the
    // suite's exit code into a coin flip.
    //
    // Bounding the worker count alone was not enough — it still dropped a file
    // roughly every other run — because the real constraint is the per-fork
    // heap ceiling, not how many forks there are. So do both: fewer workers,
    // and a heap each that the heaviest corpus test can actually fit in.
    //
    // `next.config.ts` and `scripts/build-app.mjs` bound the static-export
    // workers for the same underlying reason.
    // Two forks at 2 GB each. The product of these two numbers is the thing that
    // matters: four forks at 4 GB asked for a 16 GB ceiling on a machine with
    // 4.5 GB free and made the crashes *more* frequent, not fewer.
    //
    // `execArgv` is top-level in Vitest 4. Nesting it under `poolOptions.forks`
    // is accepted silently with only a deprecation notice, and the heap ceiling
    // is never applied — so verify with `--max-old-space-size` showing up in a
    // worker's `process.execArgv`, not by the config looking right.
    maxWorkers: 2,
    execArgv: ['--max-old-space-size=2048'],
    projects: [
      {
        extends: true,
        root: appRoot,
        test: {
          name: 'app',
          environment: 'jsdom',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'app/**/*.test.ts', 'app/**/*.test.tsx', 'e2e/**/*.test.ts'],
          alias,
        },
      },
      {
        extends: true,
        root: pipelineRoot,
        test: {
          name: 'pipeline',
          environment: 'node',
          include: ['**/*.test.ts'],
          exclude: ['**/.work/**'],
          alias,
        },
      },
      {
        extends: true,
        root: contractsRoot,
        test: {
          name: 'contracts',
          environment: 'node',
          include: ['**/*.test.ts'],
          alias,
        },
      },
      {
        extends: true,
        root: scannerCoreRoot,
        test: {
          name: 'scanner-core',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        // The standalone `n8n-scan` CLI. This project was missing until
        // 2026-09-04, so `packages/scanner-cli/src/cli.test.ts` existed and
        // passed locally but was never collected by `npm test` — the gate that
        // is supposed to protect the one artifact we publish to npm.
        extends: true,
        root: scannerCliRoot,
        test: {
          name: 'scanner-cli',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          // One build before any test in this project: `build.mjs` replaces `dist/` wholesale and
          // several test files read that asset, so an in-file build raced its parallel readers.
          globalSetup: [path.resolve(scannerCliRoot, 'vitest.global-setup.ts')],
        },
      },
      {
        // Build tooling that reads the export and writes into it. It cannot
        // live under `app/src` — that tree is browser-safe by rule, and this
        // needs `fs` — and it is not pipeline work either: it runs after the
        // Next build, on the Next build's output.
        extends: true,
        root: path.resolve(workspaceRoot, 'scripts'),
        test: {
          name: 'scripts',
          environment: 'node',
          // Plain-node CI gate scripts (check:*) stay `.mjs`, matching the
          // no-build-step convention of `npm run check:*`; their colocated
          // tests need the same extension to share a module system.
          include: ['**/*.test.ts', '**/*.test.mjs'],
          // This drill intentionally uses node:test and is run by its own
          // command; Vitest must not treat it as an empty suite.
          exclude: ['**/rollback-release.test.mjs'],
          alias,
        },
      },
    ],
  },
});
