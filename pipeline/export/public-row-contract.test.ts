import { describe, expect, it } from 'vitest';
import { PUBLIC_RELATION_NAMES } from '@hub/contracts/public-data-model';
import { SCAN_PROVENANCE_CASES, releaseForEntries } from '../__fixtures__/scan-provenance-cases.js';
import { buildPublicProjection } from './public-projection.js';
import { PUBLIC_FIELD_DEFINITIONS } from './public-data-dictionary.js';
import { PUBLIC_ROW_KEYS, publicNestedRowKeys } from './public-row-contract.js';

const entries = SCAN_PROVENANCE_CASES.map((scanCase) => scanCase.entry);
const projection = buildPublicProjection(entries, {
  release: releaseForEntries(entries),
  // Every case's own receipt and body hash, so the whole fixture corpus projects in one call.
  admittedIdentity: SCAN_PROVENANCE_CASES.find((scanCase) => scanCase.admittedIdentity)?.admittedIdentity,
  bodySha256ByWorkflowId: Object.assign({}, ...SCAN_PROVENANCE_CASES.map((scanCase) => scanCase.bodySha256ByWorkflowId ?? {})),
  scanReceiptsByWorkflowId: Object.assign({}, ...SCAN_PROVENANCE_CASES.map((scanCase) => scanCase.scanReceiptsByWorkflowId ?? {})),
});

describe('public row contract', () => {
  it('derives every relation top-level key order from the data dictionary and nothing else', () => {
    for (const relation of PUBLIC_RELATION_NAMES) {
      const dictionaryOrder = [...new Set(PUBLIC_FIELD_DEFINITIONS
        .filter((definition) => definition.relation === relation)
        .map((definition) => definition.field.split('.')[0]!))];
      expect(PUBLIC_ROW_KEYS[relation]).toEqual(dictionaryOrder);
    }
  });

  it('names the nested scan evidence keys in dictionary order', () => {
    expect(publicNestedRowKeys('workflows', 'scanEvidence')).toEqual(['scannerVersion', 'analysisStatus', 'scanFreshness', 'scanBodySha256']);
  });

  it('matches the exact keys of real projection rows, nested evidence included', () => {
    expect(projection.workflows).toHaveLength(SCAN_PROVENANCE_CASES.length);
    for (const relation of PUBLIC_RELATION_NAMES) {
      for (const row of projection[relation]) {
        expect(Object.keys(row as object)).toEqual([...PUBLIC_ROW_KEYS[relation]]);
      }
    }
    for (const row of projection.workflows) {
      expect(Object.keys(row.scanEvidence)).toEqual([...publicNestedRowKeys('workflows', 'scanEvidence')]);
    }
  });
});
