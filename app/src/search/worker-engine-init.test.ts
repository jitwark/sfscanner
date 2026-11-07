import { describe, expect, it } from 'vitest';
import { buildFacets } from '../../../pipeline/index/facets';
import { buildSearchIndex } from '../../../pipeline/index/build-search-index';
import { makeEntry } from '../../../pipeline/__fixtures__/make-entry';
import { SearchEngine } from './worker-engine';

describe('SearchEngine release initialization', () => {
  it('does not reuse facet bitsets after reinitializing without facet data', () => {
    const entries = [
      makeEntry({
        id: 'release-a-slack', slug: 'release-a-slack', title: 'Slack workflow',
        rights: { status: 'redistributable' }, structure: { nodeCount: 4, integrations: ['slack'] },
      }),
      makeEntry({
        id: 'release-a-gmail', slug: 'release-a-gmail', title: 'Gmail workflow',
        rights: { status: 'redistributable' }, structure: { nodeCount: 4, integrations: ['gmail'] },
      }),
    ];
    const index = buildSearchIndex(entries);
    const engine = new SearchEngine();
    engine.init(index.serializedIndex, buildFacets(entries));

    expect(engine.search(1, '', { integration: ['slack'] })?.ids).toEqual(['release-a-slack']);

    // A new release may omit optional facet data. Its filters must not use the
    // previous release's bitsets and accidentally report stale rows.
    engine.init(index.serializedIndex);

    expect(engine.search(2, '', { integration: ['slack'] })?.total).toBe(0);
  });
});
