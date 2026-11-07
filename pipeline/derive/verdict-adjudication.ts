import type { Grade, PublicFinding } from '@hub/contracts';
import { canonicalizeJsonForHash } from '../dedup/signatures.js';

/**
 * Adjudication rules for one redistributable verdict row.
 *
 * A shipped verdict row and a rescanned verdict row are compared, classified, and
 * given an explicit disposition. Nothing here decides *silently*: a grade is only
 * moved when the class justifies it, and a change that would raise a published
 * claim is handed to the owner rather than accepted by the derivation.
 */

export type RowState = 'scanned' | 'historical_verdict' | 'unscanned';

export type ClaimClass =
  | 'none'
  | 'report_only'
  | 'false_positive_removed'
  | 'detection_loss'
  | 'detection_gain'
  | 'mixed'
  | 'severity_shift';

export type GradeImpact = 'unchanged' | 'lowered' | 'raised';

export type Disposition = 'no-change' | 'accept-rescanned' | 'requires-owner-decision' | 'retain-historical';

/** The verdict fields a reader's grade and finding list are drawn from. */
export type VerdictProjection = {
  grade: Grade;
  score: number;
  counts: Record<'critical' | 'high' | 'medium' | 'low' | 'info', number>;
  findings: PublicFinding[];
  hardenedExtra: number;
  profile: string;
  schemaVersion?: string;
};

export type VerdictComparison = {
  changed: { stamp: boolean; verdict: boolean; fields: string[] };
  claim: {
    class: ClaimClass;
    grade: GradeImpact;
    storedGrade: Grade;
    rescannedGrade: Grade;
    findingsRemoved: number;
    findingsAdded: number;
  };
  disposition: Disposition;
  rationale: string;
};

/**
 * Compared verdict fields.
 *
 * `scannerVersion` is not here: it is the stamp, compared and reported on its own,
 * because the shipped legacy rows carry a build stamp rather than an engine
 * identity. `analysisStatus` is not here either — the shipped legacy verdicts
 * predate the field, so including it would report every one of the 288 rows as
 * changed for a reason that is not a verdict change.
 */
const COMPARED_VERDICT_FIELDS = ['grade', 'score', 'counts', 'hardenedExtra', 'profile', 'schemaVersion'] as const;

/** Fields that move only the hardened-only report, never the published default verdict. */
const REPORT_ONLY_FIELDS: Record<string, true> = { hardenedExtra: true, profile: true, schemaVersion: true };

/** Higher is more severe. UNKNOWN (no verdict) ranks below INFO. */
const SEVERITY_RANK: Record<string, number> = { UNKNOWN: 0, INFO: 1, LOW: 2, MEDIUM: 3, HIGH: 4, CRITICAL: 5 };

/**
 * The one finding the record authorises as a false positive.
 *
 * `scripts/scanner-result-freshness.json` records the cause of the 41 changed
 * rows: the credential-plumbing fix stopped the parameter keys `credentials` and
 * `nodeCredentialType` being read as secret-bearing, and the 55
 * `parameters.nodeCredentialType` values it names each carried a MEDIUM
 * `RAW_SECRET_INDICATOR` — the "parameter is named like a secret" class, which the
 * record rules not secret material. 44 of those occurrences survive into the
 * published verdicts this comparison reads (the per-node and per-entry public
 * finding limits trim the rest). Severity is what separates that class from the
 * HIGH raw-secret-material class of the same rule, and a projected finding keeps
 * only id, title, severity, node, why and fix
 * (`pipeline/scan/scanner-core-adapter.ts`), so this id-and-severity pair is the
 * tightest record of the remedy the projection supports. Anything else that
 * disappears is a change in what the engine detects, which this derivation is not
 * allowed to accept on its own authority.
 */
const RECORDED_FALSE_POSITIVE = { id: 'RAW_SECRET_INDICATOR', severity: 'MEDIUM' } as const;

