import type { Entry } from '@hub/contracts';
import {
  PUBLIC_DATA_MODEL_SCHEMA_VERSION,
  type PublicReleaseMetadata,
  type PublicWorkflowRow,
} from '../../contracts/public-data-model.js';
import type { PublicScanReceipt } from '../export/scan-provenance.js';
import { ADMITTED_V2_SCAN_IDENTITY } from '../scan/v2-corpus-adapter.js';
import { makeEntry } from './make-entry.js';

/**
 * One row shape from the real corpus plus the public evidence that row must export. The shapes are
 * the ones the 2026-10-17 audit counted in `data/catalogue-0..5.json`: 11,287 `scanner-beta-1`
 * verdicts (221 of them with unscanned readiness), 110 `c998701` build stamps, 67 owner-ruled rows,
 * 8 retained `INDETERMINATE` rows. They live here rather than in the test so the test file stays
 * under its line ceiling while each case keeps its own named assertion.
 */
export type ScanProvenanceCase = {
  name: string;
  entry: Entry;
  admittedIdentity?: PublicScanReceipt['identity'];
  bodySha256ByWorkflowId?: Readonly<Record<string, string | undefined>>;
  scanReceiptsByWorkflowId?: Readonly<Record<string, PublicScanReceipt | undefined>>;
  expected: {
    grade: PublicWorkflowRow['grade'];
    score: PublicWorkflowRow['score'];
    scanEvidence: PublicWorkflowRow['scanEvidence'];
    bodySha256: string | null;
  };
};

const SCAN_HASH = 'e'.repeat(64);
const PACK_HASH = 'c'.repeat(64);
/** `ADMITTED_ENGINE_VERSION` in `packages/scanner-core/src/v2/admitted-registry.ts`. */
const ADMITTED = '2.0.0';
const ADMITTED_IDENTITY = ADMITTED_V2_SCAN_IDENTITY;

const derived: Entry['readiness'] = {
  analysis: 'derived',
  credentials: [],
  replaceableValues: [],
  writeActions: [],
  aiModel: { present: false, model: null },
  extraPackages: [],
  versionNotes: [],
  pinnedData: { present: false, nodeCount: 0 },
  isSubWorkflow: false,
};
const unscanned: Entry['readiness'] = { ...derived, analysis: 'unscanned' };
const linkOnly = { status: 'link_only' as const, licence: null, licenceUrl: null };
const noEvidence = { scannerVersion: null, analysisStatus: null, scanBodySha256: null };
const noGrade = { grade: { status: 'unknown' as const, value: null }, score: { status: 'unknown' as const, value: null } };

function receipt(analysisStatus: PublicScanReceipt['analysisStatus'], entryId: string): PublicScanReceipt {
  return { entryId, identity: ADMITTED_IDENTITY, outcome: 'RESULT', analysisStatus, bodySha256: SCAN_HASH, resultDigest: 'd'.repeat(64) };
}
function refusedReceipt(entryId: string): PublicScanReceipt {
  return { entryId, identity: ADMITTED_IDENTITY, outcome: 'REFUSED', analysisStatus: 'INDETERMINATE', bodySha256: SCAN_HASH, resultDigest: null };
}

/**
 * The release a single-row case needs. `scannerVersion` is the value the shipped release row carries
 * today — the release's own scanner identity, which is release identity only, never a row's. A
 * freshness derived from it fails a case that must classify differently.
 */
export function releaseForEntries(entries: readonly Entry[]): PublicReleaseMetadata {
  const rights = { redistributable: 0, linkOnly: 0, excluded: 0 };
  for (const entry of entries) {
    if (entry.rights.status === 'redistributable') rights.redistributable += 1;
    if (entry.rights.status === 'link_only') rights.linkOnly += 1;
    if (entry.rights.status === 'excluded') rights.excluded += 1;
  }
  return {
    releaseId: 'release-scan-provenance',
    schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
    generatedAt: '2026-10-17T00:00:00.000Z',
    toolVersion: 'n8n-secureflow@0.1.0',
    scannerVersion: 'scanner-beta-1',
    policyVersion: 'policy-v1',
    searchIndexVersion: 'search-index-v2',
    buildRevision: 'build-revision',
    manifestSha256: 'a'.repeat(64),
    corpusSha256: 'b'.repeat(64),
    counts: {
      workflows: entries.length,
      redistributable: rights.redistributable,
      linkOnly: rights.linkOnly,
      excluded: 0,
      findings: entries.reduce((total, entry) => total + entry.security.findings.length, 0),
    },
    facetCounts: { rights: { redistributable: rights.redistributable, linkOnly: rights.linkOnly, excluded: 0 } },
  };
}

