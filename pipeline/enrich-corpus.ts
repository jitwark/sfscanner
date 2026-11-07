import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { isIndexable, resolvePrerenderLimit, type Entry, type EntryWithChart, type WorkflowChart } from '@hub/contracts';
import { deriveChart } from './derive/structure.js';
import { deriveTags } from './enrich/tags.js';
import { buildSearchIndex } from './index/build-search-index.js';
import { buildFacets } from './index/facets.js';
import { buildManifest } from './package/manifest.js';
import { writeArtifacts } from './package/write-artifacts.js';
import { buildMetadataFromEntries } from './package/metadata-from-entries.js';
import { deriveCompatibility } from './derive/compatibility.js';
import { selectPrerenderedIds } from './index/prerender.js';
import compatibilityTarget from './config/n8n-compatibility-target.json';
import { assertIndexableFloor, indexableFloorReport } from './index/indexable-floor.js';
import { partitionCatalogueClaims } from './derive/catalogue-claim-freshness.js';
import { redactPublicText } from './enrich/public-text.js';
export type { EnrichCorpusOptions, EnrichCorpusResult, SizeTableItem } from './enrich/enrich-corpus-types.js';
import type { EnrichCorpusOptions, EnrichCorpusResult, SizeTableItem } from './enrich/enrich-corpus-types.js';

export function fallbackDescription(entry: Entry): string {
  const ints = (entry.structure?.integrations || []).join(', ') || 'n8n nodes';
  return `An automated ${entry.structure?.complexity || 'simple'} n8n workflow triggered by ${
    entry.structure?.trigger || 'Manual'
  }. Uses ${ints} with ${entry.structure?.nodeCount || 1} nodes to process data efficiently.`;
}

