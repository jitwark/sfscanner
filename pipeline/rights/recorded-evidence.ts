import fs from 'node:fs';
import path from 'node:path';
import type { EntryRights } from '@hub/contracts';
import { isLicenceInstrument } from './evidence.js';

/**
 * The recorded per-item licence evidence a redistribution claim is checked
 * against, and the arithmetic that says whether a claim has it.
 *
 * The record is the journal `rightsStage` writes outside every published output
 * (`rightsEvidenceLedgerPath`): one JSON line per candidate, carrying the
 * decision, the reason, and the evidence it was made on. This module reads that
 * journal back and answers one question for a repackaging run — does the claim
 * this entry publishes have the evidence it needs behind it?
 *
 * What "has it" means here, in code:
 *
 *   1. the journal has a row for the entry id;
 *   2. that row's recorded decision is `redistributable`;
 *   3. the recorded `licenceBasis` is `same-commit-file` — the basis
 *      `deriveLicenceBasis` assigns only when a root licence instrument was
 *      recorded at the selected commit;
 *   4. at least one recorded licence instrument carries a digest, so a row
 *      cannot assert a basis it has no blob for.
 *
 * A repackaging run that cannot show all four for an entry must not republish
 * `redistributable` for it. That is a statement about what this pipeline
 * records and publishes, not about what any licence permits.
 */

/** The journal `rightsStage` writes beside the stage ledger. */
export const RIGHTS_EVIDENCE_LEDGER_FILENAME = 'rights-evidence.jsonl';

export type RecordedLicenceFile = { filename: string; sha256: string };

/** One line of the rights-evidence journal, as `rightsStage` writes it. */
export type RightsEvidenceLedgerRecord = {
  id: string;
  status: string;
  disposition?: string;
  reason?: string;
  evidence?: {
    licenceBasis?: string;
    sourceCommit?: string | null;
    rootLicence?: RecordedLicenceFile[];
    siblingLicence?: RecordedLicenceFile[];
    nestedLicence?: RecordedLicenceFile[];
  };
};

/**
 * Rows keyed by entry id.
 *
 * A duplicate id throws rather than resolving last-write-wins: two rows for one
 * entry mean the journal does not describe a single decision, and picking one
 * of them would be this module inventing the record it is supposed to read.
 */
export function parseRightsEvidenceLedger(text: string): Map<string, RightsEvidenceLedgerRecord> {
  const records = new Map<string, RightsEvidenceLedgerRecord>();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === '') continue;
    let row: RightsEvidenceLedgerRecord;
    try {
      row = JSON.parse(line) as RightsEvidenceLedgerRecord;
    } catch {
      throw new Error(`Rights-evidence ledger line ${index + 1} is not JSON.`);
    }
    if (typeof row?.id !== 'string' || row.id === '') {
      throw new Error(`Rights-evidence ledger line ${index + 1} carries no entry id.`);
    }
    if (records.has(row.id)) {
      throw new Error(`Rights-evidence ledger records ${row.id} more than once (line ${index + 1}).`);
    }
    records.set(row.id, row);
  }
  return records;
}

export function readRightsEvidenceLedger(file: string): Map<string, RightsEvidenceLedgerRecord> {
  return parseRightsEvidenceLedger(fs.readFileSync(file, 'utf8'));
}

/** Recorded licence instruments that carry a digest, from every recorded position. */
function recordedInstruments(record: RightsEvidenceLedgerRecord | undefined): RecordedLicenceFile[] {
  const evidence = record?.evidence;
  const files = [
    ...(evidence?.rootLicence ?? []),
    ...(evidence?.siblingLicence ?? []),
    ...(evidence?.nestedLicence ?? []),
  ];
  return files.filter(
    (file) => typeof file?.filename === 'string' && isLicenceInstrument(file.filename) && typeof file.sha256 === 'string' && file.sha256 !== '',
  );
}

/**
 * Why an entry's recorded evidence does not support the redistribution claim it
 * publishes, or `null` when it does.
 *
 * `ledgerPath` is named only for the diagnostic; `null` means the run was given
 * no journal at all, which is a gap in itself and never a pass.
 */
