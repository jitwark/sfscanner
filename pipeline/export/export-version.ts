import {
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4, PUBLIC_RELATION_NAMES, PUBLIC_RELATION_NAMES_V4,
  type PublicDataProjection, type PublicDataProjectionV4, type PublicRelationNameV4,
} from '@hub/contracts/public-data-model';
import { publicDataDictionaryRows, publicDataDictionaryRowsV4 } from './public-data-dictionary.js';

export type ExportProjection = PublicDataProjection | PublicDataProjectionV4;
export type ExportRelease = ExportProjection['release'];
export const isV4 = (projection: Pick<ExportProjection, 'schemaVersion'>): projection is PublicDataProjectionV4 => projection.schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4;
export function relationNames(projection: Pick<ExportProjection, 'schemaVersion'>): readonly PublicRelationNameV4[] {
  return isV4(projection) ? PUBLIC_RELATION_NAMES_V4 : PUBLIC_RELATION_NAMES;
}
export function dictionaryRows(projection: Pick<ExportProjection, 'schemaVersion'>) {
  return isV4(projection) ? publicDataDictionaryRowsV4() : publicDataDictionaryRows();
}
export function relationRows(projection: ExportProjection, relation: PublicRelationNameV4): readonly unknown[] {
  if (relation === 'preflightCoverage' || relation === 'preflightEvidence') {
    if (!isV4(projection)) throw new Error('V4 relation requested from a legacy projection');
    return projection[relation];
  }
  return projection[relation];
}

/** Canonical nested arrays and objects, shared with physical JSON columns and identity seals. */
export function canonicalJson(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical((v as Record<string, unknown>)[key])])) : v;
  return JSON.stringify(canonical(value));
}
