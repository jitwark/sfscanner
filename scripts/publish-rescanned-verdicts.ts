/**
 * Publish the rescanned `security` block for the 221 reachable redistributable rows (P3-1b, audit
 * F-001, owner RULING-1 = option B). P3-1a stamped the 67 rows whose upstream repository
 * `murataslan1/n8n-workflow-collection` was deleted `not-scanned/source_unavailable` and left their
 * verdicts published unaltered; this step re-derives the other 221 and replaces their stored verdicts.
 *
 * The derivation is the committed one, not a second scanner: `buildVerdictLedger`
 * (`pipeline/derive/verdict-ledger.ts`) classifies the rows and the `security` block comes from the
 * same `scanCandidate` → `scanWorkflowWithCore` path `pipeline/derive/derive-verdict-ledger.ts` uses,
 * every body reached through its row's `download` coordinates with the pointer sha256 verified first.
 * The engine identity is read from `packages/scanner-core/src/scanner-version.ts`, never hard-coded.
 *
 * Fail-closed before a byte is written: the 221/67 split and the 67's stamp hold; two derivation runs
 * are byte-identical over the full per-entry comparison; the derivation reproduces the 2026-09-25 audit
 * ledger's `old` and `new` digests for every row; the committed bytes are already in `_backups/` and
 * every non-`security` leaf survives the rewrite.
 *
 * Usage: node --import tsx scripts/publish-rescanned-verdicts.ts [--dry-run | --verify-shipped] — (no flag) derive
 * twice, prove and write · `--dry-run` the same evidence without writing · `--verify-shipped` assert a published tree
 * holds those verdicts; both publish modes refuse a published tree.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Candidate, Entry, EntrySecurity } from '@hub/contracts';
import { scanCandidate, getScannerVersion } from '../pipeline/scan/scan-entry.js';
import { scanWorkflowWithCore } from '../pipeline/scan/scanner-core-adapter.js';
import { buildVerdictLedger, type ResolvedBody, type VerdictLedgerRow } from '../pipeline/derive/verdict-ledger.js';
import { digestVerdict, projectionOf } from '../pipeline/derive/verdict-digest.js';
import { canonicalJson, sha256Hex } from './lib/scanner-result-digest.mjs';

const root = path.resolve(import.meta.dirname, '..');
const LEDGER_PATH = 'docs/audit/2026-09-25-verdict-ledger/verdict-ledger.json';
const FRESHNESS_PATH = 'scripts/scanner-result-freshness.json';
const MANIFEST_PATH = 'data/manifest.json';
const BACKUP_DIR = 'pipeline/.work/p3-20260927/_backups';
/** Distinct from P3-1a's copies, which hold the pre-stamp bytes and are never overwritten. */
const BACKUP_SUFFIX = '.p3-1b';
const STAMPED_REPO = 'murataslan1/n8n-workflow-collection';
const SUPERSEDED_STAMP = 'c998701';
const SHARD_LIMIT = 64;
/** The corpus's own `security` key order: the scanner emits `schemaVersion` first, the shards last. */
const SECURITY_KEY_ORDER = ['grade', 'score', 'counts', 'findings', 'hardenedExtra', 'scannerVersion', 'profile', 'schemaVersion', 'analysisStatus', 'analysisDiagnosticCodes'];

type Derived = { id: string; security: EntrySecurity; bodySha256: string };
type Shard = { file: string; entries: Entry[] };

const readJson = <T,>(relative: string): T => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')) as T;

/** Ordering only: no key is added, dropped or altered, and the verdict digest sorts keys anyway. */
function orderedSecurity(security: EntrySecurity): EntrySecurity {
  const source = security as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of SECURITY_KEY_ORDER) if (Object.hasOwn(source, key)) ordered[key] = source[key];
  for (const key of Object.keys(source)) if (!Object.hasOwn(ordered, key)) ordered[key] = source[key];
  return ordered as unknown as EntrySecurity;
}

/** Everything about an entry except its `security` block, in the digest's canonical encoding. */
function withoutSecurity(entry: Entry): string {
  const { security: _security, ...rest } = entry;
  return canonicalJson(rest);
}

