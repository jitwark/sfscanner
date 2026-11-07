import { describe, expect, it } from 'vitest';
import {
  SCANNER_RESULT_SCHEMA_VERSION,
  parseScannerResultSchemaVersion,
} from './scanner-result';

describe('scanner result schema identity', () => {
  it('accepts the current schema identity', () => {
    expect(SCANNER_RESULT_SCHEMA_VERSION).toBe('scanner-result-v1');
    expect(parseScannerResultSchemaVersion(SCANNER_RESULT_SCHEMA_VERSION)).toBe(
      SCANNER_RESULT_SCHEMA_VERSION,
    );
  });

  it.each([undefined, null, '', 'scanner-result-v0', 'scanner-result-v2'])(
    'rejects missing or unsupported identity %j',
    (value) => {
      expect(() => parseScannerResultSchemaVersion(value)).toThrow(/schemaVersion/i);
    },
  );
});
