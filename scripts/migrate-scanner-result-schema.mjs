import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  SCHEMA_VERSION,
  migrateEntry,
  nextGeneratedAt,
  requireMigrationTimestamp,
} from './lib/scanner-result-schema-migration.mjs';

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

// Fail closed before touching a single file — see requireMigrationTimestamp's
// doc comment for why this can't wait until we know whether anything changed.
const timestamp = requireMigrationTimestamp(arg('--generated-at'));

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(root, 'data');
const manifestPath = path.join(dataDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

let migrated = 0;
const changedArtifacts = new Set();
for (const artifact of manifest.artifacts ?? []) {
  if (/^catalogue-\d+\.json$/.test(artifact.path)) {
    const file = path.join(dataDir, artifact.path);
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    let changed = false;
    entries.forEach((entry, index) => { if (migrateEntry(entry, artifact.path, index + 1)) { migrated += 1; changed = true; } });
    if (changed) {
      fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
      changedArtifacts.add(artifact.path);
    }
  } else if (/^details\/detail-\d+\.jsonl$/.test(artifact.path)) {
    const file = path.join(dataDir, artifact.path);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let changed = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      const entry = JSON.parse(lines[index]);
      if (migrateEntry(entry, artifact.path, index + 1)) { lines[index] = JSON.stringify(entry); migrated += 1; changed = true; }
    }
    if (changed) { fs.writeFileSync(file, lines.join('\n'), 'utf8'); changedArtifacts.add(artifact.path); }
    const indexPath = path.join(dataDir, artifact.path.replace(/\.jsonl$/, '').replace('detail-', 'detail-index-') + '.json');
    const index = {};
    let offset = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      const bytes = Buffer.from(line, 'utf8');
      index[entry.id] = { offset, length: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
      offset += bytes.length + 1;
    }
    const serializedIndex = JSON.stringify(index);
    if (fs.readFileSync(indexPath, 'utf8') !== serializedIndex) {
      fs.writeFileSync(indexPath, serializedIndex, 'utf8');
      changedArtifacts.add(path.relative(dataDir, indexPath).replaceAll(path.sep, '/'));
    }
  }
}

for (const artifact of manifest.artifacts ?? []) {
  const bytes = fs.readFileSync(path.join(dataDir, artifact.path));
  artifact.byteSize = bytes.length;
  artifact.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
}
manifest.generatedAt = nextGeneratedAt({
  previousGeneratedAt: manifest.generatedAt,
  changed: changedArtifacts.size > 0,
  timestamp,
});
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Migrated ${migrated} scanner result record(s) across ${changedArtifacts.size} artifact(s) to ${SCHEMA_VERSION}.`);
