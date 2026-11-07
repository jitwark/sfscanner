import type { ScannerResultSchemaVersion } from './scanner-result';

/**
 * The published security contract: the closed vocabularies a verdict is spoken
 * in, the redacted projection of a single scanner finding, and the block every
 * entry ships.
 *
 * These shapes reach a public page, so they carry codes, counts, and prose only
 * — never evidence, locations, or code.
 */

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export type Grade = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

/** Redacted projection of a scanner finding. Never carries evidence or code. */
export type PublicFinding = {
  id: string;
  title: string;
  severity: Severity;
  node?: string;
  why: string;
  fix: string;
};

export type EntrySecurity = {
  grade: Grade;
  score: number;
  counts: { critical: number; high: number; medium: number; low: number; info: number };
  findings: PublicFinding[];
  /** Extra findings surfaced only by the hardened profile. */
  hardenedExtra: number;
  scannerVersion: string;
  profile: 'beta-default' | 'beta-hardened';
  /** Absent pre-existing; INDETERMINATE forces grade UNKNOWN. Codes only, never locations/evidence. */
  analysisStatus?: 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE';
  analysisDiagnosticCodes?: string[];
  /**
   * Scanner-authoritative output identity; legacy unscanned fallbacks omit it. A v2 result keeps
   * its own identity so a row cannot present a v2 projection as a v1 result.
   */
  schemaVersion?: ScannerResultSchemaVersion | 'scanner-result-v2';
  /**
   * Why a `not-scanned` stamp was written, when the reason is not "the row has no
   * body". `source_unavailable` means the row *has* a body but its upstream source
   * could not be re-acquired to re-run the scan, so the verdict shipped is the one
   * already recorded. Recording no reason would leave those rows indistinguishable
   * from rows that never had a body.
   */
  stampReason?: 'source_unavailable';
  /**
   * The engine read this row's body under the admitted identity and refused to produce a result.
   * No grade, no findings and no digest are implied; the refusal reason is a closed code.
   */
  noResult?: true;
  noResultCode?: string;
};
