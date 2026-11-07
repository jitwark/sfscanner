import type {
  Complexity,
  CorpusAnalytics,
  CountedLabel,
  Entry,
  Grade,
  NodeCountBin,
  NodeCoverage,
  PolicyRow,
  Severity,
  V2AnalyticsEvidence,
} from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { assertEvidenceAccountsFor } from './v2-analytics-evidence.js';

/** Ordered severity, worst first. Reused as the status ramp order in the UI. */
const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
/** UNKNOWN is a grade but not a risk level; the matrix covers the four real ones. */
const MATRIX_GRADES: Grade[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const COMPLEXITIES: Complexity[] = ['simple', 'medium', 'complex'];
const LIST_CAP = 20;
/** n8n has a fixed, small set of trigger kinds; this is a guard, not a top-N. */
const TRIGGER_CAP = 12;

/** Fixed bins stay comparable between rebuilds; `max: null` is the open-ended top bin. */
export const NODE_COUNT_BINS: { label: string; min: number; max: number | null }[] = [
  { label: '1–3', min: 1, max: 3 },
  { label: '4–7', min: 4, max: 7 },
  { label: '8–14', min: 8, max: 14 },
  { label: '15–24', min: 15, max: 24 },
  { label: '25–49', min: 25, max: 49 },
  { label: '50–99', min: 50, max: 99 },
  { label: '100+', min: 100, max: null },
];

function rank(counts: Map<string, number>, cap = LIST_CAP): CountedLabel[] {
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    // Ties break on the label so a rebuild cannot reorder equal rows.
    .sort((a, b) => b.count - a.count || compareCanonicalStrings(a.label, b.label))
    .slice(0, cap);
}

function bump(counts: Map<string, number>, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!;
}

function binIndex(nodeCount: number): number {
  const found = NODE_COUNT_BINS.findIndex((bin) => nodeCount >= bin.min && (bin.max === null || nodeCount <= bin.max));
  return found === -1 ? 0 : found;
}

/**
 * Every figure the analytics page shows, measured in one catalogue pass. The searchable count is
 * passed in from the built indexes' own headers rather than derived a second way.
 */
export type CorpusAnalyticsEvidence = {
  /**
   * Written by the apply run from the same receipt sidecar the export certifies. Required: an
   * analytics artifact with no v2 evidence would present an older generation's numbers as current.
   */
  v2Evidence: V2AnalyticsEvidence;
  nodeCoverage: NodeCoverage;
  /** A v1 regeneration tree has no v2 results; its writer states that instead of faking them. */
  legacyV1Evidence?: true;
};

export function deriveCorpusAnalytics(
  entries: Entry[],
  options: { searchableDocumentCount: number } & CorpusAnalyticsEvidence,
): CorpusAnalytics {
  const grades: Record<Grade, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, UNKNOWN: 0 };
  const complexity: Record<Complexity, number> = { simple: 0, medium: 0, complex: 0 };
  const bySeverity: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  const triggers = new Map<string, number>();
  const integrations = new Map<string, number>();
  const nodeTypes = new Map<string, number>();
  const tags = new Map<string, number>();
  const sources = new Map<string, number>();
  const matrix = new Map<string, number>();
  const policies = new Map<string, PolicyRow>();
  const bins = NODE_COUNT_BINS.map((bin) => ({ ...bin, count: 0 }) as NodeCountBin);
  const nodeCounts: number[] = [];

  let redistributable = 0;
  let generated = 0;
  let upstream = 0;
  let fallback = 0;
  let completed = 0;
  let degraded = 0;
  let indeterminate = 0;
  let noResult = 0;
  let noBody = 0;
  let sourceUnavailable = 0;
  let historical = 0;
  let cleanScanned = 0;
  let workflowsWithFindings = 0;
  let totalOccurrences = 0;
  let hasCode = 0;
  let hasAI = 0;
  let hasWebhook = 0;

  for (const entry of entries) {
    const structure = entry.structure;
    const security = entry.security;

    if (entry.rights?.status === 'redistributable') redistributable += 1;
    if (entry.source?.kind) bump(sources, entry.source.kind);
    if (entry.descriptionSource === 'generated') generated += 1;
    else if (entry.descriptionSource === 'upstream') upstream += 1;
    else fallback += 1;

    const grade = security?.grade ?? 'UNKNOWN';
    grades[grade] += 1;

    const findings = security?.findings ?? [];
    // One row, one state. A published `analysisStatus` is the only evidence that
    // the current scanner read this row's body: `scannerVersion` survives on rows
    // whose verdict predates the contract, and on rows that were never scanned at
    // all, so it cannot answer this question on its own. `unscanned` readiness is
    // the pipeline's record that no body existed, and the two legacy placeholders
    // are the acquirer's own "no body arrived" markers.
    //
    // A `not-scanned` stamp that carries `stampReason: 'source_unavailable'` is a
    // third thing: the row has a body (it is in the release's pack), its upstream
    // source could not be re-acquired, and the verdict it ships is the one already
    // recorded. Counting it as "no body at all" would state something false about
    // the artifact.
    const noBodyStamp = security?.scannerVersion === 'unscanned' || security?.scannerVersion === 'not-scanned';
    const sourceUnavailableStamp = security?.stampReason === 'source_unavailable';
    if (sourceUnavailableStamp) sourceUnavailable += 1;
    else if (security?.noResult === true) noResult += 1;
    else if (entry.readiness?.analysis === 'unscanned' || noBodyStamp) noBody += 1;
    else if (security?.analysisStatus === 'COMPLETE') {
      completed += 1;
      // Only a scan that completed with nothing unperformed can be clean.
      if (findings.length === 0) cleanScanned += 1;
    } else if (security?.analysisStatus === 'DEGRADED') degraded += 1;
    else if (security?.analysisStatus === 'INDETERMINATE') indeterminate += 1;
    else historical += 1;

    if (structure) {
      complexity[structure.complexity] += 1;
      if (structure.trigger) bump(triggers, structure.trigger);
      for (const integration of structure.integrations ?? []) bump(integrations, integration);
      for (const nodeType of structure.nodeTypes ?? []) bump(nodeTypes, nodeType);
      if (structure.hasCode) hasCode += 1;
      if (structure.hasAI) hasAI += 1;
      if (structure.hasWebhook) hasWebhook += 1;
      nodeCounts.push(structure.nodeCount);
      bins[binIndex(structure.nodeCount)]!.count += 1;
      if (MATRIX_GRADES.includes(grade)) bump(matrix, `${grade}|${structure.complexity}`);
    }

    for (const tag of entry.tags ?? []) bump(tags, tag);

    if (findings.length > 0) workflowsWithFindings += 1;
    totalOccurrences += findings.length;
    const seenPolicies = new Set<string>();
    for (const finding of findings) {
      bySeverity[finding.severity] += 1;
      const row = policies.get(finding.id) ?? {
        id: finding.id,
        title: finding.title,
        severity: finding.severity,
        workflows: 0,
        occurrences: 0,
      };
      row.occurrences += 1;
      // A policy that fires three times in one workflow is one affected
      // workflow, not three. Both numbers matter and they are not the same.
      if (!seenPolicies.has(finding.id)) {
        row.workflows += 1;
        seenPolicies.add(finding.id);
      }
      policies.set(finding.id, row);
    }
  }

  const cells = MATRIX_GRADES.flatMap((grade) =>
    COMPLEXITIES.map((band) => ({ grade, complexity: band, count: matrix.get(`${grade}|${band}`) ?? 0 })),
  );

  // Verdicts published under the current contract. Everything else is a row with
  // no body or a verdict from a retired scanner, and neither is a scan of the
  // bytes this release ships.
  const scanned = completed + degraded + indeterminate;

  const scanCoverage = {
    total: entries.length,
    bodyAvailable: scanned + noResult + historical + sourceUnavailable,
    scanned,
    notScanned: noResult + noBody + historical + sourceUnavailable,
    completed,
    degraded,
    indeterminate,
    noResult,
    noBody,
    historical,
    sourceUnavailable,
  };
  if (options.legacyV1Evidence !== true) assertEvidenceAccountsFor(entries.length, options.v2Evidence, scanned);

  return {
    schemaVersion: 4,
    total: entries.length,
    searchable: options.searchableDocumentCount,
    rights: { redistributable, linkOnly: entries.length - redistributable },
    grades,
    triggers: rank(triggers, TRIGGER_CAP),
    complexity,
    capabilities: { hasCode, hasAI, hasWebhook },
    integrations: rank(integrations),
    nodeTypes: rank(nodeTypes),
    tags: rank(tags),
    sources: rank(sources),
    findings: {
      totalOccurrences,
      workflowsWithFindings,
      cleanScanned,
      noFindingsRecorded: entries.length - workflowsWithFindings,
      bySeverity,
      policies: [...policies.values()].sort(
        (a, b) =>
          b.workflows - a.workflows ||
          SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
          compareCanonicalStrings(a.id, b.id),
      ),
    },
    nodeCountBins: bins,
    nodeCountMedian: median(nodeCounts),
    gradeByComplexity: { cells, max: cells.reduce((most, cell) => Math.max(most, cell.count), 0) },
    enrichment: { generated, upstream, fallback },
    scanCoverage,
    v2Evidence: options.v2Evidence,
    nodeCoverage: options.nodeCoverage,
  };
}
