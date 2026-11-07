import { PUBLIC_RELATION_NAMES, type PublicRelationName } from '@hub/contracts/public-data-model';
import { PUBLIC_FIELD_DEFINITIONS, PUBLIC_FIELD_DEFINITIONS_V4 } from './public-data-dictionary.js';

/** One logical row field as the data dictionary names it. A dotted name is a nested object field. */
export type PublicRowFieldPath = readonly string[];

function buildRowFields(): Record<PublicRelationName, PublicRowFieldPath[]> {
  const fields = {} as Record<PublicRelationName, PublicRowFieldPath[]>;
  for (const relation of PUBLIC_RELATION_NAMES) fields[relation] = [];
  for (const { relation, field } of PUBLIC_FIELD_DEFINITIONS) {
    const path = field.split('.');
    if (path.length === 0 || path.length > 2 || path.some((segment) => segment.length === 0)) {
      throw new Error(`Public row contract: dictionary field ${relation}.${field} is not a one- or two-level path`);
    }
    fields[relation].push(path);
  }
  return fields;
}

/**
 * Every logical row field, in dictionary order. The dictionary is the single list of what a public
 * row carries; the writers below derive their keys from here, so a field cannot exist in the
 * dictionary and be dropped by a writer without this changing with it. Nested fields
 * (`scanEvidence.scanFreshness`) are one object field at the row root.
 */
export const PUBLIC_ROW_FIELDS: Record<PublicRelationName, readonly PublicRowFieldPath[]> = buildRowFields();

/**
 * The top-level key order of every relation row. This is what a writer's allowlist, a SQLite column
 * list and an Excel header row are built from, so the three format writers cannot disagree about
 * which keys a row has or in which order they appear.
 */
export const PUBLIC_ROW_KEYS: Record<PublicRelationName, readonly string[]> = (() => {
  const keys = {} as Record<PublicRelationName, string[]>;
  for (const relation of PUBLIC_RELATION_NAMES) {
    keys[relation] = [...new Set(PUBLIC_ROW_FIELDS[relation].map((path) => path[0]!))];
  }
  return keys;
})();

/** The key order of one nested object field, e.g. `publicNestedRowKeys('workflows', 'scanEvidence')`. */
export function publicNestedRowKeys(relation: PublicRelationName, root: string): readonly string[] {
  return PUBLIC_ROW_FIELDS[relation]
    .filter((path) => path.length === 2 && path[0] === root)
    .map((path) => path[1]!);
}

/** V4 extends the row allowlist without changing the legacy public constants. */
export const PUBLIC_ROW_KEYS_V4 = {
  ...PUBLIC_ROW_KEYS,
  preflightCoverage: PUBLIC_FIELD_DEFINITIONS_V4.filter((row) => row.relation === 'preflightCoverage').map((row) => row.field),
  preflightEvidence: PUBLIC_FIELD_DEFINITIONS_V4.filter((row) => row.relation === 'preflightEvidence').map((row) => row.field),
};
