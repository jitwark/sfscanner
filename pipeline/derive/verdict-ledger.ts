import type { Entry, EntrySecurity, Grade } from '@hub/contracts';
import {
  classifyRowState,
  compareVerdicts,
  type ClaimClass,
  type Disposition,
  type GradeImpact,
  type RowState,
} from './verdict-adjudication.js';
import { digestVerdict, projectionOf } from './verdict-digest.js';

export const VERDICT_LEDGER_SCHEMA_VERSION = 'verdict-ledger-v1';
export const VERDICT_LEDGER_ADJUDICATION_POLICY = 'verdict-adjudication-v1';

export type ResolvedBody = { body: unknown; bodySha256: string };

export type LedgerVerdict = {
  scanner: { value: string; kind: string };
  grade: Grade;
  resultDigest: string;
};

export type VerdictLedgerRow = {
  id: string;
  slug: string;
  /** The row key: source repo, source commit, workflow path, body digest. */
  key: { repo: string; commit: string; path: string; bodySha256: string | null };
  rowState: RowState;
  old: LedgerVerdict | null;
  new: LedgerVerdict | null;
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
  reviewer: { kind: 'deterministic-policy'; policy: string; independentReview: 'owed' };
  /** What the committed corpus publishes right now. */
  shipped: { stamp: string; analysis: string | null; resultDigest: string | null };
};

export type VerdictLedger = {
  schemaVersion: string;
  derivedAt: string;
  corpus: { manifestSha256: string; totalEntries: number; linkOnly: number; redistributable: number };
  scanner: { current: { value: string; kind: string }; recordedStamps: Array<{ value: string; kind: string }> };
  populations: Array<{ name: string; count: number; basis: string }>;
  adjudication: {
    rows: number;
    changed: number;
    stampOnly: number;
    byClass: Record<string, number>;
    byDisposition: Record<string, number>;
    gradeTransitions: Record<string, number>;
  };
  reconciliation: {
    authoritativePopulation: string;
    changed: number;
    recordedEvidence: { path: string; different: number; match: boolean } | null;
    superseded: { reported: number; source: string; basis: string; resolution: string } | null;
  };
  rows: VerdictLedgerRow[];
};

export type VerdictLedgerInput = {
  entries: Entry[];
  resolveBody: (entry: Entry) => ResolvedBody | null;
  scan: (entry: Entry, body: unknown) => Promise<EntrySecurity>;
  scanner: { value: string; kind: string };
  recordedStamps: Array<{ value: string; kind: string }>;
  derivedAt: string;
  corpus: { manifestSha256: string; totalEntries: number; linkOnly: number };
  /** The rescan already recorded in `scripts/scanner-result-freshness.json`, for cross-checking. */
  recordedRescan: { path: string; bodies: number; identical: number; different: number; differentIds: string[] } | null;
  superseded: { reported: number; source: string; basis: string; resolution: string } | null;
};

function tally(rows: VerdictLedgerRow[]): Pick<VerdictLedger['adjudication'], 'byClass' | 'byDisposition' | 'gradeTransitions'> {
  const byClass: Record<string, number> = {};
  const byDisposition: Record<string, number> = {};
  const gradeTransitions: Record<string, number> = {};
  for (const row of rows) {
    byClass[row.claim.class] = (byClass[row.claim.class] ?? 0) + 1;
    byDisposition[row.disposition] = (byDisposition[row.disposition] ?? 0) + 1;
    const transition = `${row.claim.storedGrade} -> ${row.claim.rescannedGrade}`;
    gradeTransitions[transition] = (gradeTransitions[transition] ?? 0) + 1;
  }
  return { byClass, byDisposition, gradeTransitions };
}

/**
 * Build the 288-row changed-verdict ledger.
 *
 * Pure apart from the injected `scan`: it reads no files and no clock, so the same
 * entries, bodies and scanner produce the same bytes.
 */
