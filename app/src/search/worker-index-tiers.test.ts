import { describe, expect, it } from 'vitest';
import { SearchEngine } from './worker';
import { buildSearchIndex } from '../../../pipeline/index/build-search-index';
import { buildFacets } from '../../../pipeline/index/facets';
import { makeEntry } from '../../../pipeline/__fixtures__/make-entry';
import { twoTierCorpus } from './worker-test-fixtures';

describe('worker / SearchEngine index tiers', () => {
  it('starts with no semantic index at all, taking ordinals from the facets', () => {
    const entries = Array.from({ length: 3 }, (_, index) => makeEntry({
      id: `ordinal-${index}`, slug: `ordinal-${index}`, title: `Ordinal workflow ${index}`,
      rights: { status: 'redistributable' }, structure: { nodeCount: 4, integrations: ['slack'] },
    }));
    const index = buildSearchIndex(entries);
    const facets = buildFacets(entries);
    const engine = new SearchEngine();
    engine.init(index.serializedIndex, facets);

    const results = engine.search(1, '', { integration: ['slack'] });
    expect(results?.total).toBe(3);
    expect(results?.items.map((item) => item.id).sort()).toEqual(['ordinal-0', 'ordinal-1', 'ordinal-2']);
  });

  describe('two-tier index', () => {
    it('counts the whole catalogue but only returns what it can display', () => {
      const entries = twoTierCorpus();
      const index = buildSearchIndex(entries, { primaryTierSize: 3 });
      const facets = buildFacets(entries);
      const engine = new SearchEngine();
      engine.init(index.serializedIndex, facets);

      const results = engine.search(1, '', { integration: ['slack'] });
      expect(facets.total).toBe(6);
      expect(results?.total).toBe(index.stats.primaryCount);
      expect(results?.items.every((item) => item.title.length > 0)).toBe(true);
    });

    it('answers over the extended tier once it arrives', () => {
      const entries = twoTierCorpus();
      const index = buildSearchIndex(entries, { primaryTierSize: 3 });
      const engine = new SearchEngine();
      engine.init(index.serializedIndex, buildFacets(entries));

      expect(engine.loadExtendedIndex('not json')).toBe(false);
      expect(engine.loadExtendedIndex(index.serializedExtendedIndex)).toBe(true);
      const results = engine.search(2, '', { integration: ['slack'] });
      expect(results?.total).toBe(6);
      expect(results?.items.every((item) => item.title.length > 0)).toBe(true);
    });

    it('reaches the full catalogue from the extended tier even when facets never arrived', () => {
      const entries = twoTierCorpus();
      const index = buildSearchIndex(entries, { primaryTierSize: 3 });
      const engine = new SearchEngine();
      engine.init(index.serializedIndex);

      expect(engine.search(1, '')?.total).toBe(index.stats.primaryCount);
      expect(engine.loadExtendedIndex(index.serializedExtendedIndex)).toBe(true);
      expect(engine.search(2, '')?.total).toBe(6);
    });

    it('reaches the full catalogue even when facets undercount the true corpus', () => {
      const entries = twoTierCorpus();
      const index = buildSearchIndex(entries, { primaryTierSize: 3 });
      const engine = new SearchEngine();
      engine.init(index.serializedIndex, buildFacets(entries.slice(0, 3)));

      expect(engine.search(1, '', { integration: ['slack'] })?.total).toBe(3);
      expect(engine.loadExtendedIndex(index.serializedExtendedIndex)).toBe(true);
      expect(engine.search(2, '')?.total).toBe(6);
      expect(engine.search(3, '', { integration: ['slack'] })?.total).toBe(0);
    });

    it('does not grow the ordinal universe past what the extended index actually supplies', () => {
      const entries = twoTierCorpus();
      const index = buildSearchIndex(entries, { primaryTierSize: 3 });
      const engine = new SearchEngine();
      engine.init(index.serializedIndex);

      expect(engine.loadExtendedIndex(index.serializedExtendedIndex)).toBe(true);
      expect(engine.loadExtendedIndex(index.serializedExtendedIndex)).toBe(false);
      expect(engine.search(4, '')?.total).toBe(6);
    });

    it('reaches a partially matching extended-tier entry the strict intersection cannot answer with', () => {
      // The extended tier is indexed without body text and without intent
      // vectors, so an entry there has to match a query through its metadata
      // alone. This one answers three of the query's four groups; the entry
      // that answers all four is the only strict match, and it cannot fill a
      // window on its own.
      const entries = [
        makeEntry({
          id: 'answers-every-group', slug: 'answers-every-group', title: 'Sync contacts between databases',
          summary: 'Two way synchronisation of contact records between two hosted databases.',
          rights: { status: 'redistributable' }, structure: { nodeCount: 12, integrations: ['notion'] },
        }),
        makeEntry({
          id: 'answers-most-groups', slug: 'answers-most-groups', title: 'Sync contacts between apps',
          summary: 'Two way synchronisation of contact records between two hosted applications.',
          rights: { status: 'link_only' }, structure: { nodeCount: 3, integrations: ['notion'] },
        }),
      ];
      const index = buildSearchIndex(entries, { primaryTierSize: 1 });
      const engine = new SearchEngine();
      engine.init(index.serializedIndex, buildFacets(entries));
      expect(engine.loadExtendedIndex(index.serializedExtendedIndex)).toBe(true);

      const reached = engine.search(1, 'sync contacts between databases', undefined, { limit: 10 });
      expect(reached?.ids[0]).toBe('answers-every-group');
      expect(reached?.ids).toContain('answers-most-groups');
      // A caller whose window the strict intersection already fills is not
      // widened: the reach costs precision, so it is spent only where it is
      // the difference between a page and no page.
      const strictOnly = engine.search(2, 'sync contacts between databases', undefined, { limit: 1 });
      expect(strictOnly?.ids).toEqual(['answers-every-group']);
    });
  });

  describe('applyFacets: late-arriving facets after the corpus is known', () => {
    it('accepts a late facets payload once its total matches the known corpus', () => {
      const entries = twoTierCorpus();
      const index = buildSearchIndex(entries, { primaryTierSize: 3 });
      const engine = new SearchEngine();
      engine.init(index.serializedIndex);
      engine.loadExtendedIndex(index.serializedExtendedIndex);

      expect(engine.search(1, '', { integration: ['slack'] })?.total).toBe(0);
      expect(engine.applyFacets(buildFacets(entries))).toBe(true);
      expect(engine.search(2, '', { integration: ['slack'] })?.total).toBe(6);
    });

    it('rejects a late facets payload whose total does not match the known corpus', () => {
      const entries = twoTierCorpus();
      const index = buildSearchIndex(entries, { primaryTierSize: 3 });
      const engine = new SearchEngine();
      engine.init(index.serializedIndex);
      engine.loadExtendedIndex(index.serializedExtendedIndex);

      expect(engine.applyFacets(buildFacets(entries.slice(0, 3)))).toBe(false);
      expect(engine.search(3, '', { integration: ['slack'] })?.total).toBe(0);
    });
  });
});
