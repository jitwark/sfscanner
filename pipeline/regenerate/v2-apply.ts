import type { BodyDerivedMetadata } from '../export/body-derived-metadata.js';
import { writePreflightSidecar, PREFLIGHT_SIDECAR_PATH } from '../export/preflight-sidecar.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  isIndexable,
  resolvePrerenderLimit,
  type Entry,
  type EntryWithChart,
} from '@hub/contracts';
import type { CorpusV2InputInventory, CorpusV2InputReceipt } from '../../scripts/lib/corpus-v2-input-inventory.js';
import { buildSearchIndex } from '../index/build-search-index.js';
import { buildFacets } from '../index/facets.js';
import { selectPrerenderedIds } from '../index/prerender.js';
import { assertIndexableFloor } from '../index/indexable-floor.js';
import { partitionCatalogueClaims } from '../derive/catalogue-claim-freshness.js';
import { deriveStructure, deriveChart } from '../derive/structure.js';
import { deriveReadiness } from '../derive/readiness.js';
import { deriveHostnames } from '../derive/hostnames.js';
import { deriveCompatibility } from '../derive/compatibility.js';
import { sanitizeEntryForPublication } from '../sanitize/publication.js';
import { writeArtifacts, type WrittenArtifactInfo } from '../package/write-artifacts.js';
import { buildManifest } from '../package/manifest.js';
import { buildMetadataFromEntries } from '../package/metadata-from-entries.js';
import { stageScannerSidecars } from '../package/scanner-sidecars.js';
import compatibilityTarget from '../config/n8n-compatibility-target.json';
import { readPackWorkflows } from './read-committed-corpus.js';
import { classifyV2ScanFreshness, type ScanFreshness, type V2ScanEvidenceRecord } from './v2-scan-evidence.js';
import type { V2AnalyticsEvidence } from '@hub/contracts';
import { buildNodeCoverage, type NodeSample } from './node-coverage.js';
import { V2_ANALYTICS_EVIDENCE_PATH, V2_ANALYTICS_EVIDENCE_SCHEMA, type V2AnalyticsEvidenceSidecar } from '../derive/v2-analytics-evidence.js';

export const V2_INPUT_COVERAGE_PATH = 'scanner/v2-input-coverage.json';
export const V2_RECEIPTS_PATH = 'scanner/v2-scan-evidence.ndjson';

export type V2ApplyOptions = Readonly<{
  items: readonly EntryWithChart[];
  inventory: CorpusV2InputInventory;
  records: readonly V2ScanEvidenceRecord[];
  nodeSamples: readonly NodeSample[];
  bodyDerived?: ReadonlyMap<string, BodyDerivedMetadata>;
  dataDir: string;
  outputDir: string;
  generatedAt: string;
  /**
   * The scanned body for a row that previously had none (hydrated pinned source). Used only to
   * replace an `unscanned` readiness report with the facts the newly available body supports.
   */
  readBody?: (entryId: string) => unknown | undefined;
}>;

export type V2ApplyResult = Readonly<{
  outputDir: string;
  entryCount: number;
  receipts: number;
  inventoryCounts: CorpusV2InputInventory['counts'];
  states: V2AnalyticsEvidence['states'];
  current: V2AnalyticsEvidence['current'];
  manifestSha256: string;
  artifacts: number;
  /** The applied entries' own plan subjects, so the report is computed from what was published. */
  subjects: readonly { id: string; readiness?: Entry['readiness'] }[];
  /** The normalized records the candidate was written from; the report must consume these. */
  records: readonly V2ScanEvidenceRecord[];
}>;

import { analyticsEvidence, withSecurity } from './v2-apply-state.js';

/** The report is computed from the applied tree; a disagreement is a failed run, not a footnote. */
export function assertAppliedCensus(
  reported: Readonly<Record<'CURRENT' | 'NO_RESULT' | 'HISTORICAL' | 'UNSCANNED' | 'SOURCE_UNAVAILABLE', number>>,
  applied: V2AnalyticsEvidence['states'],
): void {
  const pairs = [['CURRENT', 'current'], ['NO_RESULT', 'noResult'], ['HISTORICAL', 'historical'], ['UNSCANNED', 'unscanned'], ['SOURCE_UNAVAILABLE', 'sourceUnavailable']] as const;
  for (const [reportKey, appliedKey] of pairs) {
    if (reported[reportKey] !== applied[appliedKey]) {
      throw new Error(`v2 regeneration: report ${reportKey}=${reported[reportKey]} disagrees with applied candidate ${appliedKey}=${applied[appliedKey]}.`);
    }
  }
}

