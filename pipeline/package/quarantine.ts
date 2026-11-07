import fs from 'node:fs';
import path from 'node:path';
import type { EntryWithChart } from '@hub/contracts';
import { partitionCatalogueClaims } from '../derive/catalogue-claim-freshness.js';
import { buildSearchIndex, type BuildSearchIndexResult } from '../index/build-search-index.js';
import { buildFacets, type FacetData } from '../index/facets.js';

export function prepareCatalogueClaims(items: EntryWithChart[], outputDir: string, indexes: { search: BuildSearchIndexResult; facets: FacetData }) {
  const partition = partitionCatalogueClaims(items);
  if (partition.quarantined.length === 0) return { published: partition.published, search: indexes.search, facets: indexes.facets };
  const report = {
    totalInput: items.length,
    published: partition.published.length,
    quarantined: partition.quarantined.length,
    entries: partition.quarantined.map(({ entry, reasons }) => ({ id: entry.id, reasons })),
  };
  const relativePath = 'quarantine-report.json';
  const absolutePath = path.join(outputDir, relativePath);
  fs.writeFileSync(absolutePath, JSON.stringify(report, null, 2), 'utf8');
  return {
    published: partition.published,
    report: { relativePath, absolutePath, entryCount: report.quarantined, entryRange: [0, report.quarantined - 1] as [number, number] },
    search: buildSearchIndex(partition.published.map((item) => item.entry)),
    facets: buildFacets(partition.published.map((item) => item.entry)),
  };
}