function readShards(): Shard[] {
  const shards: Shard[] = [];
  for (let index = 0; index < SHARD_LIMIT; index += 1) {
    const file = path.join('data', `catalogue-${index}.json`);
    if (!fs.existsSync(path.join(root, file))) break;
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    const entries = JSON.parse(content) as Entry[];
    if (JSON.stringify(entries, null, 2) !== content) throw new Error(`${file} is not the corpus's own 2-space serialization — refusing to rewrite it`);
    shards.push({ file, entries });
  }
  if (shards.length === 0) throw new Error('no catalogue shards found under data/ — run from the workspace root');
  return shards;
}

/** Pack lines are read once per pack and cached; the body digest is the line's own sha256. */
function makeBodyResolver(): (entry: Entry) => ResolvedBody | null {
  const packs = new Map<number, string[]>();
  return (entry) => {
    const download = entry.download;
    if (download === undefined) return null;
    if (!packs.has(download.pack)) {
      packs.set(download.pack, fs.readFileSync(path.join(root, 'data', 'packs', `pack-${download.pack}.jsonl`), 'utf8').split('\n'));
    }
    const line = packs.get(download.pack)?.[download.line];
    if (line === undefined) return null;
    const bodySha256 = sha256Hex(line);
    if (download.sha256 !== undefined && download.sha256 !== bodySha256) {
      throw new Error(`body digest mismatch for ${entry.id}: download pointer says ${download.sha256}, pack line hashes to ${bodySha256}`);
    }
    const parsed = JSON.parse(line) as { workflow?: unknown };
    return { body: parsed.workflow ?? parsed, bodySha256 };
  };
}

function makeScanner(engineIdentity: string): (entry: Entry, body: unknown) => Promise<EntrySecurity> {
  // `Candidate` is wider than what the scanner reads (`id`, `json`, `rights.status`), as in `derive-verdict-ledger.ts`.
  return (entry, body) =>
    scanCandidate({ id: entry.id, json: body, rights: entry.rights } as unknown as Candidate, {
      scan: (workflow, options) => scanWorkflowWithCore(workflow, options),
      scannerVersion: engineIdentity,
    });
}

async function deriveAll(
  entries: Entry[], engineIdentity: string,
  resolveBody: (entry: Entry) => ResolvedBody | null,
  scan: (entry: Entry, body: unknown) => Promise<EntrySecurity>,
): Promise<Derived[]> {
  const derived: Derived[] = [];
  for (const entry of entries) {
    const resolved = resolveBody(entry);
    if (resolved === null) throw new Error(`${entry.id}: no committed body resolved through its download pointer`);
    const security = orderedSecurity(await scan(entry, resolved.body));
    if (security.scannerVersion !== engineIdentity) {
      throw new Error(`${entry.id}: the scan reported stamp '${security.scannerVersion}', expected the engine identity '${engineIdentity}'`);
    }
    if (Object.keys(security).some((key) => !SECURITY_KEY_ORDER.includes(key))) {
      throw new Error(`${entry.id}: the rescanned block carries an unknown key (${Object.keys(security).join()})`);
    }
    derived.push({ id: entry.id, security, bodySha256: resolved.bodySha256 });
  }
  return derived;
}

