/**
 * Filesystem glue for the public-dataset exporter: reads the committed
 * corpus (`data/catalogue-N.json`, `data/manifest.json`, `data/analytics.json`,
 * `data/packs/pack-N.jsonl`) into the plain shapes the pure lib functions and
 * `buildPublicProjection` consume. No policy lives here — see
 * `public-dataset-analytics-check.ts` and `public-dataset-release-metadata.ts`
 * for the logic this feeds.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Entry } from '@hub/contracts';
import type { AnalyticsCounts } from './public-dataset-analytics-check.js';

/** Reads every `catalogue-N.json` shard in order, stopping at the first gap — the same shard-globbing convention as `scripts/repackage-from-data.ts` and `scripts/derive-analytics.ts`. */
export function readCatalogueEntries(dataDir: string): Entry[] {
  const entries: Entry[] = [];
  for (let shard = 0; ; shard += 1) {
    const shardPath = path.join(dataDir, `catalogue-${shard}.json`);
    if (!fs.existsSync(shardPath)) break;
    entries.push(...(JSON.parse(fs.readFileSync(shardPath, 'utf8')) as Entry[]));
  }
  if (entries.length === 0) throw new Error(`Public dataset export: no catalogue shards found in ${dataDir}`);
  return entries;
}

export function readAnalytics(dataDir: string): AnalyticsCounts {
  const analytics = JSON.parse(fs.readFileSync(path.join(dataDir, 'analytics.json'), 'utf8')) as AnalyticsCounts;
  return { total: analytics.total, searchable: analytics.searchable, rights: analytics.rights };
}

export type CorpusManifest = {
  generatedAt: string;
  artifacts: import('../../pipeline/export/preflight-sidecar.js').PreflightManifestArtifact[];
  totalEntries: number;
  metadata: { corpusId: string; corpusSha256: string; scannerVersion: string; generatedAt: string };
};

/** `manifestSha256` hashes the manifest file's own bytes, exactly as `pipeline/package/manifest.ts` does when it first writes and stamps the file. */
export function readManifest(dataDir: string): { manifest: CorpusManifest; manifestSha256: string } {
  const manifestBytes = fs.readFileSync(path.join(dataDir, 'manifest.json'));
  return {
    manifest: JSON.parse(manifestBytes.toString('utf8')) as CorpusManifest,
    manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
  };
}