/** How many times each finding identity (`id|node`) occurs. Findings are a multiset, not a key set. */
function countOccurrences(findings: PublicFinding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const key = `${finding.id}|${finding.node ?? ''}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Which state a shipped row is in.
 *
 * The readiness report is the pipeline's own record of whether a workflow body
 * existed, so it outranks the stamp. That order is the whole point: `c998701`
 * survives on rows whose verdict predates the `analysisStatus` contract *and* on
 * rows no scanner ever read, so a stamp alone cannot say a body was read. Reading
 * the stamp first is how the analytics contract came to count 1,791 no-body rows
 * as scanned.
 */
export function classifyRowState(entry: {
  readiness?: { analysis?: string };
  security?: { scannerVersion?: string; analysisStatus?: string };
}): RowState {
  if (entry.readiness?.analysis === 'unscanned') return 'unscanned';
  const stamp = entry.security?.scannerVersion;
  if (stamp === 'unscanned' || stamp === 'not-scanned') return 'unscanned';
  if (entry.security?.analysisStatus !== undefined) return 'scanned';
  return 'historical_verdict';
}

function claimClassOf(
  fields: string[],
  findingsMoved: boolean,
  findingsRemoved: number,
  findingsAdded: number,
  unauthorizedRemovals: number,
): ClaimClass {
  if (fields.length === 0) return 'none';
  if (fields.every((field) => REPORT_ONLY_FIELDS[field] === true)) return 'report_only';
  if (!findingsMoved) return 'severity_shift';
  if (findingsRemoved > 0 && findingsAdded === 0) {
    return unauthorizedRemovals === 0 ? 'false_positive_removed' : 'detection_loss';
  }
  if (findingsAdded > 0 && findingsRemoved === 0) return 'detection_gain';
  return 'mixed';
}

export function compareVerdicts(
  stored: VerdictProjection,
  rescanned: VerdictProjection,
  stamps: { stored: string; rescanned: string },
  rowState: RowState,
): VerdictComparison {
  const storedRecord = stored as unknown as Record<string, unknown>;
  const rescannedRecord = rescanned as unknown as Record<string, unknown>;
  const fields: string[] = [];
  for (const field of COMPARED_VERDICT_FIELDS) {
    const left = storedRecord[field];
    const right = rescannedRecord[field];
    // `canonicalizeJsonForHash` — the same canonicalisation `verdict-digest.ts`
    // hashes — so equal counts written in a different key order compare equal.
    // It refuses `undefined`, which a legacy row's omitted `schemaVersion` is, and
    // an absent field is compared as an absent field.
    const moved = left === undefined || right === undefined
      ? left !== right
      : canonicalizeJsonForHash(left) !== canonicalizeJsonForHash(right);
    if (moved) fields.push(field);
  }
  // Findings are compared on `id` plus node name, not severity: a re-weighted
  // finding is the same finding, and the question here is which claims appear or
  // disappear from the published list. They are compared as a multiset — two
  // findings of one rule on one node are two claims, so losing one while the other
  // remains is a removal, not no change.
  const storedCounts = countOccurrences(stored.findings);
  const rescannedCounts = countOccurrences(rescanned.findings);
  const recordedFalsePositives = countOccurrences(stored.findings.filter(
    (finding) => finding.id === RECORDED_FALSE_POSITIVE.id && finding.severity === RECORDED_FALSE_POSITIVE.severity,
  ));
  let findingsRemoved = 0;
  let findingsAdded = 0;
  let unauthorizedRemovals = 0;
  for (const [key, count] of storedCounts) {
    const removed = count - (rescannedCounts.get(key) ?? 0);
    if (removed <= 0) continue;
    findingsRemoved += removed;
    // A group can mix severities, and the multiset cannot say which occurrence
    // went; credit only the recorded class and escalate the rest.
    unauthorizedRemovals += removed - Math.min(removed, recordedFalsePositives.get(key) ?? 0);
  }
  for (const [key, count] of rescannedCounts) {
    const added = count - (storedCounts.get(key) ?? 0);
    if (added > 0) findingsAdded += added;
  }
  const findingsMoved = findingsRemoved + findingsAdded > 0;
  if (findingsMoved) fields.push('findings');

  const claimClass = claimClassOf(fields, findingsMoved, findingsRemoved, findingsAdded, unauthorizedRemovals);
  const storedRank = SEVERITY_RANK[stored.grade] ?? 0;
  const rescannedRank = SEVERITY_RANK[rescanned.grade] ?? 0;
  let grade: GradeImpact = 'unchanged';
  if (rescannedRank > storedRank) grade = 'raised';
  else if (rescannedRank < storedRank) grade = 'lowered';

  const stampChanged = stamps.stored !== stamps.rescanned;
  const verdictChanged = fields.length > 0;
  const gradeMove = `${stored.grade} -> ${rescanned.grade}`;
  let disposition: Disposition;
  let rationale: string;
  if (rowState === 'unscanned') {
    disposition = 'retain-historical';
    rationale = 'no authorized body exists for this row, so it keeps its published state and is not rescanned';
  } else if (!stampChanged && !verdictChanged) {
    disposition = 'no-change';
    rationale = 'verdict and stamp both unchanged';
  } else if (claimClass === 'detection_loss') {
    // A published finding disappeared for a reason the record does not authorize.
    // Acceptance here is how a loss of detection sensitivity would be laundered.
    disposition = 'requires-owner-decision';
    rationale = `detection_loss: ${unauthorizedRemovals} of ${findingsRemoved} removed finding(s) are not the recorded credential-plumbing false positive (${RECORDED_FALSE_POSITIVE.id}/${RECORDED_FALSE_POSITIVE.severity}), so the derivation will not accept the loss of a published finding (grade ${gradeMove})`;
  } else if (grade === 'raised' || findingsAdded > 0 || claimClass === 'mixed' || claimClass === 'severity_shift') {
    // A change that adds findings or raises severity increases a published claim.
    // The derivation refuses to publish that on its own authority.
    disposition = 'requires-owner-decision';
    rationale = `${claimClass}: published claim would increase (findings added ${findingsAdded}, grade ${gradeMove}); acceptance of an increased claim is an owner decision`;
  } else if (claimClass === 'report_only') {
    disposition = 'accept-rescanned';
    rationale = `report-only change in ${fields.join(', ')}; no published default-profile claim moved, grade ${gradeMove}`;
  } else {
    disposition = 'accept-rescanned';
    rationale = verdictChanged
      ? `${claimClass}: ${findingsRemoved} finding(s) removed and ${findingsAdded} added, grade ${gradeMove}; the rescanned verdict supersedes the shipped one`
      : `verdict unchanged and confirmed by the current engine; stamp ${stamps.stored} -> ${stamps.rescanned} records the generation that reproduced it`;
  }

  return {
    changed: { stamp: stampChanged, verdict: verdictChanged, fields },
    claim: {
      class: claimClass,
      grade,
      storedGrade: stored.grade,
      rescannedGrade: rescanned.grade,
      findingsRemoved,
      findingsAdded,
    },
    disposition,
    rationale,
  };
}