const mode = process.argv.includes('--verify-shipped') ? 'verify' : process.argv.includes('--dry-run') ? 'dry-run' : 'write';
const versionSource = fs.readFileSync(path.join(root, 'packages/scanner-core/src/scanner-version.ts'), 'utf8');
const engineIdentity = /SCANNER_VERSION\s*=\s*'([^']+)'/.exec(versionSource)?.[1] ?? null;
if (engineIdentity === null) throw new Error('SCANNER_VERSION could not be read from packages/scanner-core/src/scanner-version.ts');
if (getScannerVersion() !== engineIdentity) {
  throw new Error(`the scan adapter reports '${getScannerVersion()}' but scanner-version.ts declares '${engineIdentity}'`);
}
const shards = readShards();
const entries = shards.flatMap((shard) => shard.entries);
const redistributable = entries.filter((entry) => entry.rights.status === 'redistributable');
const stamped = redistributable.filter((entry) => entry.source.repo === STAMPED_REPO);
const reachable = redistributable.filter((entry) => entry.source.repo !== STAMPED_REPO);
if (stamped.length !== 67 || reachable.length !== 221 || stamped.length + reachable.length !== redistributable.length) {
  throw new Error(`expected a 221/67 split of ${redistributable.length} redistributable rows, measured ${reachable.length}/${stamped.length}`);
}
for (const entry of stamped) {
  if (entry.security.scannerVersion !== 'not-scanned' || entry.security.stampReason !== 'source_unavailable') {
    throw new Error(`${entry.id}: a stamped row does not carry not-scanned/source_unavailable`);
  }
}
const publishedStamp = mode === 'verify' ? engineIdentity : SUPERSEDED_STAMP;
for (const entry of reachable) {
  if (entry.security.scannerVersion !== publishedStamp) {
    throw new Error(`${entry.id}: expected stamp '${publishedStamp}', found '${entry.security.scannerVersion}'`);
  }
}
const resolveBody = makeBodyResolver();
const scan = makeScanner(engineIdentity);
const freshness = readJson<{ recordedResultStamps: Array<{ value: string; kind: string }> }>(FRESHNESS_PATH);
const manifest = readJson<{ generatedAt: string; metadata: { corpusSha256: string } }>(MANIFEST_PATH);
const storedById = new Map(entries.map((entry) => [entry.id, entry]));
const first = await deriveAll(reachable, engineIdentity, resolveBody, scan);
const payload = (rows: Derived[]) => rows.map(({ id, security }) => ({ id, security }));
const canonicalFirst = canonicalJson(payload(first));
const serializedFirst = JSON.stringify(payload(first));

if (mode === 'verify') {
  for (const { id, security } of first) if (canonicalJson(storedById.get(id)!.security) !== canonicalJson(security)) throw new Error(`${id}: the shipped block is not the derived one`);
  console.log(`verify-shipped: ${first.length} reachable rows hold the derived verdicts (sha256:${sha256Hex(canonicalFirst)})`);
  process.exit(0);
}

const second = await deriveAll(reachable, engineIdentity, resolveBody, scan);
const canonicalSecond = canonicalJson(payload(second));
if (canonicalFirst !== canonicalSecond || serializedFirst !== JSON.stringify(payload(second))) {
  throw new Error('two derivation runs over the 221 are not byte-identical — refusing to publish');
}

const derivedById = new Map(first.map((row) => [row.id, row]));
const ledger = await buildVerdictLedger({
  entries: reachable,
  resolveBody,
  scan,
  scanner: { value: engineIdentity, kind: freshness.recordedResultStamps.find((stamp) => stamp.value === engineIdentity)?.kind ?? 'engine-identity' },
  recordedStamps: freshness.recordedResultStamps,
  derivedAt: manifest.generatedAt,
  corpus: { manifestSha256: manifest.metadata.corpusSha256, totalEntries: entries.length, linkOnly: entries.length - redistributable.length },
  recordedRescan: null,
  superseded: null,
});

// Reconcile: the published block must be the derivation the 2026-09-25 audit ledger recorded, both
// halves — its `old` (what ships today) and its `new` (what the current engine makes of the body).
const auditById = new Map(readJson<{ rows: VerdictLedgerRow[] }>(LEDGER_PATH).rows.map((row) => [row.id, row]));
for (const { id, security, bodySha256 } of first) {
  const audit = auditById.get(id);
  if (audit === undefined || audit.key.bodySha256 !== bodySha256) throw new Error(`${id}: not the audit ledger's row (body digest ${bodySha256})`);
  if (audit.old === null || audit.old.resultDigest !== digestVerdict(projectionOf(storedById.get(id)!.security))) throw new Error(`${id}: the stored verdict does not reproduce the ledger's old digest`);
  if (audit.new === null || audit.new.resultDigest !== digestVerdict(projectionOf(security))) throw new Error(`${id}: the derived verdict does not reproduce the ledger's new digest`);
  if (audit.new.grade !== security.grade) throw new Error(`${id}: derived grade ${security.grade} != ledger new grade ${audit.new.grade}`);
}

