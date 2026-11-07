import fs from 'node:fs';
import path from 'node:path';
import { isIndexable, resolvePrerenderLimit, type EntryWithChart } from '@hub/contracts';
import { buildSearchIndex } from '../index/build-search-index.js';
import { buildFacets } from '../index/facets.js';
import { buildManifest } from '../package/manifest.js';
import { stageScannerSidecars } from '../package/scanner-sidecars.js';
import { writeArtifacts } from '../package/write-artifacts.js';
import { buildMetadataFromEntries } from '../package/metadata-from-entries.js';
import { selectPrerenderedIds } from '../index/prerender.js';
import { assertIndexableFloor } from '../index/indexable-floor.js';
import { partitionCatalogueClaims } from '../derive/catalogue-claim-freshness.js';
import { scanWorkflowWithCore, getScannerVersion } from '../scan/scanner-core-adapter.js';
import type { ScanCandidateOptions } from '../scan/scan-entry.js';
import compatibilityConfig from '../config/n8n-compatibility-target.json';
import type { CompatibilityTarget } from '../compatibility-types.js';
import { loadOfficialBodyMap, bodyFileByEntryId, readOfficialBody } from './official-bodies.js';
import { readPackagedItems, readPackWorkflows, integrationVocabulary } from './read-committed-corpus.js';
import { normaliseWithCommittedBody, normaliseWithoutBody, regenerateFromBody } from './regenerate-entry.js';
import { unparseableFixture, sortUnparseableFixtures, type UnparseableFixture } from './unparseable-ledger.js';
import {
  buildRedistributableBodyInventory,
  type RedistributableBodyInventory,
} from './redistributable-body-inventory.js';
import { checkRedistributionEvidence, type RedistributionEvidenceCheck } from '../rights/recorded-evidence.js';

export type RegenerationOptions = {
  /** The committed corpus to read. Never written to. */
  dataDir: string;
  /** The complete release tree this run writes. Promoted separately. */
  outputDir: string;
  /** Machine-local folders of retained official bodies, in the map's own order; never repo paths. */
  bodySources: readonly string[];
  mapPath: string;
  /** Fixed release timestamp. Required: a stage body never reads the clock. */
  generatedAt: string;
  /**
   * Build stamps that legitimately remain on shipped verdicts this run did not
   * rescan — the pre-regeneration stamp on body-less entries. Naming them is
   * what keeps `buildMetadataFromEntries`'s "one real scanner generation"
   * refusal intact for every caller that does not name one.
   */
  legacyScannerStamps?: readonly string[];
  /** Rights-evidence journal to check; defaults to `<dataDir>/rights-evidence.jsonl`. */
  rightsEvidencePath?: string;
};

export type RegenerationCounts = {
  totalEntries: number;
  matchedOfficial: number;
  reDerived: number;
  labelsOnly: number;
  officialWithoutBody: number;
  /** Redistributable entries whose only available body is the sanitized pack copy. */
  redistributableLabelsOnly: number;
  linkOnlyGithubLabelsOnly: number;
  officialWithoutBodyListed: number;
};

export type RegenerationReport = {
  schemaVersion: 'corpus-regeneration-v1';
  generatedAt: string;
  scannerVersion: string;
  mapCounts: Record<string, number>;
  counts: RegenerationCounts;
  published: number;
  quarantined: number;
  /** Measured from the published entries, not derived from the run counts. */
  readiness: { derived: number; unscanned: number; unscannedOfficial: number; unscannedCommunity: number };
  writtenArtifacts: number;
  stagedScannerSidecars: number;
  manifestSha256: string;
  integrationLabels: { before: string[]; after: string[] };
  /**
   * Upstream fixtures whose stored body failed `parseWorkflowJson`, one row per
   * fixture, derived from what this run observed rather than from a list.
   * Ascending by template id. Each row carries the parser's failure code and the
   * fail-closed verdict the entry published (`analysisStatus: INDETERMINATE`,
   * grade `UNKNOWN`, zero findings). An empty array means every body read parsed.
   */
  unparseable: UnparseableFixture[];
  /**
   * Sorted inventory of the redistributable sanitized bodies, built from the
   * committed pack bytes: relative pack path, line, byte size and SHA-256.
   * `count` must equal `counts.redistributableLabelsOnly` for this corpus.
   */
  redistributableBodies: RedistributableBodyInventory;
  /** Redistribution claims read, and how many the recorded evidence supports. */
  redistributionEvidence: RedistributionEvidenceCheck;
};

