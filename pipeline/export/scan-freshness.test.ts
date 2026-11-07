import { describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { ADMITTED_V2_SCAN_IDENTITY } from '../scan/v2-corpus-adapter.js';
import { certifyScanFreshness, scanFreshnessCensus } from './scan-freshness.js';

const receipt = (entryId: string, analysisStatus: 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE' = 'COMPLETE') => ({
  entryId,
  identity: ADMITTED_V2_SCAN_IDENTITY,
  outcome: 'RESULT' as const,
  analysisStatus,
  bodySha256: 'a'.repeat(64),
  resultDigest: 'b'.repeat(64),
});

const readiness: NonNullable<Entry['readiness']> = {
  analysis: 'derived', credentials: [], replaceableValues: [], writeActions: [],
  aiModel: { present: false, model: null }, extraPackages: [], versionNotes: [],
  pinnedData: { present: false, nodeCount: 0 }, isSubWorkflow: false,
};
const unscanned: NonNullable<Entry['readiness']> = { ...readiness, analysis: 'unscanned' };
const entries: Entry[] = [
  { ...makeEntry({ id: 'current', security: { scannerVersion: '2.0.0', analysisStatus: 'COMPLETE', grade: 'LOW', score: 90 } }), readiness },
  { ...makeEntry({ id: 'current-degraded', security: { scannerVersion: '2.0.0', analysisStatus: 'DEGRADED', grade: 'MEDIUM', score: 50 } }), readiness },
  { ...makeEntry({ id: 'no-input', security: { scannerVersion: 'not-scanned', grade: 'UNKNOWN', score: 0 } }), readiness: unscanned },
  { ...makeEntry({ id: 'ruled', security: { scannerVersion: 'not-scanned', stampReason: 'source_unavailable', grade: 'UNKNOWN', score: 0 } }), readiness: unscanned },
];

const options = {
  admittedIdentity: ADMITTED_V2_SCAN_IDENTITY,
  scanReceiptsByWorkflowId: {
    current: receipt('current'),
    'current-degraded': receipt('current-degraded', 'DEGRADED'),
  },
};

describe('v2 scan freshness census', () => {
  it('classifies every row and sums to the population', () => {
    expect(scanFreshnessCensus(entries, options)).toEqual({
      total: 4, current: 2, noResult: 0, historical: 0, unscanned: 1, sourceUnavailable: 1,
    });
  });

  it('refuses an export that names no admitted identity or carries no receipts', () => {
    expect(() => certifyScanFreshness(entries, { scanReceiptsByWorkflowId: options.scanReceiptsByWorkflowId })).toThrow(/admitted identity/);
    expect(() => certifyScanFreshness(entries, { admittedIdentity: ADMITTED_V2_SCAN_IDENTITY, scanReceiptsByWorkflowId: {} })).toThrow(/no scan receipts/);
  });

  it('fails closed when a row records an engine refusal without a bound refusal receipt', () => {
    const refusedEntry = makeEntry({ id: 'refused', security: { scannerVersion: '2.0.0', analysisStatus: 'INDETERMINATE', grade: 'UNKNOWN', score: 0 } });
    const noResult: Entry = { ...refusedEntry, readiness, security: { ...refusedEntry.security, noResult: true, noResultCode: 'SEMANTIC_CATALOGUE_INVALID' } };
    expect(() => scanFreshnessCensus([noResult], { admittedIdentity: ADMITTED_V2_SCAN_IDENTITY, scanReceiptsByWorkflowId: {} })).toThrow(/refusal without a bound refusal receipt/);
  });

  it('refuses a receipt set in which no row survives admission', () => {
    expect(() => certifyScanFreshness(entries, {
      admittedIdentity: ADMITTED_V2_SCAN_IDENTITY,
      scanReceiptsByWorkflowId: { current: { ...receipt('current'), identity: { ...ADMITTED_V2_SCAN_IDENTITY, limitsDigest: 'f'.repeat(64) } } },
    })).toThrow(/0 of 4 rows reached CURRENT/);
  });
});