const tally = (key: (row: VerdictLedgerRow) => string) => {
  const out: Record<string, number> = {};
  for (const row of ledger.rows) out[key(row)] = (out[key(row)] ?? 0) + 1;
  return out;
};
const changed = ledger.rows.filter((row) => row.changed.verdict);
const texts = shards.map((shard) => JSON.stringify(shard.entries.map((entry) => {
  const derived = derivedById.get(entry.id);
  return derived === undefined ? entry : { ...entry, security: derived.security };
}), null, 2));
const digests: Record<string, { before: string; after: string; rowsTouched: number }> = {};
// Validate everything — and the backups — before the first byte is written, so a failure anywhere
// leaves the committed corpus untouched.
shards.forEach((shard, position) => {
  const text = texts[position]!;
  const current = fs.readFileSync(path.join(root, shard.file));
  digests[shard.file] = { before: sha256Hex(current.toString('utf8')), after: sha256Hex(text), rowsTouched: shard.entries.filter((entry) => derivedById.has(entry.id)).length };
  // The write surface is the 221 `security` blocks: every other leaf of every entry must survive.
  const written = JSON.parse(text) as Entry[];
  if (written.length !== shard.entries.length) throw new Error(`${shard.file}: entry count moved`);
  written.forEach((entry, index) => {
    const stored = shard.entries[index]!;
    if (entry.id !== stored.id) throw new Error(`${shard.file}: entry order moved at ${index}`);
    if (withoutSecurity(entry) !== withoutSecurity(stored)) throw new Error(`${entry.id}: a non-security leaf moved`);
    const derived = derivedById.get(entry.id);
    if (canonicalJson(entry.security) !== canonicalJson(derived === undefined ? stored.security : derived.security)) throw new Error(`${entry.id}: the written block is not the derived one`);
  });
  if (mode === 'write') {
    const backup = path.join(root, BACKUP_DIR, `${path.basename(shard.file)}${BACKUP_SUFFIX}`);
    if (!fs.existsSync(backup) || !fs.readFileSync(backup).equals(current)) throw new Error(`${shard.file}: no intact backup in ${BACKUP_DIR} — copy the committed bytes before publishing`);
  }
});
if (mode === 'write') shards.forEach((shard, position) => fs.writeFileSync(path.join(root, shard.file), texts[position]!));

console.log(JSON.stringify({
  mode,
  engineIdentity,
  rows: { total: entries.length, redistributable: redistributable.length, reachable: reachable.length, stamped: stamped.length },
  determinism: { canonical: `sha256:${sha256Hex(canonicalFirst)}`, identical: canonicalFirst === canonicalSecond },
  reconciliation: { rows: ledger.rows.length, identical: ledger.rows.length - changed.length, different: changed.length },
  changedIds: changed.map((row) => row.id),
  claimClasses: tally((row) => row.claim.class),
  dispositions: tally((row) => row.disposition),
  gradeTransitions: tally((row) => `${row.claim.storedGrade} -> ${row.claim.rescannedGrade}`),
  keyShapes: tally((row) => Object.keys(derivedById.get(row.id)!.security).join()),
  /** A published claim that increases: the rescanned verdict raises the grade or adds a finding. */
  increasedClaims: changed.filter((row) => row.claim.grade === 'raised' || row.claim.findingsAdded > 0).map((row) => ({ id: row.id, grade: row.claim.grade, findingsAdded: row.claim.findingsAdded, findingsRemoved: row.claim.findingsRemoved, disposition: row.disposition })),
  shards: digests,
}, null, 2));
console.log(`${mode}: ${mode === 'write' ? 'wrote' : 'would write'} ${Object.keys(digests).length} shards, ${first.length} rows published at '${engineIdentity}'`);
