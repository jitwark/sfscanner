import fs from 'node:fs';
import path from 'node:path';
import { MATCHERS, sweepCorpusPrivacy } from './lib/corpus-privacy.mjs';

/**
 * Measure what personal or credential-shaped text survives into the published
 * corpus, and fail if it grows.
 *
 * The sanitizer redacts what it recognises during acquisition. This asks the
 * different question: after everything, what is actually in the artifacts we
 * serve? It prints counts and entry ids, never a matched value — a privacy
 * sweep that logs the addresses it found has published them a second time, into
 * CI output retained for weeks.
 *
 * The baseline lives in `docs/privacy.md` and in BASELINE below. Raising it is
 * a decision someone makes deliberately, with the ids in hand.
 *
 *   node scripts/check-corpus-privacy.mjs [dataDir]
 */
const BASELINE_PATH = 'scripts/corpus-privacy-baseline.json';
const dataDir = path.resolve(process.argv[2] ?? 'data');
const root = path.resolve(import.meta.dirname, '..');

/** Every published string a reader can see, per entry. */
function* documents() {
  for (let shard = 0; ; shard += 1) {
    const cataloguePath = path.join(dataDir, `catalogue-${shard}.json`);
    if (!fs.existsSync(cataloguePath)) break;
    for (const entry of JSON.parse(fs.readFileSync(cataloguePath, 'utf8'))) {
      const parts = [
        entry.title, entry.summary, entry.description,
        entry.source?.repo, entry.source?.owner, entry.source?.path, entry.source?.url,
        ...(Array.isArray(entry.hostnames) ? entry.hostnames : []),
        ...(Array.isArray(entry.structure?.integrations) ? entry.structure.integrations : []),
      ];
      yield { id: entry.id, text: parts.filter((part) => typeof part === 'string').join('\n') };
    }
  }
}

const result = sweepCorpusPrivacy(documents());

if (result.scanned === 0) {
  console.error(`Corpus privacy gate failed: no catalogue shards found in ${dataDir}.`);
  process.exit(1);
}

let baseline = null;
const baselineFile = path.join(root, BASELINE_PATH);
if (fs.existsSync(baselineFile)) baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));

console.log(`Corpus privacy swept: ${result.scanned} entries.`);
const regressions = [];
for (const matcher of MATCHERS) {
  const count = result.totals[matcher.name];
  const entries = result.entriesAffected[matcher.name];
  const limit = baseline?.totals?.[matcher.name];
  console.log(
    `  ${matcher.name.padEnd(20)} ${String(count).padStart(6)}` +
    ` across ${String(entries.length).padStart(5)} entries` +
    (limit === undefined ? '' : ` (baseline ${limit})`),
  );
  if (limit !== undefined && count > limit) {
    regressions.push(`${matcher.name}: ${count} occurrences, baseline ${limit}. Entries: ${entries.slice(0, 10).join(', ')}`);
  }
}

if (process.argv.includes('--write-baseline')) {
  fs.writeFileSync(baselineFile, `${JSON.stringify({
    capturedAgainstEntries: result.scanned,
    totals: result.totals,
    entriesAffected: Object.fromEntries(
      MATCHERS.map((matcher) => [matcher.name, result.entriesAffected[matcher.name].length]),
    ),
  }, null, 2)}\n`, 'utf8');
  console.log(`Baseline written to ${BASELINE_PATH}.`);
  process.exit(0);
}

if (regressions.length > 0) {
  console.error('Corpus privacy gate failed: more personal or credential-shaped text than the baseline.');
  for (const regression of regressions) console.error(`  ${regression}`);
  console.error('Look at those entries. If the new text is genuinely benign, re-run with');
  console.error('--write-baseline and say in the commit message what you looked at.');
  process.exit(1);
}

console.log('Corpus privacy gate passed.');
