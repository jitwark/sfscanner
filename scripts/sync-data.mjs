/**
 * Stage generated artifacts where the app can reach them.
 *
 * The pipeline writes to `community-hub/data/`. The site needs the same bytes in
 * `app/public/data/` so that build-time code can read them from disk and the
 * browser can fetch them from `/data/...`. Copying is deliberate: a symlink does
 * not survive every CI checkout, and importing across workspace roots pulls the
 * whole catalogue into the JS bundle.
 *
 *   node scripts/sync-data.mjs [--check] [--if-present] [--accept-stale-data]
 */
import { cp, mkdir, rm, stat, readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = join(root, 'data');
const destination = join(root, 'app', 'public', 'data');

/**
 * Keys `EntryStructure` requires that a corpus built before phase 6.1 does not
 * have. TypeScript promises they are numbers and booleans; a stale artifact
 * delivers `undefined`, and nothing else in the build would notice.
 *
 * This check exists because that exact failure already shipped once: packaging
 * was fixed to refuse a missing workflow body, the corpus was never rebuilt,
 * and `data/packs/*.jsonl` still serve empty downloads today. A code fix whose
 * artifact is never regenerated is not a fix, so the window where the two
 * disagree closes loudly instead of silently.
 */
const REQUIRED_STRUCTURE_KEYS = ['rawNodeCount', 'annotationNodeCount', 'isSubWorkflow'];

/** Top-level entry keys added by phase 6.2 and 6.3. Absent on a pre-6.2 corpus. */
const REQUIRED_ENTRY_KEYS = ['readiness', 'hostnames'];

async function assertCorpusMatchesContract() {
  const shard = join(source, 'catalogue-0.json');
  if (!(await stat(shard).catch(() => null))) return;

  let first;
  try {
    first = JSON.parse(await readFile(shard, 'utf8'))?.[0];
  } catch {
    return; // A malformed shard is the build's problem to report, not this check's.
  }
  if (!first?.structure) return;

  const missing = [
    ...REQUIRED_STRUCTURE_KEYS.filter((key) => !(key in first.structure)),
    // A redistributable entry always has workflow JSON, so it always has these.
    // A link-only one may legitimately not, which is why the check samples an
    // entry that should carry them rather than asserting on every entry.
    ...(first.rights?.status === 'redistributable'
      ? REQUIRED_ENTRY_KEYS.filter((key) => !(key in first))
      : []),
  ];
  if (missing.length === 0) return;

  const message =
    `data/ predates phase 6.1: catalogue entries are missing ${missing.join(', ')}.\n` +
    'Published node counts, complexity bands, and security grades are the old inflated\n' +
    'values — 17.3% of workflows are in the wrong band and 7.2% carry the wrong grade.\n' +
    'Re-derive the corpus, then repackage downloads (data/packs/*.jsonl currently hold\n' +
    'empty workflow bodies).\n';

  // Mirrors `--accept-partial` in packaging: a known-bad input may pass through,
  // but only when the caller says so in writing.
  if (process.argv.includes('--accept-stale-data')) {
    process.stderr.write(`WARNING: ${message}Continuing because --accept-stale-data was passed.\n`);
    return;
  }

  process.stderr.write(`${message}Pass --accept-stale-data to build against it anyway.\n`);
  process.exit(1);
}

const exists = await stat(source).catch(() => null);
if (!exists?.isDirectory()) {
  // `--if-present` is for the `pretest` hook. `npm test` runs on two kinds of
  // checkout: this one, where the corpus is present and the app suites need it
  // staged, and the standalone scanner repository, which ships source without
  // `data/` on purpose. A hard failure there would mean `npm test` could never
  // run at all, so the flag turns the absence into a stated fact rather than an
  // error. Every other caller still fails closed.
  const missing =
    `No release data at ${source}. This source-only checkout intentionally omits generated catalogue artifacts. `;
  if (process.argv.includes('--if-present')) {
    console.log(`${missing}Skipping the data sync; corpus-dependent suites will skip too.`);
    process.exit(0);
  }
  console.error(`${missing}Build a rights-reviewed package first, then retry: node pipeline/build-corpus.ts --run <id>`);
  process.exit(1);
}

if (process.argv.includes('--check')) {
  const staged = await stat(destination).catch(() => null);
  if (!staged?.isDirectory()) {
    process.stderr.write('app/public/data is missing; run node scripts/sync-data.mjs\n');
    process.exit(1);
  }
  execFileSync(process.execPath, [join(root, 'scripts', 'check-data-sync.mjs'), source, destination], { stdio: 'inherit' });
  process.exit(0);
}

await assertCorpusMatchesContract();

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

async function countFiles(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    total += entry.isDirectory() ? await countFiles(join(directory, entry.name)) : 1;
  }
  return total;
}

process.stdout.write(`staged ${await countFiles(destination)} artifact files into app/public/data\n`);
