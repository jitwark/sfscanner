import type { QueryState } from './query-state';

export type RepeatableQueryFacet = 'integration' | 'tag' | 'trigger' | 'capability';
export type ScalarQueryFacet = 'complexity' | 'grade' | 'rights';

export type QueryStateReleaseCatalogue = {
  repeatableFacetValues: Readonly<Record<RepeatableQueryFacet, readonly string[]>>;
  scalarFacetValues: Readonly<Record<ScalarQueryFacet, readonly string[]>>;
  sortModes: readonly string[];
};

export type UnknownRepeatableFacetValue = {
  facet: RepeatableQueryFacet;
  value: string;
};

export type UnknownScalarFacetValue = {
  facet: ScalarQueryFacet;
  value: string;
};

export type QueryStateValidation = {
  unknownRepeatableFacetValues: UnknownRepeatableFacetValue[];
  unknownScalarFacetValues: UnknownScalarFacetValue[];
  unsupportedSortMode: string | null;
};

const repeatableFacets: readonly RepeatableQueryFacet[] = ['integration', 'tag', 'trigger', 'capability'];
const scalarFacets: readonly ScalarQueryFacet[] = ['complexity', 'grade', 'rights'];

function supported(values: readonly string[]): ReadonlySet<string> {
  return new Set(values);
}

/** Reports saved query values absent from one immutable release catalogue. */
export function validateQueryStateAgainstRelease(
  state: QueryState,
  catalogue: QueryStateReleaseCatalogue,
): QueryStateValidation {
  const unknownRepeatableFacetValues: UnknownRepeatableFacetValue[] = [];
  for (const facet of repeatableFacets) {
    const values = supported(catalogue.repeatableFacetValues[facet]);
    for (const value of state[facet]) {
      if (value && !values.has(value)) unknownRepeatableFacetValues.push({ facet, value });
    }
  }

  const unknownScalarFacetValues: UnknownScalarFacetValue[] = [];
  for (const facet of scalarFacets) {
    const value = state[facet];
    if (value && !supported(catalogue.scalarFacetValues[facet]).has(value)) {
      unknownScalarFacetValues.push({ facet, value });
    }
  }

  const unsupportedSortMode = state.sort && !supported(catalogue.sortModes).has(state.sort) ? state.sort : null;
  return { unknownRepeatableFacetValues, unknownScalarFacetValues, unsupportedSortMode };
}
