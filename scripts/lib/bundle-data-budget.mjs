import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export const DATA_BUDGET_MB = 2.5;
export const EAGER = [
  'search-index.json',   // the lexical index; warm-up fetches it on idle
  'facets.json',         // bitsets + ordinals; the worker needs both at init
];
export const DEFERRED = [
  // 1.56 MB gzip, larger than the primary index itself. Fetched on the first
  // tokenised query, not during warm-up.
  'semantic-index.json',
  // 3.44 MB gzip: the 10,923 entries beyond the content-indexed top tier.
  // Fetched once the primary index is answering, never before it.
  'search-index-extended.json',
  // Per-page, and never on the search path.
  'manifest.json', 'stats.json', 'analytics.json',
];
export const DEFERRED_PREFIXES = ['charts/', 'packs/', 'catalogue-'];

export async function gzipSize(outDir, relativePath) {
  const bytes = await readFile(join(outDir, 'data', relativePath)).catch(() => null);
  return bytes ? gzipSync(bytes).length : null;
}

export async function referencedDataFiles(outDir) {
  const { readdir } = await import('node:fs/promises');
  const chunkDir = join(outDir, '_next', 'static', 'chunks');
  const names = await readdir(chunkDir).catch(() => []);
  const found = new Set();
  for (const name of names) {
    if (!name.endsWith('.js')) continue;
    const source = await readFile(join(chunkDir, name), 'utf8').catch(() => '');
    for (const match of source.matchAll(/\/data\/([A-Za-z0-9._/-]+\.json)/g)) found.add(match[1]);
  }
  return [...found];
}
