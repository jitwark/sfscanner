/**
 * Measures the readability of descriptions we would publish *without* asking a
 * model for anything.
 *
 * `describe.ts` short-circuits any entry whose `descriptionSource` is
 * `upstream`: it skips the model and, with it, `validateDescription` — so the
 * grade-9 ceiling, the unverifiable-claim rules, and the filler blocklist never
 * run on that prose. Every official n8n template arrives with upstream prose
 * from the API, so this is the number that decides whether the enrichment run
 * is ~12,000 generations or ~23,000.
 *
 * Usage: npx tsx pipeline/measure/upstream-readability.ts [entriesPath]
 * Default input is the official acquisition checkpoint of the current run.
 */
import { readFileSync } from 'node:fs';
import { MAX_GRADE, readability } from '../enrich/readability.js';

type Row = { entry: { description?: string; descriptionSource?: string } };

const path = process.argv[2] ?? 'pipeline/.work/rederive-65/official-entries.json';
const rows = JSON.parse(readFileSync(path, 'utf8')) as Row[];

// Same 120-character floor the corpus measurement in STATUS.md uses, so the two
// figures are comparable.
const measured = rows.filter((r) => (r.entry.description ?? '').length >= 120);
const grades = measured.map((r) => readability(r.entry.description ?? '').grade).sort((a, b) => a - b);
const above = grades.filter((g) => g > MAX_GRADE).length;
const mean = grades.reduce((a, b) => a + b, 0) / (grades.length || 1);

console.log(
  JSON.stringify(
    {
      path,
      totalEntries: rows.length,
      upstreamSourced: rows.filter((r) => r.entry.descriptionSource === 'upstream').length,
      measured: measured.length,
      meanGrade: Number(mean.toFixed(1)),
      medianGrade: grades[Math.floor(grades.length / 2)],
      aboveGrade9: above,
      aboveGrade9Share: Number(((above / (measured.length || 1)) * 100).toFixed(1)),
      atOrBelowGrade9: measured.length - above,
    },
    null,
    1,
  ),
);
