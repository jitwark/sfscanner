import type { Entry } from '@hub/contracts';
import type { CorpusV2InputInventory } from '../../scripts/lib/corpus-v2-input-inventory.js';
import { ADMITTED_V2_SCAN_IDENTITY } from '../scan/v2-corpus-adapter.js';
import { BUILTIN_RULESET_AUTHORITY_V2, BUILTIN_SEMANTICS_AUTHORITY_V2 } from '../../packages/scanner-core/src/v2/admitted-registry.js';
import type { V2ScanEvidenceRecord, ScanFreshness } from './v2-scan-evidence.js';
import type { V2AnalyticsEvidence } from '@hub/contracts';

/** Canonical security and state projections for one applied v2 record. */
/** A row with no admitted result: no grade, no findings, and no claim that a scan happened. */
export function unavailableSecurity(ownerRuled: boolean): Entry['security'] {
  return {
    grade: 'UNKNOWN',
    score: 0,
    counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    findings: [],
    hardenedExtra: 0,
    scannerVersion: 'not-scanned',
    profile: 'beta-default',
    ...(ownerRuled ? { stampReason: 'source_unavailable' as const } : {}),
  };
}

/**
 * Rewrites one entry's canonical security from its own receipt. Nothing reads the entry's previous
 * stamp: an admitted v2 result is the only source of a current grade, and an absent result publishes
 * the explicit unavailable state.
 */
export function withSecurity(entry: Entry, record: V2ScanEvidenceRecord, state: ScanFreshness): Entry {
  const scan = record.scan;
  if (state === 'CURRENT' && scan?.ok === true) return { ...entry, security: scan.security };
  if (state === 'NO_RESULT' && scan !== null) {
    // Bytes read under the admitted identity, no native result: explicit, not retired, not missing.
    return {
      ...entry,
      security: {
        ...unavailableSecurity(false),
        schemaVersion: 'scanner-result-v2',
        scannerVersion: scan.identity.scannerVersion,
        analysisStatus: 'INDETERMINATE',
        noResult: true,
        noResultCode: scan.refusalCode ?? 'UNKNOWN_REFUSAL',
      },
    };
  }
  return { ...entry, security: unavailableSecurity(state === 'SOURCE_UNAVAILABLE') };
}

export function analyticsEvidence(
  inventory: CorpusV2InputInventory,
  records: readonly V2ScanEvidenceRecord[],
): V2AnalyticsEvidence {
  const states = { current: 0, noResult: 0, historical: 0, unscanned: 0, sourceUnavailable: 0 };
  const current = { complete: 0, degraded: 0, indeterminate: 0 };
  let excludedByRuling = 0;
  for (const record of records) {
    const scan = record.scan;
    switch (record.scanFreshness) {
      case 'CURRENT':
        states.current += 1;
        if (scan?.analysisStatus === 'COMPLETE') current.complete += 1;
        else if (scan?.analysisStatus === 'DEGRADED') current.degraded += 1;
        else current.indeterminate += 1;
        break;
      case 'NO_RESULT': states.noResult += 1; break;
      case 'HISTORICAL': states.historical += 1; break;
      case 'SOURCE_UNAVAILABLE':
        states.sourceUnavailable += 1;
        if (record.receiptReasonCode === 'RULING-1') excludedByRuling += 1;
        break;
      case 'UNSCANNED': states.unscanned += 1; break;
    }
  }
  return {
    scannerVersion: ADMITTED_V2_SCAN_IDENTITY.scannerVersion,
    engineBuildDigest: ADMITTED_V2_SCAN_IDENTITY.engineBuildDigest,
    profileId: ADMITTED_V2_SCAN_IDENTITY.profileId,
    profileVersion: ADMITTED_V2_SCAN_IDENTITY.profileVersion,
    rulesetId: BUILTIN_RULESET_AUTHORITY_V2.id,
    rulesetVersion: BUILTIN_RULESET_AUTHORITY_V2.version,
    rulesetDigest: ADMITTED_V2_SCAN_IDENTITY.rulesetDigest,
    signatureStatus: BUILTIN_RULESET_AUTHORITY_V2.signatureStatus,
    semanticsId: BUILTIN_SEMANTICS_AUTHORITY_V2.id,
    semanticsVersion: BUILTIN_SEMANTICS_AUTHORITY_V2.version,
    semanticsDigest: ADMITTED_V2_SCAN_IDENTITY.semanticsDigest,
    limitsDigest: ADMITTED_V2_SCAN_IDENTITY.limitsDigest,
    inventorySha256: inventory.inventorySha256,
    inventory: {
      available: inventory.counts.AVAILABLE,
      missing: inventory.counts.MISSING,
      sourceUnavailable: inventory.counts.SOURCE_UNAVAILABLE,
    },
    states,
    current,
    excludedByRuling,
  };
}
