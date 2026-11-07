import type { Complexity, Grade, Severity } from './index';

/** A ranked row: one label and how many workflows carry it. */
export type CountedLabel = { label: string; count: number };

/**
 * One histogram bucket. `max: null` marks the open-ended top bucket — node counts
 * have a long tail, and quantile buckets would move under the reader every
 * rebuild.
 */
export type NodeCountBin = { label: string; min: number; max: number | null; count: number };

/**
 * One scanner policy's reach across the corpus. `workflows` and `occurrences`
 * differ whenever a rule fires more than once in the same workflow, and
 * conflating them overstates reach.
 */
export type PolicyRow = {
  id: string;
  title: string;
  severity: Severity;
  workflows: number;
  occurrences: number;
};

export type GradeComplexityCell = { grade: Grade; complexity: Complexity; count: number };

/**
 * Row states for the security pass, each with the denominator it is measured
 * against.
 *
 * These replaced a single `scanned`/`notScanned` pair read off whatever
 * `scannerVersion` string a row happened to carry. That stamp records which
 * scanner last touched the entry, not that the entry was ever scanned: a
 * retained stamp on an entry with no body made `data/analytics.json` report
 * every one of 11,464 rows as scanned. A verdict counts here only when it is
 * published by the current scanner contract, which is what
 * `security.analysisStatus` means.
 *
 * Every row lands in exactly one of `completed`, `degraded`, `indeterminate`,
 * `noResult`, `noBody`, `historical`, `sourceUnavailable`, so the seven always sum to `total`:
 *
 *   total = bodyAvailable + noBody
 *   bodyAvailable = scanned + noResult + historical + sourceUnavailable
 *   scanned = completed + degraded + indeterminate
 */
export type ScanCoverage = {
  /** Every catalogued entry. */
  total: number;
  /** Entries a workflow body exists for: `total - noBody`. */
  bodyAvailable: number;
  /**
   * Entries with an admitted current result read under the current v2 identity:
   * `completed + degraded + indeterminate`. This is not a count of assessed grades:
   * an INDETERMINATE result (and a DEGRADED one the engine did not assess) carries real
   * findings and a null assessment, so it is read, not a verdict.
   */
  scanned: number;
  /** Entries with no admitted current v2 result: `noResult + noBody + historical + sourceUnavailable`. */
  notScanned: number;
  /** Scans that completed with no skipped or omitted units. The denominator a clean count needs. */
  completed: number;
  /** Scans that completed but recorded skipped or omitted units, so they may have missed findings. */
  degraded: number;
  /**
   * Scans a required capability skipped, failed or truncated. The row keeps the engine's actual
   * findings and counts; it publishes no aggregate grade (assessment is null).
   */
  indeterminate: number;
  /** A current-identity, body-bound engine refusal: bytes read, no native result, no grade. */
  noResult: number;
  /**
   * Entries with no body to scan: `readiness.analysis` is `unscanned`, or the row
   * carries the acquirer's own `unscanned`/`not-scanned` no-body marker without a
   * `stampReason`. A `not-scanned` row that records *why* it was not scanned is
   * counted in `sourceUnavailable` instead, because it does have a body.
   */
  noBody: number;
  /** Entries with a body whose verdict came from a retired scanner and was never re-run. */
  historical: number;
  /**
   * Entries whose body exists — it shipped in the release's pack — but whose
   * upstream source could not be re-acquired, so no current-contract verdict could
   * be produced: `security.stampReason` is `source_unavailable`. Folding these into
   * `noBody` would state that no body exists, which is false of the artifact.
   */
  sourceUnavailable: number;
};

/**
 * The measured composition of a packaged corpus: the contract behind
 * `data/analytics.json` and the `/analytics/` route.
 *
 * Every field is derived from the entries in a single pass by
 * `deriveCorpusAnalytics`. Nothing here is sampled, estimated, or carried over
 * from a previous release — the page says as much to its reader, so the artifact
 * has to earn it.
 *
 * Schema 3 replaced `findings.cleanWorkflows` with `findings.cleanScanned` plus
 * `findings.noFindingsRecorded`, and gave `scanCoverage` the row states above.
 * `cleanWorkflows` was `total - workflowsWithFindings`, so an unscanned entry
 * with no finding rows read as clean.
 *
 * `sourceUnavailable` was added to `scanCoverage` without a schema bump: it
 * narrows `noBody` by one population whose body does exist, so a reader of the
 * earlier shape still prints a true sentence for every field it knows, and the
 * schema check exists to stop a reader *misinterpreting* a changed field, not to
 * forbid an added one.
 */
