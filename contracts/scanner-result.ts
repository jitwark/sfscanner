/**
 * Identity for the serialized deterministic scanner result. Bump this when
 * result fields or their semantics change incompatibly.
 */
export const SCANNER_RESULT_SCHEMA_VERSION = 'scanner-result-v1' as const;

export type ScannerResultSchemaVersion = typeof SCANNER_RESULT_SCHEMA_VERSION;

export type ScannerResultIdentity = {
  schemaVersion: ScannerResultSchemaVersion;
};

/** Fails closed before an authoritative result is projected or published. */
export function parseScannerResultSchemaVersion(value: unknown): ScannerResultSchemaVersion {
  if (value === undefined || value === null || value === '') {
    throw new Error('Scanner result is missing schemaVersion');
  }
  if (value !== SCANNER_RESULT_SCHEMA_VERSION) {
    throw new Error(`Scanner result has unsupported schemaVersion: ${String(value)}`);
  }
  return SCANNER_RESULT_SCHEMA_VERSION;
}
