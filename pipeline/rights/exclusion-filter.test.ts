import { describe, expect, it } from 'vitest';
import { createExclusionRegistry, type ExclusionRegistry } from '@hub/contracts';
import { makeCandidate } from '../__fixtures__/make-entry.js';
import { PRODUCTION_EXCLUSION_REGISTRY, filterExcludedCandidates } from './exclusion-filter.js';

const EXCLUDED_ID = 'a1b2c3d4e5f60718';
const KEPT_ID = '0011223344556677';

function registryExcluding(id: string): ExclusionRegistry {
  return createExclusionRegistry([{ id, reason: 'test exclusion', excludedAt: '2026-08-27T00:00:00.000Z' }]);
}

describe('filterExcludedCandidates', () => {
  it('drops a candidate whose id the registry recognizes', () => {
    const excludedCandidate = makeCandidate({ id: EXCLUDED_ID });
    const keptCandidate = makeCandidate({ id: KEPT_ID });

    const result = filterExcludedCandidates([excludedCandidate, keptCandidate], registryExcluding(EXCLUDED_ID));

    expect(result.included.map((c) => c.id)).toEqual([KEPT_ID]);
    expect(result.excluded.map((c) => c.id)).toEqual([EXCLUDED_ID]);
  });

  it('passes every candidate through unchanged when nothing matches', () => {
    const candidates = [makeCandidate({ id: KEPT_ID }), makeCandidate({ id: 'ffffffffffffffff' })];
    const result = filterExcludedCandidates(candidates, registryExcluding(EXCLUDED_ID));

    expect(result.included).toHaveLength(2);
    expect(result.excluded).toHaveLength(0);
  });

  it('excludes every matching candidate, not just the first', () => {
    const candidates = [
      makeCandidate({ id: EXCLUDED_ID }),
      makeCandidate({ id: KEPT_ID }),
      makeCandidate({ id: EXCLUDED_ID }),
    ];
    const result = filterExcludedCandidates(candidates, registryExcluding(EXCLUDED_ID));

    expect(result.included).toHaveLength(1);
    expect(result.excluded).toHaveLength(2);
  });

  it('defaults to the production registry when none is passed', () => {
    // The production registry is empty until the owner's retention/exclusion
    // policy supplies real ids (tasks.md [B] item), so the default call must
    // keep every candidate.
    const candidates = [makeCandidate({ id: KEPT_ID })];
    const result = filterExcludedCandidates(candidates);

    expect(result.included).toHaveLength(1);
    expect(result.excluded).toHaveLength(0);
    expect(PRODUCTION_EXCLUSION_REGISTRY.records).toEqual([]);
  });
});
