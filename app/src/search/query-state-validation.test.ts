import { describe, expect, it } from 'vitest';
import type { QueryState } from './query-state';
import { validateQueryStateAgainstRelease, type QueryStateReleaseCatalogue } from './query-state-validation';

const catalogue: QueryStateReleaseCatalogue = {
  repeatableFacetValues: {
    integration: ['gmail', 'slack'],
    tag: ['alerts', 'daily'],
    trigger: ['webhook', 'schedule'],
    capability: ['code', 'ai'],
  },
  scalarFacetValues: {
    complexity: ['simple', 'medium'],
    grade: ['LOW', 'HIGH'],
    rights: ['redistributable', 'link_only'],
  },
  sortModes: ['relevance', 'quality'],
};

const state: QueryState = {
  q: 'slack alerts',
  integration: ['slack', 'retired-crm'],
  tag: ['retired-tag', 'alerts'],
  trigger: ['webhook'],
  capability: ['ai'],
  complexity: 'retired-complexity',
  grade: 'LOW',
  rights: 'retired-rights',
  sort: 'alphabetical',
  page: 3,
};

describe('validateQueryStateAgainstRelease', () => {
  it('separates unknown repeatable values, scalar values, and sort modes', () => {
    expect(validateQueryStateAgainstRelease(state, catalogue)).toEqual({
      unknownRepeatableFacetValues: [
        { facet: 'integration', value: 'retired-crm' },
        { facet: 'tag', value: 'retired-tag' },
      ],
      unknownScalarFacetValues: [
        { facet: 'complexity', value: 'retired-complexity' },
        { facet: 'rights', value: 'retired-rights' },
      ],
      unsupportedSortMode: 'alphabetical',
    });
  });

  it('does not mutate the saved query state and ignores inactive empty values', () => {
    const saved: QueryState = { ...state, integration: ['slack', ''], tag: [], complexity: '', grade: '', rights: '', sort: 'relevance' };
    const before = structuredClone(saved);

    expect(validateQueryStateAgainstRelease(saved, catalogue)).toEqual({
      unknownRepeatableFacetValues: [],
      unknownScalarFacetValues: [],
      unsupportedSortMode: null,
    });
    expect(saved).toEqual(before);
  });
});
