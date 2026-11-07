import { createEngineState } from './worker-engine-state';
import { applyFacets, initializeEngine, loadExtendedSearchIndex, loadSemanticVectors } from './worker-engine-init';
import { runSearch } from './worker-engine-search';
import type { WorkerFacetsData, SearchFilters, SearchResponse } from './worker-messages';

export class SearchEngine {
  private readonly state = createEngineState();

  public init(indexJson: string, facetsData?: WorkerFacetsData, semanticIndexJson?: string): void {
    initializeEngine(this.state, indexJson, facetsData, semanticIndexJson);
  }

  public loadExtendedIndex(indexJson: string): boolean {
    return loadExtendedSearchIndex(this.state, indexJson);
  }

  /** Applies a facets payload fetched after init; see `applyFacets` for why. */
  public applyFacets(facetsData?: WorkerFacetsData): boolean {
    return applyFacets(this.state, facetsData);
  }

  public loadSemanticVectors(semanticIndexJson: string): boolean {
    return loadSemanticVectors(this.state, semanticIndexJson);
  }

  public search(
    reqId: number,
    query: string,
    filters?: SearchFilters,
    options?: { sort?: string; page?: number; limit?: number },
  ): SearchResponse | null {
    return runSearch(this.state, reqId, query, filters, options);
  }
}
