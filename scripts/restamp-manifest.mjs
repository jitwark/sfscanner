/**
 * Re-stamp `data/manifest.json` byte sizes, hashes, and derivable entry counts
 * against what is actually on disk.
 *
 * This exists because a manifest stamp can go stale without any artifact being
 * wrong: `analytics.json` was regenerated and copied to both `data/` and
 * `app/public/data/`, so `check:data-sync` (which compares the two copies to
 * each other) stayed green while `check:corpus` (which compares to the
 * manifest) went red. Re-running the whole packaging pipeline to fix a
 * bookkeeping drift is not proportionate.
 *
 * It re-stamps metadata only. It never edits artifact content, and it prints
 * every change so the diff is reviewable rather than silent.
 *
 *   node scripts/restamp-manifest.mjs [dataDir] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const dataArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const dataDir = path.resolve(dataArgument ?? path.join(root, 'data'));
const dryRun = process.argv.includes('--dry-run');

const manifestPath = path.join(dataDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

/**
 * Counts that can be measured from the artifact itself are measured. A count
 * that is merely asserted is how `search-index.json` came to claim 13,221
 * documents over an index holding 1,962.
 */
function derivedEntryCount(relativePath, bytes) {
  if (relativePath === 'search-index.json' || relativePath === 'search-index-extended.json') {
    return JSON.parse(bytes.toString('utf8')).documentCount ?? null;
  }
  if (relativePath === 'semantic-index.json') {
    return JSON.parse(bytes.toString('utf8')).documents?.length ?? null;
  }
  if (relativePath === 'analytics.json') {
    return JSON.parse(bytes.toString('utf8')).total ?? null;
  }
  if (relativePath === 'stats.json') {
    return JSON.parse(bytes.toString('utf8')).totalEntries ?? null;
  }
  if (relativePath.endsWith('.jsonl')) {
    return bytes.toString('utf8').split('\n').filter((line) => line.trim()).length;
  }
  if (/^catalogue-\d+\.json$/.test(relativePath)) {
    const parsed = JSON.parse(bytes.toString('utf8'));
    return Array.isArray(parsed) ? parsed.length : null;
  }
  return null;
}

const changes = [];
for (const artifact of manifest.artifacts ?? []) {
  const absolute = path.join(dataDir, artifact.path);
  if (!fs.existsSync(absolute)) {
    changes.push(`MISSING  ${artifact.path} — on disk: no. Left untouched.`);
    continue;
  }
  const bytes = fs.readFileSync(absolute);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

  if (artifact.byteSize !== bytes.length) {
    changes.push(`size     ${artifact.path}: ${artifact.byteSize} -> ${bytes.length}`);
    artifact.byteSize = bytes.length;
  }
  if (artifact.sha256 !== sha256) {
    changes.push(`sha256   ${artifact.path}: ${String(artifact.sha256).slice(0, 12)}… -> ${sha256.slice(0, 12)}…`);
    artifact.sha256 = sha256;
  }
  const derived = derivedEntryCount(artifact.path, bytes);
  if (derived !== null && artifact.entryCount !== derived) {
    changes.push(`count    ${artifact.path}: ${artifact.entryCount} -> ${derived} (measured)`);
    artifact.entryCount = derived;
  }
}

if (changes.length === 0) {
  console.log('Manifest is already consistent with the artifacts on disk.');
  process.exit(0);
}

console.log(`Manifest re-stamp: ${changes.length} change(s)${dryRun ? ' (dry run, nothing written)' : ''}`);
for (const change of changes) console.log(`  ${change}`);

if (dryRun) process.exit(0);

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`\nWrote ${path.relative(root, manifestPath)}. Run 'npm run sync:data' then 'npm run check:corpus'.`);
