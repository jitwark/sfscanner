import fs from 'node:fs';
import path from 'node:path';
import type { NodeCoverage, V2AnalyticsEvidence } from '@hub/contracts';

/**
 * The apply run's measured v2 analytics input: the aggregate state census and the complete
 * node/version inventory from the scanned bodies. Analytics is derived from this file rather than
 * recomputed from catalogue metadata, because versions are not stored on catalogue entries.
 */
export function assertEvidenceAccountsFor(entryCount: number, evidence: V2AnalyticsEvidence, scanned: number): void {
  const states = evidence.states;
  if (states.current + states.noResult + states.historical + states.unscanned + states.sourceUnavailable !== entryCount) {
    throw new TypeError('Corpus analytics: v2 states do not sum to the entry count.');
  }
  const statuses = evidence.current.complete + evidence.current.degraded + evidence.current.indeterminate;
  if (states.current !== statuses || statuses !== scanned) {
    throw new TypeError('Corpus analytics: v2 current statuses must equal states.current and scanCoverage.scanned.');
  }
}

export const V2_ANALYTICS_EVIDENCE_SCHEMA = 'v2-analytics-evidence-v1' as const;
export const V2_ANALYTICS_EVIDENCE_PATH = 'scanner/v2-analytics-evidence.json';

export type V2AnalyticsEvidenceSidecar = {
  schemaVersion: typeof V2_ANALYTICS_EVIDENCE_SCHEMA;
  v2Evidence: V2AnalyticsEvidence;
  nodeCoverage: NodeCoverage;
};

export function readV2AnalyticsEvidence(dataDir: string): { v2Evidence: V2AnalyticsEvidence; nodeCoverage: NodeCoverage } | null {
  const file = path.join(dataDir, V2_ANALYTICS_EVIDENCE_PATH);
  // A legacy v1 regeneration tree carries no v2 evidence; the caller states that explicitly rather
  // than this loader inventing an identity for it.
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<V2AnalyticsEvidenceSidecar>;
  if (value.schemaVersion !== V2_ANALYTICS_EVIDENCE_SCHEMA || value.v2Evidence === undefined || value.nodeCoverage === undefined) {
    throw new Error(`Unsupported v2 analytics evidence at ${file}.`);
  }
  return { v2Evidence: value.v2Evidence, nodeCoverage: value.nodeCoverage };
}
