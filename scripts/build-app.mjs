/**
 * Run `next build` with a heap large enough for the corpus.
 *
 * Static generation loads the catalogue through `allEntries()`, which parses all
 * seven shards — 171.6 MB of JSON on disk — into 13,221 `Entry` objects. Measured:
 * **255 MB of heap per worker**, and the cache is per worker process, so the
 * default four workers hold about 1 GB of duplicated corpus before Next has
 * rendered anything.
 *
 * On a developer machine that tips over as:
 *
 *     FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory
 *     Next.js build worker exited with code: 3221226505
 *
 * The dangerous part is not the crash. A worker that dies mid-render still
 * leaves an HTML file behind, containing an empty `<body>` and nothing else, and
 * the build can still exit 0 — silent corruption of one page in 583. It was
 * caught by `app/qa/check-seo.mjs` ("expected exactly one h1, found 0") rather
 * than by the build, which is exactly the safety net working as intended.
 *
 * Raising the ceiling is the stopgap. The real fix is to stop holding the whole
 * corpus per worker — tracked with the search-index work, since both are the
 * same problem: an artifact sized for the whole catalogue loaded in one piece.
 *
 * **The product of workers and ceiling is what matters, not either alone.**
 * NODE_OPTIONS is inherited by every static-generation worker, so four workers
 * at 6 GB ask for a 24 GB ceiling on a machine with far less, and the OOM gets
 * *more* likely rather than less. Both numbers are set here, together, and
 * next.config.ts reads the worker count from the environment so the two cannot
 * drift apart.
 *
 * A wrapper rather than an inline `NODE_OPTIONS=` because npm scripts run
 * through cmd.exe on Windows, where env-var prefixes are not shell syntax.
 * `scripts/run-e2e.mjs` sets the same precedent.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKERS = Number(process.env.BUILD_WORKERS ?? 2);
const HEAP_MB = Number(process.env.BUILD_HEAP_MB ?? 2560);

export function clearExportOutput(root = fileURLToPath(new URL('..', import.meta.url)), remove = rmSync) {
  const projectRoot = resolve(root);
  const appDirectory = resolve(projectRoot, 'app');
  const output = resolve(appDirectory, 'out');
  if (dirname(output) !== appDirectory || basename(output) !== 'out') {
    throw new Error('Refusing to clean an unexpected export path: ' + output);
  }
  try {
    if (!statSync(resolve(projectRoot, 'package.json')).isFile() || !statSync(appDirectory).isDirectory()) {
      throw new Error('project root is missing package.json or app directory');
    }
    // An absent `app/out` is the state this function is trying to reach, not a
    // hazard. `lstatSync` threw ENOENT on a fresh clone and the catch below
    // reported "Refusing to clean app/out", which reads as a safety refusal and
    // meant the build could not start at all.
    const existing = lstatSync(output, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) throw new Error('app/out must not be a symbolic link');
  } catch (error) {
    if (error instanceof Error && error.message.includes('Refusing')) throw error;
    throw new Error('Refusing to clean app/out: ' + (error instanceof Error ? error.message : String(error)));
  }
  try {
    remove(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    throw new Error('Unable to clean app/out before build: ' + (error instanceof Error ? error.message : String(error)));
  }
}
export function selectBuildArgs(args) {
  const buildArgs = [...args];
  const hasBundlerSelection = buildArgs.some((argument) => (
    argument === '--webpack' || argument === '--turbo' || argument === '--turbopack'
  ));

  // Next 16 defaults to Turbopack, which emits `new URL(...worker.ts)` entries
  // as raw TypeScript assets in this static export. Webpack turns those entries
  // into executable worker bundles and is therefore the release-safe default.
  if (!hasBundlerSelection) buildArgs.unshift('--webpack');
  return buildArgs;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const buildArgs = selectBuildArgs(process.argv.slice(2));
  clearExportOutput();
  process.stdout.write(`Building with ${WORKERS} worker(s) x ${HEAP_MB} MB heap.\n`);

  const result = spawnSync('npx', ['next', 'build', ...buildArgs], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      NEXT_BUILD_WORKERS: String(WORKERS),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${HEAP_MB}`.trim(),
    },
  });

  process.exit(result.status ?? 1);
}