/**
 * Re-derives every state from the receipt and the inventory binding. A stored `scanFreshness`, a
 * replayed sidecar or an impostor identity has no authority: the classifier throws instead. This
 * release publishes no retained v1 verdict, so a HISTORICAL record becomes an explicit no-verdict row.
 */
export function normalizeV2Records(records: readonly V2ScanEvidenceRecord[], inventory: CorpusV2InputInventory): {
  records: readonly V2ScanEvidenceRecord[];
  stateOf: ReadonlyMap<string, ScanFreshness>;
} {
  const receiptOf = new Map<string, CorpusV2InputReceipt>(inventory.rows.map((receipt) => [receipt.entryId, receipt]));
  const stateOf = new Map<string, ScanFreshness>();
  const normalized = records.map((record) => {
    const receipt = receiptOf.get(record.entryId);
    if (receipt === undefined) throw new Error(`v2 scan evidence: receipt for ${record.entryId} is not in the inventory.`);
    const classified = classifyV2ScanFreshness(record, receipt, inventory.inventorySha256);
    const state: ScanFreshness = classified === 'HISTORICAL' ? 'UNSCANNED' : classified;
    stateOf.set(record.entryId, state);
    return Object.freeze({ ...record, scanFreshness: state, scan: state === 'UNSCANNED' ? null : record.scan, retainedVerdict: null });
  });
  return { records: Object.freeze(normalized), stateOf };
}

/**
 * Writes one candidate tree from one receipt set: catalogue shards with the admitted security,
 * the receipt/journal/coverage sidecars, then every derived artifact through the existing packager,
 * and a manifest that owns all of it. Nothing under the source `data/` is touched.
 */
