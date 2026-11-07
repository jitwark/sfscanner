import type { FacetCounts } from '@hub/contracts';
import type { QueryState } from './query-state';
import { validateQueryStateAgainstRelease, type QueryStateValidation, type QueryStateReleaseCatalogue } from './query-state-validation';

function values(counts: Record<string, number>): string[] {
  return Object.keys(counts);
}

export function queryStateCatalogueFromCounts(counts: FacetCounts): QueryStateReleaseCatalogue {
  return {
    repeatableFacetValues: {
      integration: values(counts.integrations), tag: values(counts.tags),
      trigger: values(counts.trigger), capability: values(counts.capabilities),
    },
    scalarFacetValues: {
      complexity: values(counts.complexity), grade: values(counts.grade), rights: values(counts.rights),
    },
    sortModes: ['relevance', 'quality'],
  };
}

export function validateLibraryQueryState(state: QueryState, counts: FacetCounts): QueryStateValidation {
  return validateQueryStateAgainstRelease(state, queryStateCatalogueFromCounts(counts));
}

export function hasUnsupportedLibraryState(validation: QueryStateValidation): boolean {
  return validation.unknownRepeatableFacetValues.length > 0
    || validation.unknownScalarFacetValues.length > 0
    || validation.unsupportedSortMode !== null;
}
