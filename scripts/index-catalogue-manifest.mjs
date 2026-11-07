import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.resolve(process.argv[2] ?? path.join(root, 'data'));
const manifestPath = path.join(dataDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/\\n\s*$/, ''));
const catalogueShards = {};
for (const artifact of manifest.artifacts ?? []) {
  if (!artifact.path.startsWith('catalogue-') || !artifact.path.endsWith('.json')) continue;
  const shard = Number(artifact.path.slice('catalogue-'.length, -'.json'.length));
  if (!Number.isInteger(shard) || shard < 0) throw new Error(`Malformed catalogue artifact: ${artifact.path}`);
  const entries = JSON.parse(fs.readFileSync(path.join(dataDir, artifact.path), 'utf8'));
  if (!Array.isArray(entries)) throw new Error(`Catalogue artifact is not an array: ${artifact.path}`);
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) throw new Error(`Catalogue entry missing id: ${artifact.path}`);
    if (catalogueShards[entry.id] !== undefined) throw new Error(`Duplicate catalogue entry ID: ${entry.id}`);
    catalogueShards[entry.id] = shard;
  }
}
manifest.catalogueShards = catalogueShards;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Indexed ${Object.keys(catalogueShards).length} catalogue entries in ${manifestPath}`);
