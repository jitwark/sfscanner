import { resolvePrerenderLimit, type Entry, type WorkflowChart } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { parseEntryArrayJson } from '@hub/contracts/entry-artifact';
import { parseWorkflowChart } from '@hub/contracts/workflow-chart';
import type { ReleaseManifest } from '@hub/contracts/release-manifest';
import { readManifestSync } from './manifest-node';
import { isIndexable } from '../seo/page-meta';
import { buildRelatedIndex, type RelatedIndex } from './related';
let cachedEntries: Entry[] | null = null;

/**
 * Every catalogue shard the release manifest declares, or a build error.
 *
 * Skipping an absent shard used to be silent: the export still built, one
 * range of entries simply did not exist, and nothing in the build output said
 * so. The manifest is the declaration of what the release contains, so a
 * mismatch between it and `data/` is a release defect that must stop the page
 * list instead of shrinking it.
 *
 * Takes an already-parsed manifest rather than reading one, so a caller (and a
 * test) supplies the exact artifacts to judge.
 */
export function loadCatalogueEntries(dataDir: string, manifest: ReleaseManifest): Entry[] {
  const fs = require('fs');
  const path = require('path');
  const entries: Entry[] = [];
  for (const artifact of manifest.artifacts.filter((candidate) => /^catalogue-\d+\.json$/.test(candidate.path))) {
    const file = path.join(dataDir, path.basename(artifact.path));
    if (!fs.existsSync(file)) {
      throw new Error(
        `Catalogue shard ${artifact.path} is declared in the release manifest but missing at ${file}`,
      );
    }
    let parsed: Entry[];
    try {
      parsed = parseEntryArrayJson(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(
        `Catalogue shard ${artifact.path} is unparsable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (artifact.entryCount !== undefined && parsed.length !== artifact.entryCount) {
      throw new Error(
        `Catalogue shard ${artifact.path} parsed ${parsed.length} entries; the manifest declares ${artifact.entryCount}`,
      );
    }
    entries.push(...parsed);
  }
  // The selector above only opens shard names it recognises, so a declared
  // shard renamed (for example `catalogue-part-3.json`) would otherwise be
  // skipped without a word and the export would silently lose that range. The
  // manifest's total is the independent check: it is the release's declaration
  // of how many entries exist, and it sums the declared shard counts today.
  if (entries.length !== manifest.totalEntries) {
    throw new Error(
      `Catalogue shards loaded ${entries.length} entries; the release manifest declares ${manifest.totalEntries}`,
    );
  }
  return entries;
}

export function allEntries(): Entry[] {
  if (cachedEntries) {
    return cachedEntries;
  }


  const fs = require('fs');

  const path = require('path');

  const cwd = process.cwd();
  const dataDirs = [
    path.join(cwd, 'public', 'data'),
    path.join(cwd, 'app', 'public', 'data'),
    path.join(cwd, 'data'),
    path.join(cwd, '..', 'data'),
  ];

  let foundDataDir = '';
  for (const dir of dataDirs) {
    if (fs.existsSync(dir)) {
      foundDataDir = dir;
      break;
    }
  }

  if (!foundDataDir) {
    throw new Error('Data directory not found for reading catalogue shards');
  }

  cachedEntries = loadCatalogueEntries(foundDataDir, readManifestSync());
  return cachedEntries;
}
export function readChartSync(entry: Entry): WorkflowChart | null {
  const inline = entry as Entry & { chart?: WorkflowChart };
  if (inline.chart) return inline.chart;
  if (!entry.chartRef) return null;

  const fs = require('fs');

  const path = require('path');
  const dataDirs = [path.join(process.cwd(), 'data'), path.join(process.cwd(), '..', 'data'), path.join(process.cwd(), 'public', 'data'), path.join(process.cwd(), 'app', 'public', 'data')];
  const dataDir = dataDirs.find((dir: string) => fs.existsSync(dir));
  if (!dataDir) return null;
  const artifact = readManifestSync().artifacts.find((item) => item.path === `charts/chart-${entry.chartRef?.shard}.jsonl`);
  if (!artifact) return null;
  const filePath = path.join(dataDir, artifact.path);
  if (!fs.existsSync(filePath)) return null;
  const bytes = fs.readFileSync(filePath) as Uint8Array;
  const raw = new TextDecoder().decode(bytes.slice(entry.chartRef.offset, entry.chartRef.offset + entry.chartRef.length)).trim();
  return raw ? parseWorkflowChart(JSON.parse(raw.split('\n')[0])) : null;
}

export function qualityScore(entry: Entry): number {
  const base = 1.0;
  const stars = entry.source?.stars || 0;
  const starBonus = Math.min(0.2, Math.log10(stars + 1) * 0.05);

  const descBonus = entry.descriptionSource !== 'fallback' ? 0.15 : -0.1;
  const rightsBonus = entry.rights?.status === 'redistributable' ? 0.15 : 0;

  const integrationCount = entry.structure?.integrations?.length || 0;
  const integrationBonus = Math.min(0.15, integrationCount * 0.03);

  const criticalPenalty = entry.security?.grade === 'CRITICAL' ? -0.15 : 0;

  const rawScore = base + starBonus + descBonus + rightsBonus + integrationBonus + criticalPenalty;
  const clamped = Math.max(0.6, Math.min(1.4, rawScore));
  return Math.round(clamped * 10000) / 10000;
}

export function indexableSlugs(): string[] {
  const entries = allEntries();
  const marked = entries.filter((entry) => entry.isPrerendered === true);
  const indexable = (marked.length > 0 ? marked : entries.filter(isIndexable))
    .sort((a, b) => qualityScore(b) - qualityScore(a) || compareCanonicalStrings(a.id, b.id));
  const slugs = indexable.map((e) => e.slug);

  // Shared with `enrich-corpus.ts`, which bakes `entry.isPrerendered` from the
  // same number, and with `refresh-published-metadata.ts`. `isClientRoutable`
  // reads that field to choose a `<Link>` over an anchor, so a disagreement
  // costs two 404s per card rather than nothing.
  return slugs.slice(0, resolvePrerenderLimit(process.env));
}

export function featured(limit = 12): Entry[] {
  const entries = [...allEntries()];
  entries.sort((a, b) => {
    const diff = qualityScore(b) - qualityScore(a);
    if (Math.abs(diff) > 1e-6) {
      return diff;
    }
    return compareCanonicalStrings(a.id, b.id);
  });
  return entries.slice(0, limit);
}

let cachedRelatedIndex: RelatedIndex | null = null;

/**
 * One related-index for the whole build.
 *
 * Every detail page needs the same derived candidate table; building it per
 * page cost 19.5 ms against a 12,923-entry pool. Shared, it is built once and
 * each page costs 2.9 ms.
 */
export function relatedIndex(): RelatedIndex {
  cachedRelatedIndex ??= buildRelatedIndex(allEntries(), qualityScore);
  return cachedRelatedIndex;
}

export function clearPrerenderCache(): void {
  cachedEntries = null;
  cachedRelatedIndex = null;
}