export const SCAN_PROVENANCE_CASES: readonly ScanProvenanceCase[] = [
  {
    name: 'a current admitted scan publishes its grade and the receipt digest, never the pack hash',
    entry: {
      ...makeEntry({
        id: 'current',
        download: { pack: 0, line: 0, offset: 0, length: 1 },
        security: { scannerVersion: ADMITTED, analysisStatus: 'COMPLETE', grade: 'MEDIUM', score: 55 },
      }),
      readiness: derived,
    },
    admittedIdentity: ADMITTED_IDENTITY,
    bodySha256ByWorkflowId: { current: PACK_HASH },
    scanReceiptsByWorkflowId: { current: receipt('COMPLETE', 'current') },
    expected: {
      grade: { status: 'known', value: 'MEDIUM' },
      score: { status: 'known', value: 55 },
      scanEvidence: { scannerVersion: ADMITTED, analysisStatus: 'COMPLETE', scanFreshness: 'CURRENT', scanBodySha256: SCAN_HASH },
      bodySha256: PACK_HASH,
    },
  },
  {
    name: 'a link-only row with an admitted scan is CURRENT: rights never decide freshness',
    entry: {
      ...makeEntry({ id: 'link-only-current', rights: linkOnly, security: { scannerVersion: ADMITTED, analysisStatus: 'COMPLETE', grade: 'LOW', score: 80 } }),
      readiness: derived,
    },
    admittedIdentity: ADMITTED_IDENTITY,
    scanReceiptsByWorkflowId: { 'link-only-current': receipt('COMPLETE', 'link-only-current') },
    expected: {
      grade: { status: 'known', value: 'LOW' },
      score: { status: 'known', value: 80 },
      scanEvidence: { scannerVersion: ADMITTED, analysisStatus: 'COMPLETE', scanFreshness: 'CURRENT', scanBodySha256: SCAN_HASH },
      bodySha256: null,
    },
  },
  {
    name: 'a current-identity refusal is NO_RESULT with no grade and a bound body digest',
    entry: {
      ...makeEntry({ id: 'refused-current', rights: linkOnly, security: {
        schemaVersion: 'scanner-result-v2', scannerVersion: '2.0.0', profile: 'beta-default',
        grade: 'UNKNOWN', score: 0, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        findings: [], hardenedExtra: 0, analysisStatus: 'INDETERMINATE',
        noResult: true, noResultCode: 'SEMANTIC_CATALOGUE_INVALID',
      } }),
      readiness: derived,
    },
    admittedIdentity: ADMITTED_IDENTITY,
    scanReceiptsByWorkflowId: { 'refused-current': refusedReceipt('refused-current') },
    expected: {
      ...noGrade,
      scanEvidence: { scannerVersion: ADMITTED, analysisStatus: 'INDETERMINATE', scanFreshness: 'NO_RESULT', scanBodySha256: SCAN_HASH },
      bodySha256: null,
    },
  },
  {
    name: 'a retained COMPLETE verdict with unscanned readiness stays HISTORICAL, receipt or not',
    entry: {
      ...makeEntry({ id: 'retained-complete', rights: linkOnly, security: { scannerVersion: 'scanner-beta-1', analysisStatus: 'COMPLETE', grade: 'HIGH', score: 20 } }),
      readiness: unscanned,
    },
    admittedIdentity: ADMITTED_IDENTITY,
    scanReceiptsByWorkflowId: { 'retained-complete': receipt('COMPLETE', 'retained-complete') },
    expected: {
      grade: { status: 'known', value: 'HIGH' },
      score: { status: 'known', value: 20 },
      scanEvidence: { scannerVersion: 'scanner-beta-1', analysisStatus: 'COMPLETE', scanFreshness: 'HISTORICAL', scanBodySha256: null },
      bodySha256: null,
    },
  },
  {
    name: 'the c998701 build stamp is a retired identity, not an engine: HISTORICAL with no status',
    entry: {
      ...makeEntry({ id: 'legacy-stamp', rights: linkOnly, security: { scannerVersion: 'c998701', grade: 'LOW', score: 70 } }),
      readiness: unscanned,
    },
    expected: {
      grade: { status: 'known', value: 'LOW' },
      score: { status: 'known', value: 70 },
      scanEvidence: { scannerVersion: 'c998701', analysisStatus: null, scanFreshness: 'HISTORICAL', scanBodySha256: null },
      bodySha256: null,
    },
  },
  {
    name: 'a retained INDETERMINATE verdict carries its status and publishes no grade',
    entry: {
      ...makeEntry({ id: 'indeterminate-retained', rights: linkOnly, security: { scannerVersion: 'scanner-beta-1', analysisStatus: 'INDETERMINATE', grade: 'UNKNOWN', score: 0 } }),
      readiness: derived,
    },
    expected: {
      ...noGrade,
      scanEvidence: { scannerVersion: 'scanner-beta-1', analysisStatus: 'INDETERMINATE', scanFreshness: 'HISTORICAL', scanBodySha256: null },
      bodySha256: null,
    },
  },
  {
    name: 'an admitted INDETERMINATE scan is CURRENT with a null assessment',
    entry: {
      ...makeEntry({ id: 'indeterminate-current', rights: linkOnly, security: { scannerVersion: ADMITTED, analysisStatus: 'INDETERMINATE', grade: 'UNKNOWN', score: 0 } }),
      readiness: derived,
    },
    admittedIdentity: ADMITTED_IDENTITY,
    scanReceiptsByWorkflowId: { 'indeterminate-current': receipt('INDETERMINATE', 'indeterminate-current') },
    expected: {
      ...noGrade,
      scanEvidence: { scannerVersion: ADMITTED, analysisStatus: 'INDETERMINATE', scanFreshness: 'CURRENT', scanBodySha256: SCAN_HASH },
      bodySha256: null,
    },
  },
  {
    name: 'an owner ruling wins over everything after it and exports no retained grade',
    entry: {
      ...makeEntry({ id: 'source-unavailable', rights: linkOnly, security: { scannerVersion: 'not-scanned', stampReason: 'source_unavailable', grade: 'MEDIUM', score: 50 } }),
      readiness: unscanned,
    },
    admittedIdentity: ADMITTED_IDENTITY,
    scanReceiptsByWorkflowId: { 'source-unavailable': receipt('COMPLETE', 'source-unavailable') },
    expected: { ...noGrade, scanEvidence: { ...noEvidence, scanFreshness: 'SOURCE_UNAVAILABLE' }, bodySha256: null },
  },
  {
    name: 'a no-body stamp with no recorded reason and no retained verdict is UNSCANNED',
    entry: {
      ...makeEntry({ id: 'never-scanned', rights: linkOnly, security: { scannerVersion: 'not-scanned', grade: 'UNKNOWN', score: 0 } }),
      readiness: unscanned,
    },
    expected: { ...noGrade, scanEvidence: { ...noEvidence, scanFreshness: 'UNSCANNED' }, bodySha256: null },
  },
  {
    name: 'a retained UNKNOWN grade is not a grade: it exports unknown/null, never known UNKNOWN',
    entry: {
      ...makeEntry({ id: 'unknown-grade', rights: linkOnly, security: { scannerVersion: 'scanner-beta-1', analysisStatus: 'COMPLETE', grade: 'UNKNOWN', score: 0 } }),
      readiness: derived,
    },
    expected: {
      ...noGrade,
      scanEvidence: { scannerVersion: 'scanner-beta-1', analysisStatus: 'COMPLETE', scanFreshness: 'HISTORICAL', scanBodySha256: null },
      bodySha256: null,
    },
  },
  {
    name: 'a receipt with a retired engine build is not current even with the admitted version',
    entry: {
      ...makeEntry({ id: 'stale-build', rights: linkOnly, security: { scannerVersion: 'scanner-beta-1', analysisStatus: 'COMPLETE', grade: 'MEDIUM', score: 40 } }),
      readiness: derived,
    },
    admittedIdentity: ADMITTED_IDENTITY,
    scanReceiptsByWorkflowId: {
      'stale-build': { ...receipt('COMPLETE', 'stale-build'), identity: { ...ADMITTED_IDENTITY, engineBuildDigest: 'f'.repeat(64) } },
    },
    expected: {
      grade: { status: 'known', value: 'MEDIUM' },
      score: { status: 'known', value: 40 },
      scanEvidence: { scannerVersion: 'scanner-beta-1', analysisStatus: 'COMPLETE', scanFreshness: 'HISTORICAL', scanBodySha256: null },
      bodySha256: null,
    },
  },
  {
    name: 'a receipt bound to another entry id is not current',
    entry: {
      ...makeEntry({ id: 'wrong-entry', rights: linkOnly, security: { scannerVersion: 'scanner-beta-1', analysisStatus: 'COMPLETE', grade: 'MEDIUM', score: 40 } }),
      readiness: derived,
    },
    admittedIdentity: ADMITTED_IDENTITY,
    scanReceiptsByWorkflowId: { 'wrong-entry': receipt('COMPLETE', 'some-other-entry') },
    expected: {
      grade: { status: 'known', value: 'MEDIUM' },
      score: { status: 'known', value: 40 },
      scanEvidence: { scannerVersion: 'scanner-beta-1', analysisStatus: 'COMPLETE', scanFreshness: 'HISTORICAL', scanBodySha256: null },
      bodySha256: null,
    },
  },
  {
    name: 'a receipt without an admitted registry value leaves the row HISTORICAL',
    entry: {
      ...makeEntry({ id: 'no-admitted-registry', rights: linkOnly, security: { scannerVersion: 'scanner-beta-1', analysisStatus: 'COMPLETE', grade: 'HIGH', score: 30 } }),
      readiness: derived,
    },
    scanReceiptsByWorkflowId: { 'no-admitted-registry': receipt('COMPLETE', 'no-admitted-registry') },
    expected: {
      grade: { status: 'known', value: 'HIGH' },
      score: { status: 'known', value: 30 },
      scanEvidence: { scannerVersion: 'scanner-beta-1', analysisStatus: 'COMPLETE', scanFreshness: 'HISTORICAL', scanBodySha256: null },
      bodySha256: null,
    },
  },
];