export function runEnrichCorpus(options: EnrichCorpusOptions): EnrichCorpusResult {
  const outputDir = options.outputDir || path.join(process.cwd(), 'data');
  const checkpointPath = options.checkpointPath || path.join(process.cwd(), 'pipeline', '.work', 'enrich-checkpoint.json');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });

  let rawEntries: Entry[] = options.entries || [];
  if (options.inputPath && fs.existsSync(options.inputPath)) {
    const fileData = JSON.parse(fs.readFileSync(options.inputPath, 'utf8'));
    rawEntries = Array.isArray(fileData) ? fileData : [];
  }

  if (options.sampleLimit && options.sampleLimit > 0) {
    rawEntries = rawEntries.slice(0, options.sampleLimit);
  }

  const workflowsById = options.workflowsById || new Map<string, unknown>();

  const checkpointMap = new Map<string, EntryWithChart>();
  if (fs.existsSync(checkpointPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      if (Array.isArray(saved)) {
        for (const item of saved) {
          if (item && item.entry && item.entry.id) {
            checkpointMap.set(item.entry.id, item);
          }
        }
      }
    } catch {}
  }

  const enrichedItems: EntryWithChart[] = [];
  const seenIds = new Set<string>();

  for (const rawEntry of rawEntries) {
    if (seenIds.has(rawEntry.id)) {
      throw new Error(`Duplicate entry ID encountered during enrichment: ${rawEntry.id}`);
    }
    seenIds.add(rawEntry.id);

    // The checkpoint is keyed by id, so it must also agree on the content that
    // produced it. Reusing a cached item whose description has since been
    // written silently reverted finished enrichment work to the old fallback.
    const cached = checkpointMap.get(rawEntry.id);
    if (
      cached &&
      cached.entry.description === rawEntry.description &&
      JSON.stringify(cached.entry.descriptionContent ?? null) === JSON.stringify(rawEntry.descriptionContent ?? null)
    ) {
      const cachedWorkflow = (options.compatibilityWorkflowsById ?? workflowsById).get(cached.entry.id);
      if (cachedWorkflow !== undefined && !cached.entry.compatibility) {
        cached.entry.compatibility = deriveCompatibility(cachedWorkflow, {
          targetVersion: compatibilityTarget.version,
          checkedAt: compatibilityTarget.checkedAt,
          source: compatibilityTarget.source,
        });
      }
      cached.entry.summary = redactPublicText(cached.entry.summary?.trim() || cached.entry.title);
      cached.entry.description = redactPublicText(cached.entry.description);
      enrichedItems.push(cached);
      continue;
    }

    const entry: Entry = { ...rawEntry };
    // Upstream text sometimes begins with punctuation or whitespace, which
    // makes the first-sentence projection empty. The catalogue contract needs
    // a non-empty summary; keep the title as the deterministic fallback.
    entry.summary = redactPublicText(entry.summary?.trim() || entry.title);
    entry.description = redactPublicText(entry.description);
    entry.tags = deriveTags(entry.structure?.nodeTypes || [], entry.structure || {});
    const workflow = (options.compatibilityWorkflowsById ?? workflowsById).get(entry.id);
    if (workflow !== undefined && !entry.compatibility) {
      entry.compatibility = deriveCompatibility(workflow, {
        targetVersion: compatibilityTarget.version,
        checkedAt: compatibilityTarget.checkedAt,
        source: compatibilityTarget.source,
      });
    }

    if (!entry.description || entry.description.trim() === '') {
      if (options.requireGemini) {
        entry.description = '';
        entry.summary = '';
        entry.descriptionSource = 'fallback';
        entry.descriptionContent = undefined;
        entry.descriptionProvenance = undefined;
      } else {
        entry.description = fallbackDescription(entry);
        entry.descriptionSource = 'fallback';
        entry.descriptionProvenance = {
          source: 'fallback',
          generatedAt: options.generatedAt,
        };
      }
    } else if (!entry.descriptionSource) {
      entry.descriptionSource = 'upstream';
      entry.descriptionProvenance = { source: 'upstream' };
    }

    const existingChart = options.chartsById?.get(entry.id);
    const chart: WorkflowChart =
      existingChart ?? deriveChart(workflowsById.get(entry.id) || { nodes: [], connections: {} });

    const item: EntryWithChart = { entry, chart };
    enrichedItems.push(item);
    checkpointMap.set(entry.id, item);
  }

  if (options.requireGemini) {
    const unresolved = enrichedItems.filter((item) =>
      item.entry.descriptionSource === 'fallback' ||
      (item.entry.dedup?.canonical === true &&
        (item.entry.descriptionSource !== 'generated' || !item.entry.descriptionContent)),
    );
    if (unresolved.length > 0) {
      const firstIds = unresolved.slice(0, 8).map((item) => item.entry.id).join(', ');
      throw new Error(`Gemini enrichment gate failed for ${unresolved.length} canonical entries; no fallback content was published. First IDs: ${firstIds}`);
    }
  }

  fs.writeFileSync(checkpointPath, JSON.stringify(Array.from(checkpointMap.values())), 'utf8');
  const claimPartition = partitionCatalogueClaims(enrichedItems);
  console.log(`Catalogue claim freshness: ${claimPartition.published.length} published, ${claimPartition.quarantined.length} quarantined.`);
  for (const item of claimPartition.published) {
    (item.entry as unknown as Record<string, unknown>).indexable = isIndexable(item.entry);
  }
  const entries = claimPartition.published.map((item) => item.entry);

  const indexableEntries = entries.filter(isIndexable);
  const prerenderedIds = selectPrerenderedIds(indexableEntries, resolvePrerenderLimit(process.env));
  for (const entry of entries) entry.isPrerendered = prerenderedIds.has(entry.id);
  console.log(indexableFloorReport(entries));
  assertIndexableFloor(entries);

  const searchIndexResult = buildSearchIndex(entries);
  const facetsData = buildFacets(entries);
  const writtenArtifacts = writeArtifacts([...enrichedItems], workflowsById, searchIndexResult, facetsData, outputDir, { legacyV1: true });
  const releaseMetadata = buildMetadataFromEntries(entries, outputDir, {
    version: compatibilityTarget.version,
    source: compatibilityTarget.source,
    checkedAt: compatibilityTarget.checkedAt,
  }, options.generatedAt);
  const { manifestSha256 } = buildManifest(outputDir, writtenArtifacts, options.generatedAt, releaseMetadata, {
    scannerSidecars: options.scannerSidecars,
  });

  const sizeTable: SizeTableItem[] = [];
  let searchIndexCompressed = 0;
  let facetsCompressed = 0;

  for (const artifact of writtenArtifacts) {
    const fullPath = artifact.absolutePath || path.join(outputDir, artifact.relativePath);
    const fileBuf = fs.readFileSync(fullPath);
    const uncompressedBytes = fileBuf.length;
    const compressedBytes = gzipSync(fileBuf).length;

    sizeTable.push({
      path: artifact.relativePath.replace(/\\/g, '/'),
      uncompressedBytes,
      compressedBytes,
    });

    if (artifact.relativePath === 'search-index.json') {
      searchIndexCompressed = compressedBytes;
    } else if (artifact.relativePath === 'facets.json') {
      facetsCompressed = compressedBytes;
    }
  }

  const budgetsMet = {
    searchIndexUnder8MB: searchIndexCompressed < 8 * 1024 * 1024,
    homepageUnder200KB: facetsCompressed < 200 * 1024,
  };

  return {
    totalEntries: entries.length,
    entries,
    manifestSha256,
    sizeTable,
    budgetsMet,
  };
}
