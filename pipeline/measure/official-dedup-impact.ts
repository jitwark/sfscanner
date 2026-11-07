/**
 * Answers the four questions a corpus re-derive has to answer about the
 * official n8n library, from the artifact rather than from the run log.
 *
 * 1. Did dedup actually work? Run rederive-62 turned 11,490 official templates
 *    into 1 canonical entry and the report looked unremarkable. The
 *    discriminating number is not "canonicals went up" but whether the official
 *    templates reconcile: every one is either a canonical entry or an n8n.io
 *    permalink recorded in some winner's `alsoFoundIn`, and the two must sum to
 *    the number acquired. Counting `alsoFoundIn` entries of any kind does not
 *    show this — GitHub aggregators mirror each other too, which produces a
 *    high rate with zero official collapse.
 * 2. Are official grades comparable to GitHub grades? GitHub bodies are
 *    sanitized before the scan and official bodies are not, so secret-shaped
 *    values survive into the official scan and can skew it worse for a
 *    structural reason. Same family as counting sticky notes as complexity.
 * 3. Did anything reach the output still unscanned? `scannerVersion:
 *    'unscanned'` is the acquirer's placeholder and must never survive.
 * 4. How many official canonicals are there to describe? That sizes the
 *    enrichment run.
 *
 * Reads `entries.json` a line at a time: it is pretty-printed and near the
 * limit on how long a single JavaScript string may be, so `readFileSync` +
 * `JSON.parse` is not available to us.
 *
 * Usage: npx tsx pipeline/measure/official-dedup-impact.ts [runId]
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

type Row = {
  entry: {
    source?: { kind?: string };
    rights?: { status?: string };
    security?: { grade?: string; scannerVersion?: string };
    dedup?: { canonical?: boolean; alsoFoundIn?: string[] };
    readiness?: unknown;
    hostnames?: unknown;
  };
};

const runId = process.argv[2] ?? 'rederive-65';
const path = `pipeline/.work/${runId}/entries.json`;

type Bucket = {
  total: number;
  canonical: number;
  canonicalWithAlsoFoundIn: number;
  /** Canonicals absorbing at least one n8n.io permalink — the official collapse. */
  canonicalAbsorbingAnOfficial: number;
  officialPermalinksAbsorbed: number;
  grades: Record<string, number>;
  unscanned: number;
  withReadiness: number;
};

const bucket = (): Bucket => ({
  total: 0,
  canonical: 0,
  canonicalWithAlsoFoundIn: 0,
  canonicalAbsorbingAnOfficial: 0,
  officialPermalinksAbsorbed: 0,
  grades: {},
  unscanned: 0,
  withReadiness: 0,
});

const official = bucket();
const github = bucket();

function record(row: Row): void {
  const entry = row.entry;
  const target = entry.source?.kind === 'n8n_official' ? official : github;
  target.total += 1;
  if (entry.security?.scannerVersion === 'unscanned') target.unscanned += 1;
  if (entry.readiness) target.withReadiness += 1;
  if (entry.dedup?.canonical !== true) return;
  target.canonical += 1;
  const alsoFoundIn = entry.dedup.alsoFoundIn ?? [];
  if (alsoFoundIn.length > 0) target.canonicalWithAlsoFoundIn += 1;
  // "Has an alsoFoundIn" is not the same claim as "absorbed an official
  // template" — GitHub aggregators mirror each other too, and that alone would
  // produce a high rate with zero official collapse.
  const officialLinks = alsoFoundIn.filter((url) => url.includes('n8n.io/workflows/'));
  if (officialLinks.length > 0) target.canonicalAbsorbingAnOfficial += 1;
  target.officialPermalinksAbsorbed += officialLinks.length;
  const grade = entry.security?.grade ?? 'MISSING';
  target.grades[grade] = (target.grades[grade] ?? 0) + 1;
}

const reader = createInterface({
  input: createReadStream(path, { encoding: 'utf8' }),
  crlfDelay: Number.POSITIVE_INFINITY,
});

let buffer: string[] = [];
let inRecord = false;

// `JSON.stringify(rows, null, 2)` puts every array element's braces at exactly
// two spaces of indent, and JSON escapes newlines inside strings — so a line
// that is exactly `  {` or `  }`/`  },` is an element boundary and nothing
// else. Counting braces instead would miscount the ones inside description
// text, which is how the first version of this script failed.
for await (const line of reader) {
  if (!inRecord) {
    if (line !== '  {') continue;
    inRecord = true;
    buffer = [line];
    continue;
  }
  buffer.push(line);
  if (line === '  }' || line === '  },') {
    inRecord = false;
    record(JSON.parse(buffer.join('\n').replace(/,$/, '')) as Row);
  }
}

const pct = (n: number, d: number): string => `${((n / (d || 1)) * 100).toFixed(1)}%`;

console.log(
  JSON.stringify(
    {
      runId,
      official: {
        ...official,
        collapseIntoAMirror: pct(official.canonicalWithAlsoFoundIn, official.canonical),
        canonicalShare: pct(official.canonical, official.total),
      },
      github: {
        ...github,
        canonicalShare: pct(github.canonical, github.total),
      },
      totals: {
        entries: official.total + github.total,
        canonicals: official.canonical + github.canonical,
        stillUnscanned: official.unscanned + github.unscanned,
      },
    },
    null,
    1,
  ),
);
