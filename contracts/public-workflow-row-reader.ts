import {
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V1,
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V2,
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3,
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4,
  PUBLIC_SCAN_FRESHNESS_VALUES,
  type PublicWorkflowRow,
  type PublicWorkflowRowV1,
  type PublicWorkflowRowsReading,
  type PublicWorkflowScanEvidence,
} from './public-data-model';

const ANALYSIS_STATUSES: Record<string, true> = { COMPLETE: true, DEGRADED: true, INDETERMINATE: true };
const SHA256 = /^[0-9a-f]{64}$/;
const isUnknownFact = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  const fact = value as { status?: unknown; value?: unknown };
  return (fact.status === 'unknown' || fact.status === 'not-applicable') && fact.value === null;
};

const V2_FRESHNESS: Record<string, true> = { CURRENT: true, HISTORICAL: true, UNSCANNED: true, SOURCE_UNAVAILABLE: true };

function isScanEvidence(value: unknown, allowNoResult: boolean): value is PublicWorkflowScanEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const { scannerVersion, analysisStatus, scanFreshness, scanBodySha256 } = value as Record<string, unknown>;
  const allowed = allowNoResult ? PUBLIC_SCAN_FRESHNESS_VALUES : Object.keys(V2_FRESHNESS);
  const refusal = scanFreshness === 'NO_RESULT';
  return (scannerVersion === null || typeof scannerVersion === 'string')
    && (analysisStatus === null || (typeof analysisStatus === 'string' && ANALYSIS_STATUSES[analysisStatus] === true))
    && typeof scanFreshness === 'string' && (allowed as readonly string[]).includes(scanFreshness)
    && (scanBodySha256 === null || (typeof scanBodySha256 === 'string' && SHA256.test(scanBodySha256)))
    // NO_RESULT means bytes were read and no result was produced: no result status, and a bound body.
    && (!refusal || (analysisStatus === 'INDETERMINATE' && typeof scanBodySha256 === 'string' && SHA256.test(scanBodySha256)));
}

/** Reads the workflows relation at the version the document declares; no state is invented. */
export function readPublicWorkflowRows(document: unknown): PublicWorkflowRowsReading {
  if (typeof document !== 'object' || document === null) throw new Error('Public model: document is not an object');
  const { schemaVersion, workflows } = document as { schemaVersion?: unknown; workflows?: unknown };
  const known = schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V1
    || schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V2
    || schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3
    || schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4;
  if (!known) throw new Error('Public model: unsupported schema version');
  if (!Array.isArray(workflows)) throw new Error('Public model: workflows relation is not an array');
  const rows = workflows as readonly Record<string, unknown>[];
  if (schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V1) {
    if (rows.some((row) => typeof row === 'object' && row !== null && 'scanEvidence' in row)) {
      throw new Error('Public model: a public-data-model-v1 row carries scan evidence, which v1 does not define');
    }
    return { schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION_V1, workflows: rows as unknown as readonly PublicWorkflowRowV1[] };
  }
  const allowNoResult = schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3
    || schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4;
  for (const row of rows) {
    const evidence = typeof row === 'object' && row !== null ? row.scanEvidence : undefined;
    if (!isScanEvidence(evidence, allowNoResult)) {
      throw new Error(`Public model: a ${String(schemaVersion)} workflow row carries no valid scan evidence`);
    }
    if (allowNoResult && evidence.scanFreshness === 'NO_RESULT' && (!isUnknownFact(row.grade) || !isUnknownFact(row.score))) {
      throw new Error('Public model: a NO_RESULT row must publish an unknown assessment and score');
    }
  }
  return { schemaVersion, workflows: rows as unknown as readonly PublicWorkflowRow[] };
}