export function redistributionEvidenceGap(
  id: string,
  record: RightsEvidenceLedgerRecord | undefined,
  ledgerPath: string | null,
): string | null {
  if (record === undefined) {
    return ledgerPath === null
      ? 'no rights-evidence journal was supplied to this run'
      : `${ledgerPath} records no row for this entry`;
  }
  if (record.status !== 'redistributable') {
    return `the journal records status "${record.status}", not "redistributable"`;
  }
  const basis = record.evidence?.licenceBasis;
  if (basis !== 'same-commit-file') {
    return `the journal records licenceBasis "${basis ?? 'absent'}", not "same-commit-file"`;
  }
  if (recordedInstruments(record).length === 0) {
    return 'the journal names no same-commit licence instrument with a recorded digest';
  }
  return null;
}

export type RedistributionEvidenceAudit = {
  /** Entries publishing `rights.status === 'redistributable'`. */
  claims: number;
  /** Claims whose recorded evidence supports them. */
  evidenced: number;
  /** Claims whose recorded evidence does not, with the reason per entry. */
  unevidenced: Array<{ id: string; gap: string }>;
};

/**
 * Every redistributable claim in `entries`, checked against the recorded
 * journal. Entries with any other status carry no redistribution claim and are
 * not this audit's subject.
 */
export function auditRedistributionEvidence(
  entries: ReadonlyArray<{ id: string; rights?: EntryRights | undefined }>,
  records: Map<string, RightsEvidenceLedgerRecord>,
  ledgerPath: string | null,
): RedistributionEvidenceAudit {
  const unevidenced: Array<{ id: string; gap: string }> = [];
  let claims = 0;
  for (const entry of entries) {
    if (entry.rights?.status !== 'redistributable') continue;
    claims += 1;
    const gap = redistributionEvidenceGap(entry.id, records.get(entry.id), ledgerPath);
    if (gap !== null) unevidenced.push({ id: entry.id, gap });
  }
  return { claims, evidenced: claims - unevidenced.length, unevidenced };
}

/** What the check read and what it found, for the caller's run report. */
export type RedistributionEvidenceCheck = { ledger: string | null; claims: number; evidenced: number };

/**
 * The fail-closed entry point for a run that republishes `rights` verbatim.
 *
 * Reads the journal named by `rightsEvidencePath`, or `<dataDir>/rights-evidence.jsonl`
 * when none is named, and throws — naming every affected entry — when an entry
 * this run would publish as `redistributable` has no recorded per-item licence
 * evidence behind it. Call it before anything is written: the point is that the
 * claim is not republished, not that it is republished and then reported.
 *
 * A named path that does not exist is a failure: a typo must not read as "no
 * claims to check".
 */
export function checkRedistributionEvidence(
  entries: ReadonlyArray<{ id: string; rights?: EntryRights | undefined }>,
  dataDir: string,
  rightsEvidencePath?: string,
): RedistributionEvidenceCheck {
  const ledgerPath = rightsEvidencePath ?? path.join(dataDir, RIGHTS_EVIDENCE_LEDGER_FILENAME);
  const exists = fs.existsSync(ledgerPath);
  if (rightsEvidencePath !== undefined && !exists) {
    throw new Error(`Rights-evidence journal not found at ${ledgerPath}.`);
  }
  const audit = auditRedistributionEvidence(
    entries,
    exists ? readRightsEvidenceLedger(ledgerPath) : new Map(),
    exists ? ledgerPath : null,
  );
  if (audit.unevidenced.length > 0) {
    throw new Error(describeRedistributionEvidenceFailure(audit, exists ? ledgerPath : null));
  }
  return { ledger: exists ? ledgerPath : null, claims: audit.claims, evidenced: audit.evidenced };
}

/** The first `limit` rows, so one failure names a blast radius rather than a wall. */
export function describeRedistributionEvidenceFailure(
  audit: RedistributionEvidenceAudit,
  ledgerPath: string | null,
  limit = 25,
): string {
  const lines = [
    `${audit.unevidenced.length} of ${audit.claims} entries would publish rights.status "redistributable" ` +
      'with no recorded per-item licence evidence behind the claim.',
    ledgerPath === null
      ? 'No rights-evidence journal was supplied to this run.'
      : `Rights-evidence journal read: ${ledgerPath}`,
    'The claim is not republished until the evidence is recorded; nothing was written.',
    ...audit.unevidenced.slice(0, limit).map((row) => `  ${row.id}: ${row.gap}`),
  ];
  if (audit.unevidenced.length > limit) lines.push(`  ... ${audit.unevidenced.length - limit} more`);
  return lines.join('\n');
}