/**
 * The admitted scan identity the v2 figures were produced under, plus the input inventory they
 * cover. Mirrors `V2ScanIdentity` without importing the pipeline package.
 */
export type V2AnalyticsIdentity = {
  scannerVersion: string;
  engineBuildDigest: string;
  profileId: string;
  profileVersion: string;
  rulesetId: string;
  rulesetVersion: string;
  rulesetDigest: string;
  signatureStatus: string;
  semanticsId: string;
  semanticsVersion: string;
  semanticsDigest: string;
  limitsDigest: string;
  inventorySha256: string;
};

/**
 * Aggregate v2 state, independent of redistribution rights.
 *
 * `states` sums to `total`; `current` sums to `scanCoverage.scanned`;
 * `excludedByRuling` is a labelled subset of `states.sourceUnavailable`, not a fifth state.
 */
export type V2AnalyticsEvidence = V2AnalyticsIdentity & {
  inventory: { available: number; missing: number; sourceUnavailable: number };
  states: { current: number; noResult: number; historical: number; unscanned: number; sourceUnavailable: number };
  /**
   * Rows with an admitted native result, by status. Refusals are `states.noResult`, never here.
   */
  current: { complete: number; degraded: number; indeterminate: number };
  excludedByRuling: number;
};

/** One (node type, version) pair and how many workflows/instances carried it. */
export type NodeCoverageVersionRow = {
  nodeType: string;
  version: string;
  workflows: number;
  instances: number;
  semantics: 'MODELLED' | 'UNMODELLED';
};

/** A node type the catalogue does not model at any observed version. */
export type NodeCoverageUnknownType = {
  nodeType: string;
  workflows: number;
  instances: number;
  versions: string[];
};

/**
 * Catalogue coverage of the node types the scanned bodies actually contain. This is not security
 * accuracy: a modelled node can still have findings, and an unmodelled one still has its
 * parameters audited by the structural policies.
 */
export type NodeCoverage = {
  /** Distinct node types observed in scanned bodies. */
  observedNodeTypes: number;
  /** Node occurrences observed in those bodies. */
  observedNodeInstances: number;
  modelledTypes: number;
  partlyModelledTypes: number;
  unmodelledTypes: number;
  versions: readonly NodeCoverageVersionRow[];
  unknownTypes: readonly NodeCoverageUnknownType[];
};

export type CorpusAnalytics = {
  schemaVersion: 4;
  total: number;
  /**
   * How many entries are findable, summed across every search index tier.
   *
   * Named for `isSearchable`, which is what it counts. It was called
   * `indexable` through schema 1, which was a trap: `isIndexable` is a
   * different, narrower, rights-gated predicate governing crawler indexing,
   * prerendering and hub membership. Quoting this field as "indexable pages"
   * overstates that number by an order of magnitude.
   */
  searchable: number;
  rights: { redistributable: number; linkOnly: number };
  grades: Record<Grade, number>;
  triggers: CountedLabel[];
  complexity: Record<Complexity, number>;
  /** These overlap: one workflow can have code, AI and a webhook. */
  capabilities: { hasCode: number; hasAI: number; hasWebhook: number };
  integrations: CountedLabel[];
  nodeTypes: CountedLabel[];
  tags: CountedLabel[];
  sources: CountedLabel[];
  findings: {
    totalOccurrences: number;
    /**
     * Entries carrying at least one finding row. Counted over every entry,
     * scanned or not: a finding recorded by a retired scanner is still a finding
     * a reader can see on the row.
     */
    workflowsWithFindings: number;
    /**
     * Completed scans that recorded no finding — the only figure that may be
     * called clean, and the only one whose denominator is `scanCoverage.completed`
     * rather than every entry.
     */
    cleanScanned: number;
    /**
     * Every entry with no finding rows, scanned or not. Not a clean rate: the
     * rows that were never scanned have no findings recorded because nothing was
     * read, not because nothing was there.
     */
    noFindingsRecorded: number;
    bySeverity: Record<Severity, number>;
    policies: PolicyRow[];
  };
  nodeCountBins: NodeCountBin[];
  nodeCountMedian: number;
  gradeByComplexity: { cells: GradeComplexityCell[]; max: number };
  enrichment: { generated: number; upstream: number; fallback: number };
  /**
   * How much of the corpus the security pass actually covers, as row states with
   * their denominators. Link-only entries acquired from metadata alone have no
   * body to scan, and a verdict from a retired scanner is not a scan of the
   * shipped bytes.
   */
  scanCoverage: ScanCoverage;
  v2Evidence: V2AnalyticsEvidence;
  nodeCoverage: NodeCoverage;
};
