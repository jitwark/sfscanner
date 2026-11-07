import { PUBLIC_ROW_KEYS_V4 } from './public-row-contract.js';
import { isV4, canonicalJson, type ExportProjection } from './export-version.js';

export function preflightSheets(projection: ExportProjection): { name: string; rows: (string | number | boolean | null)[][] }[] {
  if (!isV4(projection)) return [];
  return (['preflightCoverage', 'preflightEvidence'] as const).map((relation) => {
    const keys = PUBLIC_ROW_KEYS_V4[relation];
    return {
      name: relation === 'preflightCoverage' ? 'Preflight Coverage' : 'Preflight Evidence',
      rows: [[...keys], ...projection[relation].map((row) => {
        const record = row as unknown as Record<string, unknown>;
        return keys.map((key) => Array.isArray(record[key]) ? canonicalJson(record[key]) : record[key] as string | number | null);
      })],
    };
  });
}
