import type { Entry } from '@hub/contracts';

/**
 * One upstream fixture whose stored body fails `parseWorkflowJson`.
 *
 * A workflow that does not parse is not scannable, so nothing about it is
 * known: the verdict the run publishes for it carries
 * `analysisStatus: 'INDETERMINATE'` (the published status) with grade `UNKNOWN`
 * and zero findings. That is a fail-closed state, not a clean one, and the
 * reason to ledger each fixture individually is that the count of unreadable
 * fixtures is a fact an auditor can reconcile instead of a number absorbed into
 * a pass total.
 *
 * Every field is read from the entry the run itself produced and the parser's
 * own failure code, so the ledger cannot drift from what was published.
 */
export type UnparseableFixture = {
  entryId: string;
  /** Upstream n8n template id; null when the entry is not an official template. */
  templateId: number | null;
  slug: string;
  /** The `WorkflowParseErrorCode` the run observed, e.g. `MALFORMED_WORKFLOW`. */
  reason: string;
  /** The published status, read off the regenerated entry (`INDETERMINATE` for a parse failure). */
  analysisStatus: string;
  grade: string;
  findings: number;
  scannerVersion: string;
  profile: string;
};

/** Summarise one fixture from the published entry and the parser's failure code. */
export function unparseableFixture(entry: Entry, reason: string): UnparseableFixture {
  const source = entry.source;
  const security = entry.security;
  return {
    entryId: entry.id,
    templateId: source.kind === 'n8n_official' ? source.templateId ?? null : null,
    slug: entry.slug,
    reason,
    analysisStatus: security.analysisStatus ?? 'UNKNOWN',
    grade: security.grade,
    findings: security.findings.length,
    scannerVersion: security.scannerVersion,
    profile: security.profile,
  };
}

/** Ascending by template id, then entry id, so shard iteration order cannot move a row in the report. */
export function sortUnparseableFixtures(fixtures: readonly UnparseableFixture[]): UnparseableFixture[] {
  return [...fixtures].sort(
    (a, b) =>
      (a.templateId ?? Number.MAX_SAFE_INTEGER) - (b.templateId ?? Number.MAX_SAFE_INTEGER) ||
      (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0),
  );
}