/** Regenerate every entry, then package the whole corpus through the real packager. */
export async function runRegeneration(options: RegenerationOptions): Promise<RegenerationReport> {
  const { dataDir, outputDir, bodySources, mapPath, generatedAt } = options;
  if (path.resolve(outputDir) === path.resolve(dataDir)) {
    throw new Error('Refusing to write over the source corpus: the packager clears its output directory first.');
  }

  const map = loadOfficialBodyMap(mapPath, bodySources);
  const bodyFiles = bodyFileByEntryId(map);
  if (bodyFiles.size !== map.counts.matched) {
    throw new Error(`Official-body map lists ${bodyFiles.size} distinct entry ids for ${map.counts.matched} matched rows`);
  }

  const items = readPackagedItems(dataDir);

  // Fail closed before any work: `rights.status` is copied from the frozen
  // catalogue verbatim, so a claim must show its recorded evidence here or not be republished.
  const redistributionEvidence = checkRedistributionEvidence(items.map((item) => item.entry), dataDir, options.rightsEvidencePath);
  const scannerVersion = getScannerVersion();
  const compatibilityTarget: CompatibilityTarget = {
    targetVersion: compatibilityConfig.version,
    source: compatibilityConfig.source,
    checkedAt: compatibilityConfig.checkedAt,
  };
  const before = integrationVocabulary(items);

  const counts: RegenerationCounts = {
    totalEntries: items.length,
    matchedOfficial: map.counts.matched,
    reDerived: 0,
    labelsOnly: 0,
    officialWithoutBody: 0,
    redistributableLabelsOnly: 0,
    linkOnlyGithubLabelsOnly: 0,
    officialWithoutBodyListed: map.withoutBody.length,
  };

  const regenerated: EntryWithChart[] = [];
  const unparseable: UnparseableFixture[] = [];
  const scan: ScanCandidateOptions['scan'] = (workflow, scanOptions) => scanWorkflowWithCore(workflow, scanOptions);
  for (const item of items) {
    const bodyRef = item.entry.source?.kind === 'n8n_official' ? bodyFiles.get(item.entry.id) : undefined;
    if (bodyRef === undefined) {
      // A download pointer means the packs hold a body for this entry — the
      // sanitized copy, not the one its published facts came from. That class
      // keeps its facts and only moves vocabulary, which is a different state
      // from an entry with no body anywhere in the repository.
      const hasCommittedBody = item.entry.download !== undefined;
      if (item.entry.source?.kind === 'n8n_official') counts.officialWithoutBody += 1;
      else if (hasCommittedBody) counts.redistributableLabelsOnly += 1;
      else counts.linkOnlyGithubLabelsOnly += 1;
      regenerated.push({
        entry: hasCommittedBody ? normaliseWithCommittedBody(item.entry) : normaliseWithoutBody(item.entry),
        chart: item.chart,
      });
      counts.labelsOnly += 1;
      continue;
    }
    let parseFailure: string | undefined;
    const result = await regenerateFromBody({
      entry: item.entry,
      body: readOfficialBody(bodyRef.sourceDir, bodyRef.file),
      chart: item.chart,
      compatibilityTarget,
      scan,
      scannerVersion,
      onUnparseable: (failure) => {
        parseFailure = failure.code;
      },
    });
    regenerated.push({ entry: result.entry, chart: result.chart });
    if (parseFailure !== undefined) unparseable.push(unparseableFixture(result.entry, parseFailure));
    counts.reDerived += 1;
  }

  if (counts.reDerived !== map.counts.matched) {
    throw new Error(`Re-derived ${counts.reDerived} entries against ${map.counts.matched} matched map rows`);
  }
  if (counts.officialWithoutBody !== map.counts.withoutBody) {
    throw new Error(
      `Body-less official entries counted ${counts.officialWithoutBody}, map says ${map.counts.withoutBody}`,
    );
  }
  if (counts.reDerived + counts.labelsOnly !== counts.totalEntries) {
    throw new Error(`Regenerated ${counts.reDerived + counts.labelsOnly} of ${counts.totalEntries} entries`);
  }

  // The bodies are read from the packs the run itself read, and reconciled
  // against the entry classification rather than a remembered total.
  const redistributableBodies = buildRedistributableBodyInventory(items.map((item) => item.entry), dataDir);
  if (redistributableBodies.count !== counts.redistributableLabelsOnly) {
    throw new Error(
      `Redistributable body inventory has ${redistributableBodies.count} rows but ` +
        `${counts.redistributableLabelsOnly} entries were counted as redistributable with a committed body`,
    );
  }

  const partition = partitionCatalogueClaims(regenerated);
  const published = partition.published.map((item) => item.entry);
  const readinessDerived = published.filter((entry) => entry.readiness?.analysis === 'derived').length;
  const readinessUnscanned = published.length - readinessDerived;
  if (readinessDerived !== counts.reDerived + counts.redistributableLabelsOnly) {
    throw new Error(
      `Readiness states do not reconcile: ${readinessDerived} derived vs ${counts.reDerived} re-derived ` +
      `+ ${counts.redistributableLabelsOnly} with a committed body`,
    );
  }
  const unscannedOfficial = published.filter(
    (entry) => entry.readiness?.analysis !== 'derived' && entry.source?.kind === 'n8n_official',
  ).length;
  if (unscannedOfficial !== counts.officialWithoutBody) {
    throw new Error(`Unscanned official entries ${unscannedOfficial} != body-less official ${counts.officialWithoutBody}`);
  }
  for (const entry of published) (entry as unknown as Record<string, unknown>).indexable = isIndexable(entry);
  const prerenderedIds = selectPrerenderedIds(published.filter(isIndexable), resolvePrerenderLimit(process.env));
  for (const entry of published) entry.isPrerendered = prerenderedIds.has(entry.id);

  assertIndexableFloor(published);

  fs.mkdirSync(outputDir, { recursive: true });
  const written = writeArtifacts(
    regenerated,
    readPackWorkflows(regenerated, dataDir),
    buildSearchIndex(published),
    buildFacets(published),
    outputDir,
    { legacyV1: true },
  );
  // Sidecars are staged before the corpus hash so `metadata.corpusSha256` covers
  // the complete release tree, not the tree minus three files.
  const stagedScannerSidecars = stageScannerSidecars(dataDir, outputDir);
  const metadata = buildMetadataFromEntries(published, outputDir, { ...compatibilityConfig }, generatedAt, {
    legacyScannerStamps: options.legacyScannerStamps,
  });
  const { manifestSha256 } = buildManifest(outputDir, written, generatedAt, metadata);

  return {
    schemaVersion: 'corpus-regeneration-v1',
    generatedAt,
    scannerVersion,
    mapCounts: { ...map.counts },
    counts,
    published: published.length,
    quarantined: partition.quarantined.length,
    readiness: {
      derived: readinessDerived,
      unscanned: readinessUnscanned,
      unscannedOfficial,
      unscannedCommunity: readinessUnscanned - unscannedOfficial,
    },
    writtenArtifacts: written.length,
    stagedScannerSidecars: stagedScannerSidecars.length,
    manifestSha256,
    integrationLabels: { before, after: integrationVocabulary(regenerated) },
    unparseable: sortUnparseableFixtures(unparseable),
    redistributableBodies,
    redistributionEvidence,
  };
}