export async function buildVerdictLedger(input: VerdictLedgerInput): Promise<VerdictLedger> {
  const rows: VerdictLedgerRow[] = [];
  for (const entry of input.entries) {
    if (entry.rights.status !== 'redistributable') continue;
    const storedSecurity = entry.security;
    const resolved = input.resolveBody(entry);
    const storedScanner = { value: storedSecurity.scannerVersion, kind: input.recordedStamps.find((stamp) => stamp.value === storedSecurity.scannerVersion)?.kind ?? 'undeclared' };
    const reviewer = { kind: 'deterministic-policy' as const, policy: VERDICT_LEDGER_ADJUDICATION_POLICY, independentReview: 'owed' as const };
    const key = {
      repo: entry.source.repo ?? '',
      commit: entry.source.commit ?? '',
      path: entry.source.path ?? '',
      bodySha256: resolved?.bodySha256 ?? null,
    };
    const rowState = classifyRowState(entry);
    const shipped = {
      stamp: storedSecurity.scannerVersion,
      analysis: entry.readiness?.analysis ?? null,
      resultDigest: digestVerdict(projectionOf(storedSecurity)),
    };

    if (resolved === null) {
      rows.push({
        id: entry.id,
        slug: entry.slug,
        key,
        rowState,
        old: { scanner: storedScanner, grade: storedSecurity.grade, resultDigest: shipped.resultDigest },
        new: null,
        changed: { stamp: false, verdict: false, fields: [] },
        claim: { class: 'none', grade: 'unchanged', storedGrade: storedSecurity.grade, rescannedGrade: storedSecurity.grade, findingsRemoved: 0, findingsAdded: 0 },
        disposition: 'retain-historical',
        rationale: 'no committed body resolved for this row, so it was not rescanned',
        reviewer,
        shipped,
      });
      continue;
    }

    const rescannedSecurity = await input.scan(entry, resolved.body);
    const comparison = compareVerdicts(
      projectionOf(storedSecurity),
      projectionOf(rescannedSecurity),
      { stored: storedSecurity.scannerVersion, rescanned: rescannedSecurity.scannerVersion },
      rowState,
    );
    rows.push({
      id: entry.id,
      slug: entry.slug,
      key,
      rowState,
      old: { scanner: storedScanner, grade: storedSecurity.grade, resultDigest: shipped.resultDigest },
      new: {
        scanner: { value: rescannedSecurity.scannerVersion, kind: input.scanner.value === rescannedSecurity.scannerVersion ? input.scanner.kind : 'undeclared' },
        grade: rescannedSecurity.grade,
        resultDigest: digestVerdict(projectionOf(rescannedSecurity)),
      },
      changed: comparison.changed,
      claim: comparison.claim,
      disposition: comparison.disposition,
      rationale: comparison.rationale,
      reviewer,
      shipped,
    });
  }

  rows.sort((left, right) => {
    const leftKey = [left.key.repo, left.key.commit, left.key.path, left.key.bodySha256 ?? '', left.id].join('\u0000');
    const rightKey = [right.key.repo, right.key.commit, right.key.path, right.key.bodySha256 ?? '', right.id].join('\u0000');
    return leftKey < rightKey ? -1 : 1;
  });

  const changed = rows.filter((row) => row.changed.verdict).length;
  const stampOnly = rows.filter((row) => row.changed.stamp && !row.changed.verdict).length;
  const derivedChangedIds = rows.filter((row) => row.changed.verdict).map((row) => row.id);
  const recorded = input.recordedRescan;
  const recordedMatch = recorded !== null
    && recorded.different === changed
    && recorded.identical === rows.length - changed
    && [...recorded.differentIds].sort().join('\u0000') === [...derivedChangedIds].sort().join('\u0000');

  return {
    schemaVersion: VERDICT_LEDGER_SCHEMA_VERSION,
    derivedAt: input.derivedAt,
    corpus: { ...input.corpus, redistributable: rows.length },
    scanner: { current: input.scanner, recordedStamps: input.recordedStamps },
    populations: [
      {
        name: 'committed-redistributable-rows',
        count: rows.length,
        basis: 'data/catalogue-*.json where rights.status === "redistributable"',
      },
      {
        name: 'changed-verdict',
        count: changed,
        basis: 'stored shipped verdict vs the current scanner re-derivation over each row\'s committed body, read from data/packs/*.jsonl through the row download pointer',
      },
      {
        name: 'stamp-only',
        count: stampOnly,
        basis: 'verdict reproduced identically; only the scanner stamp moved from the recorded build stamp to the current engine identity',
      },
      ...(recorded === null
        ? []
        : [{
            name: 'recorded-rescan-evidence',
            count: recorded.different,
            basis: `${recorded.path} rescan block: ${recorded.bodies} bodies, ${recorded.identical} identical, ${recorded.different} different`,
          }]),
    ],
    adjudication: { rows: rows.length, changed, stampOnly, ...tally(rows) },
    reconciliation: {
      authoritativePopulation: 'changed-verdict',
      changed,
      recordedEvidence: recorded === null ? null : { path: recorded.path, different: recorded.different, match: recordedMatch },
      superseded: input.superseded,
    },
    rows,
  };
}
