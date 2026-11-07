import fs from 'node:fs';
import path from 'node:path';
import { MAX_FALLBACK_PACK_BYTES } from '../app/src/catalogue/download-limits.mjs';
import { auditRightsInvariant } from './lib/rights-invariant.mjs';

/**
 * Prove, against the packaged artifacts, what the release records about the
 * rights it publishes.
 *
 * Reads the catalogue shards, the packs and — when one is present — the
 * rights-evidence journal, and asks the two questions the project's rights
 * control depends on:
 *
 *   1. does a workflow body travel with an entry whose record does not carry
 *      `redistributable`?
 *   2. does an entry that does carry `redistributable` have recorded per-item
 *      licence evidence behind that claim?
 *
 * Question 2 is the one the release currently fails: the packaged artifacts
 * record no same-commit licence-instrument digest, so every redistribution
 * claim in them is unevidenced until a journal records the basis. That report
 * is the finding, not a build defect, and it is the rights holder's decision
 * what happens to those rows.
 *
 *   node scripts/check-rights-invariant.mjs [dataDir] [rightsEvidenceJournal]
 *
 * The journal defaults to `<dataDir>/rights-evidence.jsonl`; naming a path that
 * does not exist fails rather than passing on an empty journal.
 */
const dataDir = path.resolve(process.argv[2] ?? 'data');
const journalArgument = process.argv[3];
const journalPath = path.resolve(journalArgument ?? path.join(dataDir, 'rights-evidence.jsonl'));

const entries = [];
for (let shard = 0; ; shard += 1) {
  const cataloguePath = path.join(dataDir, `catalogue-${shard}.json`);
  if (!fs.existsSync(cataloguePath)) break;
  entries.push(...JSON.parse(fs.readFileSync(cataloguePath, 'utf8')));
}

if (entries.length === 0) {
  console.error(`Rights invariant gate failed: no catalogue shards found in ${dataDir}.`);
  process.exit(1);
}

/**
 * The rights-evidence journal, one JSON row per rights decision.
 *
 * Absent means absent: the audit reports every redistribution claim as
 * unevidenced, which is what the artifacts then record. A path that was named
 * explicitly and is not there is an error, because a typo must not read as "no
 * claims to check". A row that cannot be read, or a second row for one entry,
 * is an error for the same reason: the journal would no longer describe a
 * single decision per entry.
 */
function readEvidenceJournal() {
  if (!fs.existsSync(journalPath)) {
    if (journalArgument !== undefined) {
      console.error(`Rights invariant gate failed: rights-evidence journal not found at ${journalPath}.`);
      process.exit(1);
    }
    return [];
  }
  const rows = [];
  const seen = new Set();
  const lines = fs.readFileSync(journalPath, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      console.error(`Rights invariant gate failed: rights-evidence journal line ${index + 1} is not JSON.`);
      process.exit(1);
    }
    if (typeof row?.id !== 'string' || row.id === '') {
      console.error(`Rights invariant gate failed: rights-evidence journal line ${index + 1} carries no entry id.`);
      process.exit(1);
    }
    if (seen.has(row.id)) {
      console.error(`Rights invariant gate failed: rights-evidence journal records ${row.id} more than once.`);
      process.exit(1);
    }
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

/**
 * Which entries actually have a body in the packs.
 *
 * The pack record's own `id` is the workflow's n8n id, a different id space
 * from the catalogue entry id, so the pairing runs the other way: an entry's
 * `download` coordinates are read and the line at that position is required to
 * parse. An entry claiming a download that does not resolve is as much a defect
 * as a link-only entry that ships one.
 */
const packContents = new Map();
const packedIds = [];
for (const entry of entries) {
  const download = entry.download;
  if (!download || typeof download.pack !== 'number' || typeof download.line !== 'number') continue;
  if (!packContents.has(download.pack)) {
    const packPath = path.join(dataDir, 'packs', `pack-${download.pack}.jsonl`);
    packContents.set(
      download.pack,
      fs.existsSync(packPath) ? fs.readFileSync(packPath, 'utf8').split(String.fromCharCode(10)) : [],
    );
  }
  const line = packContents.get(download.pack)[download.line];
  if (typeof line !== 'string' || line.length === 0) continue;
  try {
    JSON.parse(line);
    packedIds.push(entry.id);
  } catch {
    // An unparseable line is not a body anyone can use; the entry will be
    // reported as redistributable with no packed body.
  }
}

const evidenceRecords = readEvidenceJournal();

/**
 * The manifest the reader resolves download coordinates against.
 *
 * A redistributable entry's `download` is only servable if this manifest
 * declares the pack and agrees with the offset/length the entry records, so the
 * gate cannot answer the rights question without it. Absent means absent: the
 * audit then reports every redistributable download as undeclared instead of
 * skipping the check.
 */
const manifestPath = path.join(dataDir, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;

const { violations, linkOnly, redistributable, unevidencedClaims } = auditRightsInvariant({
  entries,
  packWorkflowIds: packedIds,
  evidenceRecords,
  journalPath: fs.existsSync(journalPath) ? journalPath : null,
  manifest,
  maxFallbackBytes: MAX_FALLBACK_PACK_BYTES,
});

console.log(
  `Rights invariant checked: ${entries.length} entries — ${linkOnly} link-only, ${redistributable} redistributable.`,
);
console.log(
  `Redistribution evidence: ${redistributable - unevidencedClaims} of ${redistributable} redistributable rows ` +
    `have recorded per-item licence evidence (journal: ${fs.existsSync(journalPath) ? journalPath : 'none found'}).`,
);

if (violations.length > 0) {
  console.error(`Rights invariant gate FAILED: ${violations.length} violation(s).`);
  console.error('Each violation names what the artifacts record. Resolving them is a rights decision, not a build step.');
  for (const violation of violations.slice(0, 25)) console.error(`  ${violation}`);
  if (violations.length > 25) console.error(`  ... ${violations.length - 25} more`);
  process.exit(1);
}

console.log('Rights invariant gate passed: no workflow body ships with an entry that may not be redistributed, and every redistribution claim has recorded per-item licence evidence.');
