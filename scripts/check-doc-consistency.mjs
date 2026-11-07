import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checkArchivedDocuments } from './lib/doc-consistency-archive.mjs';
import { checkDocument } from './lib/doc-consistency-document.mjs';
import { checkReferencedPaths } from './lib/doc-referenced-paths.mjs';

const root = resolve(import.meta.dirname, '..');
// This standalone checkout owns its workflows; parent files are not project evidence.
const alternateRoots = [];
const files = [
  'README.md',
  'STATUS.md',
  'docs/README.md',
  'docs/ARCHITECTURE.md',
  'docs/SECURITY.md',
  'docs/archive/README.md',
  'docs/DOCUMENTATION-MAINTENANCE.md',
  'docs/UI-WORKFLOW-PAGE.md',
  'docs/ENRICHMENT-POLICY.md',
  'docs/CONTENT-CONTRACT.md',
  'docs/DATA-LIFECYCLE.md',
  'docs/privacy.md',
  'docs/sources.md',
  'docs/takedown.md',
  'docs/SEARCH-QUALITY.md',
  'docs/search/semantic-search.md',
  'docs/recovery/2026-08-16-enrichment-recovery-runbook.md',
];
const forbidden = [
  /Gemini 3\.7 Flash receives deterministic fact packets/i,
  /PROMPT VERSION:\s*describe-system-v1/i,
  /full run is in progress/i,
];

/**
 * DOC-GATE-1 — the numbers in the prose must be numbers the data supports.
 *
 * The metadata, forbidden-phrase and link checks below were all passing while
 * `README.md` overstated the searchable catalogue by 6.7x, claimed a release
 * blocker that had been fixed, and stated a corpus size five entries wrong.
 * None of those is catchable by checking that a heading exists.
 *
 * The rule here binds a figure to **the claim it makes**, not to its shape. A
 * shape rule ("any comma-formatted 4-6 digit number must be a corpus value")
 * was the audit's suggestion and it is unusable: these documents legitimately
 * quote test counts, candidate totals, byte sizes and historical measurements.
 * Binding to the claim means `12,923 searchable` is checked against the
 * searchable total and `1,099 tests` is not checked at all, because it is not
 * making a claim about the corpus.
 *
 * Deliberately NOT sourced from `search-index.json`'s `documentCount`. That is
 * the primary tier — 2,000 — and a gate built on it would permit the exact
 * regression that shipped twice and reject the true figure. Corpus counts come
 * from `stats.json`; the searchable total comes from `analytics.json`, which is
 * the rule the app already follows.
 */
const analytics = JSON.parse(await readFile(join(root, 'data', 'analytics.json'), 'utf8'));
const stats = JSON.parse(await readFile(join(root, 'data', 'stats.json'), 'utf8'));

const CORPUS = {
  total: stats.totalEntries,
  searchable: analytics.searchable,
  redistributable: stats.redistributableCount,
  linkOnly: stats.linkOnlyCount,
  official: stats.officialCount,
};

const list = (keys) => keys.map((key) => `${key}=${CORPUS[key].toLocaleString('en-US')}`).join(', ');

/**
 * Each claim binds a captured figure to the corpus values it is allowed to be.
 *
 * `workflows` and `entries` accept **any** corpus value, because a sentence may
 * legitimately count the whole catalogue, the searchable part, the link-only
 * part, or the official part — "11,180 entries deep-link rather than download"
 * is true and well-phrased. The check that survives is the one that matters:
 * the figure must be *one of the real numbers*. `13,226` is not one, which is
 * the entire defect class this gate exists for.
 *
 * The single-word claims below stay tight, because `12,923 redistributable`
 * would be a real error rather than a wording preference.
 */
const ANY_CORPUS_VALUE = ['total', 'searchable', 'redistributable', 'linkOnly', 'official'];
const CLAIMS = [
  { label: 'searchable', re: /\b([\d,]{5,7})\s+(?:of\s+[\d,]{5,7}\s+)?searchable\b/gi, allow: ['searchable'] },
  { label: 'redistributable', re: /\b([\d,]{5,7})\s+redistributable\b/gi, allow: ['redistributable'] },
  { label: 'link-only', re: /\b([\d,]{5,7})\s+link-only\b/gi, allow: ['linkOnly'] },
  { label: 'official', re: /\b([\d,]{5,7})\s+official\b/gi, allow: ['official'] },
  {
    label: 'workflows',
    re: /\b([\d,]{5,7})(?:-|\s+)(?:[\w-]+\s+){0,5}?workflows?\b/gi,
    allow: ANY_CORPUS_VALUE,
  },
  { label: 'entries', re: /\b([\d,]{5,7})(?:-|\s+)entr(?:y|ies)\b/gi, allow: ANY_CORPUS_VALUE },
];

/**
 * Historical measurements are deliberately preserved and must not be rewritten
 * to today's corpus — that would destroy the audit trail. Everything from the
 * first `## Historical` heading onward is exempt.
 */
const errors = [];
for (const file of files) {
  errors.push(...await checkDocument({ root, file, forbidden, claims: CLAIMS, corpus: CORPUS }));
  errors.push(...await checkReferencedPaths({ root, file, alternateRoots }));
}

/**
 * DOC-GATE-2 also covers the agent-instruction files. They are not prose about
 * the product, they are instructions acted on by every contributor and every
 * agent, and a wrong one is worse than a missing one.
 */
for (const file of ['AGENTS.md']) {
  errors.push(...await checkReferencedPaths({ root, file, alternateRoots }));
}
errors.push(...await checkArchivedDocuments(join(root, 'docs', 'archive')));

if (errors.length) {
  console.error(`Documentation consistency failed:\n${errors.join('\n')}`);
  process.exit(1);
}
console.log(
  `Documentation consistency passed (${files.length} authoritative files checked; ` +
    `corpus figures verified against ${list(Object.keys(CORPUS))}).`,
);
