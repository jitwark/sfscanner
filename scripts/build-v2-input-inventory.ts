/**
 * Re-derives the C1 `corpus-v2-input-inventory-v1` receipt from the bytes actually present, then
 * optionally hydrates the rows the previous inventory could not bind from their recorded pinned
 * source (repo + commit + path). No repository is cloned and no source is inferred: a row is bound
 * only when the recorded commit/path resolves and the fetched bytes parse as workflow JSON.
 *
 * Usage: node --import tsx scripts/build-v2-input-inventory.ts
 *          [--data data] [--map pipeline/.work/official-body-map.json]
 *          [--out pipeline/.work/v2-input-inventory.json]
 *          [--cache pipeline/.work/v2-hydration] [--no-hydrate]
 *          [--rulings docs/audit/2026-10-17-remediation/C1-real-inventory.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Entry } from '@hub/contracts';
import { hydrationCacheFileName } from './lib/v2-hydration-cache.js';
import {
  inventoryCorpusV2Inputs,
  type CorpusV2InputSource,
} from './lib/corpus-v2-input-inventory.js';

type BodyMapRow = { templateId: number; file: string; sourceDir: string; entryId: string };
type BodyMap = { rows: BodyMapRow[] };
type PriorRow = { entryId: string; status: string; reasonCode: string | null };
type PriorInventory = { rows: PriorRow[] } | { inventory: { rows: PriorRow[] } };

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const repoRoot = path.resolve(import.meta.dirname, '..');
const dataDir = path.resolve(flag('data') ?? path.join(repoRoot, 'data'));
const mapPath = path.resolve(flag('map') ?? path.join(repoRoot, 'pipeline/.work/official-body-map.json'));
const outPath = path.resolve(flag('out') ?? path.join(repoRoot, 'pipeline/.work/v2-input-inventory.json'));
const cacheDir = path.resolve(flag('cache') ?? path.join(repoRoot, 'pipeline/.work/v2-hydration'));
const rulingsPath = path.resolve(flag('rulings') ?? path.join(repoRoot, 'docs/audit/2026-10-17-remediation/C1-real-inventory.json'));
const hydrate = !process.argv.includes('--no-hydrate');

function readEntries(): Entry[] {
  const entries: Entry[] = [];
  for (let shard = 0; ; shard += 1) {
    const file = path.join(dataDir, `catalogue-${shard}.json`);
    if (!fs.existsSync(file)) break;
    entries.push(...(JSON.parse(fs.readFileSync(file, 'utf8')) as Entry[]));
  }
  return entries;
}

async function fetchPinned(repo: string, commit: string, sourcePath: string): Promise<Uint8Array | null> {
  const url = `https://raw.githubusercontent.com/${repo}/${commit}/${sourcePath.split('/').map(encodeURIComponent).join('/')}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (response.status !== 200) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return parsed !== null && typeof parsed === 'object' ? bytes : null;
  } catch {
    return null;
  }
}

async function hydrateMissing(entries: Entry[], bound: Set<string>): Promise<{ bound: number; failed: number }> {
  fs.mkdirSync(cacheDir, { recursive: true });
  const candidates = entries.filter((entry) => !bound.has(entry.id) && entry.source.kind === 'github'
    && entry.source.repo && entry.source.commit && entry.source.path);
  let recovered = 0;
  let failed = 0;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      const entry = candidates[index];
      if (entry === undefined) return;
      const { repo, commit, path: sourcePath } = entry.source;
      if (!repo || !commit || !sourcePath) { failed += 1; continue; }
      const target = path.join(cacheDir, hydrationCacheFileName(entry.id, repo, commit, sourcePath));
      if (!fs.existsSync(target)) {
        const bytes = await fetchPinned(repo, commit, sourcePath);
        if (bytes === null) { failed += 1; continue; }
        fs.writeFileSync(target, bytes);
      }
      recovered += 1;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { bound: recovered, failed };
}

const entries = readEntries();
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as BodyMap;
const priorDocument = JSON.parse(fs.readFileSync(rulingsPath, 'utf8')) as PriorInventory;
const priorRows: PriorRow[] = 'rows' in priorDocument ? priorDocument.rows : priorDocument.inventory.rows;
const ruled = new Set(priorRows.filter((row) => row.reasonCode === 'RULING-1').map((row) => row.entryId));
const entryOf = new Map(entries.map((entry) => [entry.id, entry]));

const sources: CorpusV2InputSource[] = map.rows.map((row) => ({
  entryId: row.entryId,
  localPath: path.join(row.sourceDir, row.file),
  approvedRoot: row.sourceDir,
  approvalRecord: 'official-body-map-v1',
  identity: { kind: 'OFFICIAL_TEMPLATE', templateId: row.templateId, sourceDir: row.sourceDir, file: row.file },
  expectedIdentity: { kind: 'OFFICIAL_TEMPLATE', templateId: row.templateId, sourceDir: row.sourceDir, file: row.file },
  expectedSha256: null,
  rightsEvidenceRef: 'official-body-map-v1',
}));
const bound = new Set(sources.map((source) => source.entryId));

for (const entryId of ruled) {
  const entry = entryOf.get(entryId);
  if (entry === undefined) continue;
  const source = entry.source;
  sources.push({
    entryId,
    localPath: path.join(cacheDir, 'ruled-unavailable.json'),
    approvedRoot: cacheDir,
    approvalRecord: 'C1 RULING-1',
    identity: {
      kind: 'GITHUB',
      sourceRepo: source.repo ?? 'ruled',
      sourceCommit: source.commit ?? 'unavailable',
      sourcePath: source.path ?? `unavailable/${entryId}.json`,
    },
    expectedSha256: null,
    rightsEvidenceRef: 'RULING-1',
    ownerRuledUnavailable: 'RULING-1',
  });
  bound.add(entryId);
}

const hydration = hydrate ? await hydrateMissing(entries, bound) : { bound: 0, failed: 0 };
if (hydrate) {
  for (const entry of entries) {
    if (bound.has(entry.id)) continue;
    if (!entry.source.repo || !entry.source.commit || !entry.source.path) continue;
    const target = path.join(cacheDir, hydrationCacheFileName(entry.id, entry.source.repo, entry.source.commit, entry.source.path));
    if (!fs.existsSync(target)) continue;
    sources.push({
      entryId: entry.id,
      localPath: target,
      approvedRoot: cacheDir,
      approvalRecord: `pinned-source:${entry.source.repo}@${entry.source.commit}`,
      identity: { kind: 'GITHUB', sourceRepo: entry.source.repo, sourceCommit: entry.source.commit, sourcePath: entry.source.path },
      expectedIdentity: { kind: 'GITHUB', sourceRepo: entry.source.repo, sourceCommit: entry.source.commit, sourcePath: entry.source.path },
      expectedSha256: null,
      rightsEvidenceRef: 'pinned-source-hydration-v1',
    });
  }
}

const inventory = inventoryCorpusV2Inputs(entries, sources, (localPath) => {
  try {
    return new Uint8Array(fs.readFileSync(localPath));
  } catch {
    return undefined;
  }
});
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  out: path.relative(repoRoot, outPath),
  counts: inventory.counts,
  inventorySha256: inventory.inventorySha256,
  hydration,
}, null, 2));
