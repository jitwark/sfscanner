import type { Entry } from '@hub/contracts';
import { isAdmittedV2ScanIdentity } from '../scan/v2-corpus-adapter.js';
import { scanEvidence, type ScanProvenanceOptions } from './scan-provenance.js';

/** The population census the export certifies, independent of redistribution rights. */
export type ScanFreshnessCensus = Readonly<{
  total: number;
  current: number;
  noResult: number;
  historical: number;
  unscanned: number;
  sourceUnavailable: number;
}>;

export function scanFreshnessCensus(entries: readonly Entry[], options: ScanProvenanceOptions): ScanFreshnessCensus {
  const census = { total: entries.length, current: 0, noResult: 0, historical: 0, unscanned: 0, sourceUnavailable: 0 };
  for (const entry of entries) {
    switch (scanEvidence(entry, options).scanFreshness) {
      case 'CURRENT': census.current += 1; break;
      case 'NO_RESULT': census.noResult += 1; break;
      case 'HISTORICAL': census.historical += 1; break;
      case 'UNSCANNED': census.unscanned += 1; break;
      case 'SOURCE_UNAVAILABLE': census.sourceUnavailable += 1; break;
    }
  }
  return Object.freeze(census);
}

/**
 * Refuses to export a population that cannot certify its own freshness: no admitted identity, no
 * receipts at all, or no row that survived admission. A partial receipt set is still exported, but
 * the census states the unadmitted remainder instead of letting it read as current.
 */
export function certifyScanFreshness(entries: readonly Entry[], options: ScanProvenanceOptions): ScanFreshnessCensus {
  if (options.admittedIdentity === undefined || !isAdmittedV2ScanIdentity(options.admittedIdentity)) {
    throw new Error('Scan freshness: the export names no admitted identity tuple.');
  }
  if (Object.keys(options.scanReceiptsByWorkflowId ?? {}).length === 0) {
    throw new Error('Scan freshness: the export carries no scan receipts.');
  }
  const census = scanFreshnessCensus(entries, options);
  if (census.current === 0) {
    throw new Error(`Scan freshness: 0 of ${census.total} rows reached CURRENT; refusing to certify an empty current population.`);
  }
  return census;
}
