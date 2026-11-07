import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSearchIndex } from '../../../pipeline/index/build-search-index';
import { buildFacets } from '../../../pipeline/index/facets';
import { makeEntry } from '../../../pipeline/__fixtures__/make-entry';
import { SearchEngine } from './worker';

afterEach(() => vi.unstubAllGlobals());

describe('SearchEngine local-only boundary', () => {
  it('does not request network data across index, filter, or tier interactions', () => {
    const fetch = vi.fn();
    const request = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('XMLHttpRequest', class { open = request; send = request; });

    const entries = Array.from({ length: 4 }, (_, index) => makeEntry({
      id: `local-${index}`,
      slug: `local-${index}`,
      title: `Local workflow ${index}`,
      tags: ['local'],
      rights: { status: 'redistributable' },
      structure: { nodeCount: 4, integrations: ['slack'] },
    }));
    const index = buildSearchIndex(entries, { primaryTierSize: 2 });
    const engine = new SearchEngine();
    engine.init(index.serializedIndex, buildFacets(entries));
    engine.search(1, 'local', { tag: ['local'] }, { page: 1, limit: 2 });
    engine.loadExtendedIndex(index.serializedExtendedIndex);
    engine.loadSemanticVectors(index.semanticIndex.serializedIndex);
    engine.search(2, 'notification', undefined, { page: 1, limit: 2 });

    expect(fetch).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