export function applyV2Regeneration(options: V2ApplyOptions): V2ApplyResult {
  if (path.resolve(options.outputDir) === path.resolve(options.dataDir)) {
    throw new Error('v2 apply: the output directory must differ from the source data directory.');
  }
  const { inventory, nodeSamples } = options;
  const recordOf = new Map(options.records.map((record) => [record.entryId, record]));
  if (recordOf.size !== options.items.length) {
    throw new Error(`v2 apply: ${options.records.length} receipts for ${options.items.length} entries.`);
  }
  const { records, stateOf } = normalizeV2Records(options.records, inventory);

  const items: EntryWithChart[] = options.items.map((item) => {
    const record = recordOf.get(item.entry.id);
    if (record === undefined) throw new Error(`v2 apply: no receipt for ${item.entry.id}.`);
    const state = stateOf.get(item.entry.id)!;
    const entry = withSecurity(item.entry, record, state);
    // A hydrated row was catalogued without a body, so its readiness still says `unscanned` even
    // though an admitted v2 scan just read it. Re-derive the deterministic facts from that same
    // body; the coverage census and search facets must see the body that exists.
    if ((state === 'CURRENT' || state === 'NO_RESULT') && entry.readiness?.analysis === 'unscanned') {
      const replacement = options.bodyDerived?.get(entry.id)?.replacement;
      if (replacement) {
        const { chart, ...facts } = replacement;
        return { entry: { ...entry, ...facts }, chart };
      }
      const body = options.readBody?.(entry.id);
      if (body !== undefined) {
        return {
          entry: {
            ...entry,
            structure: deriveStructure(body),
            readiness: deriveReadiness(body),
            hostnames: deriveHostnames(body),
            compatibility: deriveCompatibility(body, {
              targetVersion: compatibilityTarget.version,
              checkedAt: compatibilityTarget.checkedAt,
              source: compatibilityTarget.source,
            }),
          },
          chart: deriveChart(body),
        };
      }
    }
    return { ...item, entry };
  });
  // Reader-visible text and endpoint facts are sanitized once, before the search index, catalogue,
  // detail/preview artifacts and public projection derive from these entries. The input acquisition
  // record stays untouched.
  for (let index = 0; index < items.length; index += 1) {
    items[index] = { ...items[index]!, entry: sanitizeEntryForPublication(items[index]!.entry) };
  }
  const entryOf = new Map(items.map((item) => [item.entry.id, item.entry]));

  const coverageRows = inventory.rows.map((receipt) => {
    const state = stateOf.get(receipt.entryId);
    return {
      entryId: receipt.entryId,
      status: receipt.status,
      reasonCode: receipt.reasonCode,
      scanned: state === 'CURRENT',
      reason: state === 'NO_RESULT' ? 'refused' : null,
    };
  });
  const noResultCount = [...stateOf.values()].filter((state) => state === 'NO_RESULT').length;
  const inventoryCounts = inventory.counts;
  const coverage = {
    schemaVersion: 'v2-input-coverage-v1',
    inventorySha256: inventory.inventorySha256,
    counts: {
      ...inventoryCounts,
      unreadable: coverageRows.filter((row) => row.status === 'AVAILABLE' && row.scanned === false && row.reason !== 'refused').length,
      refused: noResultCount,
      recoveredFromPinnedSource: inventory.rows.filter((row) => row.status === 'AVAILABLE' && row.sourceCommit !== null).length,
    },
    rows: coverageRows,
  };
  const evidence = analyticsEvidence(inventory, records);
  const nodeCoverage = buildNodeCoverage(nodeSamples);
  const analyticsSidecar: V2AnalyticsEvidenceSidecar = {
    schemaVersion: V2_ANALYTICS_EVIDENCE_SCHEMA,
    v2Evidence: evidence,
    nodeCoverage,
  };

  fs.mkdirSync(path.join(options.outputDir, 'scanner'), { recursive: true });
  fs.writeFileSync(path.join(options.outputDir, V2_RECEIPTS_PATH), records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');
  fs.writeFileSync(path.join(options.outputDir, V2_INPUT_COVERAGE_PATH), `${JSON.stringify(coverage, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(options.outputDir, V2_ANALYTICS_EVIDENCE_PATH), `${JSON.stringify(analyticsSidecar, null, 2)}\n`, 'utf8');

  const partition = partitionCatalogueClaims(items);
  const published = partition.published.map((item) => item.entry);
  for (const entry of published) (entry as unknown as Record<string, unknown>).indexable = isIndexable(entry);
  const prerenderedIds = selectPrerenderedIds(published.filter(isIndexable), resolvePrerenderLimit(process.env));
  for (const entry of published) entry.isPrerendered = prerenderedIds.has(entry.id);
  assertIndexableFloor(published);

  const workflowsById = readPackWorkflows(items, options.dataDir);
  const written: WrittenArtifactInfo[] = writeArtifacts(
    items,
    workflowsById,
    buildSearchIndex(published),
    buildFacets(published),
    options.outputDir,
  );
  const metadata = buildMetadataFromEntries(published, options.outputDir, {
    version: compatibilityTarget.version,
    source: compatibilityTarget.source,
    checkedAt: compatibilityTarget.checkedAt,
  }, options.generatedAt);
  const preflight = options.bodyDerived ? writePreflightSidecar(options.outputDir,
    published.map((entry) => options.bodyDerived!.get(entry.id)!.preflight), inventory.inventorySha256,
    published.map((entry) => entry.id)) : undefined;
  stageScannerSidecars(options.dataDir, options.outputDir);
  const sidecars: WrittenArtifactInfo[] = [V2_RECEIPTS_PATH, V2_INPUT_COVERAGE_PATH, V2_ANALYTICS_EVIDENCE_PATH].map((relativePath) => ({
    relativePath,
    absolutePath: path.join(options.outputDir, relativePath),
    entryCount: records.length,
  }));
  if (preflight) sidecars.push({ relativePath: PREFLIGHT_SIDECAR_PATH, absolutePath: path.join(options.outputDir, PREFLIGHT_SIDECAR_PATH), entryCount: published.length });
  const { manifestSha256 } = buildManifest(options.outputDir, [...written, ...sidecars], options.generatedAt, metadata);

  if (entryOf.size !== records.length) throw new Error('v2 apply: entry and receipt populations diverged while writing.');
  return Object.freeze({
    outputDir: options.outputDir,
    entryCount: items.length,
    receipts: records.length,
    inventoryCounts,
    states: evidence.states,
    current: evidence.current,
    manifestSha256,
    artifacts: written.length + sidecars.length + 3,
    subjects: items.map((item) => ({ id: item.entry.id, ...(item.entry.readiness === undefined ? {} : { readiness: item.entry.readiness }) })),
    records,
  });
}
