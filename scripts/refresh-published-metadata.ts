import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isIndexable, resolvePrerenderLimit, type Entry } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { buildSearchIndex } from '../pipeline/index/build-search-index';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(root, 'data');
const manifestPath = path.join(dataDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { generatedAt: string; totalEntries: number; catalogueShards?: Record<string, number>; artifacts: Array<{ path: string; byteSize: number; sha256: string; [key: string]: unknown }> };
const entries: Entry[] = [];
const shardFiles = manifest.artifacts.filter((artifact) => /^catalogue-\d+\.json$/.test(artifact.path));
for (const artifact of shardFiles) entries.push(...JSON.parse(fs.readFileSync(path.join(dataDir, artifact.path), 'utf8')) as Entry[]);

const quality = (entry: Entry) => {
  const integrations = Math.min(entry.structure?.integrations?.length ?? 0, 8) * 0.03;
  const nodes = Math.min(entry.structure?.nodeCount ?? 0, 60) * 0.01;
  const rights = entry.rights?.status === 'redistributable' ? 0.15 : 0;
  const description = entry.descriptionSource !== 'fallback' ? 0.15 : -0.1;
  const critical = entry.security?.grade === 'CRITICAL' ? -0.15 : 0;
  return 1 + integrations + nodes + rights + description + critical;
};
const indexable = entries.filter(isIndexable);
const prerendered = new Set(indexable.sort((a, b) => quality(b) - quality(a) || compareCanonicalStrings(a.id, b.id)).slice(0, resolvePrerenderLimit(process.env)).map((entry) => entry.id));
const catalogueShards: Record<string, number> = {};
for (const entry of entries) {
  entry.isPrerendered = prerendered.has(entry.id);
  // Never manufacture a model, prompt, or generated-at claim. Legacy records
  // without an auditable checkpoint are explicitly unknown and must be
  // regenerated before a strict release can promote them.
  if (!entry.descriptionProvenance) {
    entry.descriptionProvenance = entry.descriptionSource === 'upstream'
      ? { source: 'upstream' }
      : entry.descriptionSource === 'fallback'
        ? { source: 'fallback' }
        : { source: 'unknown' };
  }
}
for (const artifact of shardFiles) {
  const shard = Number(artifact.path.match(/\d+/)?.[0]);
  const start = shard * 2000;
  const shardEntries = entries.slice(start, start + 2000);
  for (const entry of shardEntries) catalogueShards[entry.id] = shard;
  fs.writeFileSync(path.join(dataDir, artifact.path), `${JSON.stringify(shardEntries, null, 2)}\n`, 'utf8');
}
const search = buildSearchIndex(entries);
fs.writeFileSync(path.join(dataDir, 'search-index.json'), search.serializedIndex, 'utf8');
fs.writeFileSync(path.join(dataDir, 'semantic-index.json'), search.semanticIndex.serializedIndex, 'utf8');
manifest.catalogueShards = catalogueShards;
manifest.totalEntries = entries.length;
for (const artifact of manifest.artifacts) {
  const file = path.join(dataDir, artifact.path);
  const bytes = fs.readFileSync(file);
  artifact.byteSize = bytes.length;
  artifact.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Refreshed ${entries.length} entries: ${prerendered.size} prerendered, ${entries.filter((entry) => entry.descriptionSource === 'generated').length} Gemini provenance records.`);
