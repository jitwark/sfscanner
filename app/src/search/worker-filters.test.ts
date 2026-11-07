import { describe, expect, it } from 'vitest';
import { SearchEngine } from './worker';
import { buildSearchIndex } from '../../../pipeline/index/build-search-index';
import { buildFacets } from '../../../pipeline/index/facets';
import { makeEntry } from '../../../pipeline/__fixtures__/make-entry';

describe('worker / SearchEngine filters', () => {
  it('filters search results using bitsets', () => {
    const entry = makeEntry({
      id: 'filter-contract', title: 'OpenAI filter contract', rights: { status: 'redistributable' },
      structure: { nodeCount: 4, integrations: ['openai'] },
    });
    const index = buildSearchIndex([entry]);
    const engine = new SearchEngine();
    engine.init(index.serializedIndex, buildFacets([entry]), index.semanticIndex.serializedIndex);

    const unfiltered = engine.search(100, 'openai');
    const filtered = engine.search(101, 'openai', { rights: 'redistributable' });
    expect(unfiltered).not.toBeNull();
    expect(filtered).not.toBeNull();
    expect(unfiltered!.total).toBe(1);
    expect(filtered!.items).toMatchObject([{ rights: 'redistributable' }]);
  });

  it('returns every matching item for an explicit tag filter', () => {
    const entries = Array.from({ length: 30 }, (_, index) => makeEntry({
      id: `tagged-${index}`, slug: `tagged-${index}`, title: `Tagged workflow ${index}`,
      tags: ['flat-catalogue'], rights: { status: 'redistributable' }, structure: { nodeCount: 4, integrations: ['slack'] },
    }));
    const index = buildSearchIndex(entries);
    const engine = new SearchEngine();
    engine.init(index.serializedIndex, buildFacets(entries), index.semanticIndex.serializedIndex);
    expect(engine.search(1, '', { tag: ['flat-catalogue'] })?.items).toHaveLength(30);
  });

  it('keeps ordinary discovery results paged', () => {
    const entries = Array.from({ length: 30 }, (_, index) => makeEntry({
      id: `paged-${index}`, slug: `paged-${index}`, title: `Paged workflow ${index}`,
      rights: { status: 'redistributable' }, structure: { nodeCount: 4, integrations: ['slack'] },
    }));
    const index = buildSearchIndex(entries);
    const engine = new SearchEngine();
    engine.init(index.serializedIndex, buildFacets(entries), index.semanticIndex.serializedIndex);
    expect(engine.search(1, '')?.items).toHaveLength(24);
  });

  it('matches an oracle with OR within groups and AND across explicit groups', () => {
    const entries = [
      makeEntry({ id: 'gmail-code', slug: 'gmail-code', title: 'Inbox Digest', tags: ['daily'], rights: { status: 'redistributable' }, structure: { nodeCount: 5, integrations: ['gmail'], trigger: 'Webhook', complexity: 'simple', hasCode: true, hasAI: false, hasWebhook: true }, security: { grade: 'LOW' } }),
      makeEntry({ id: 'slack-ai', slug: 'slack-ai', title: 'Team Alert', tags: ['alerts'], rights: { status: 'redistributable' }, structure: { nodeCount: 5, integrations: ['slack'], trigger: 'Schedule', complexity: 'medium', hasCode: false, hasAI: true, hasWebhook: false }, security: { grade: 'LOW' } }),
      makeEntry({ id: 'sheets-ai', slug: 'sheets-ai', title: 'Sheet Alert', tags: ['alerts'], rights: { status: 'redistributable' }, structure: { nodeCount: 5, integrations: ['google-sheets'], trigger: 'Webhook', complexity: 'complex', hasCode: false, hasAI: true, hasWebhook: true }, security: { grade: 'HIGH' } }),
    ];
    const index = buildSearchIndex(entries);
    const engine = new SearchEngine();
    engine.init(index.serializedIndex, buildFacets(entries), index.semanticIndex.serializedIndex);

    expect(engine.search(1, '')?.total).toBe(3);
    expect(engine.search(2, '', { integration: ['gmail', 'slack'] })?.ids.sort()).toEqual(['gmail-code', 'slack-ai']);
    expect(engine.search(3, '', { integration: ['gmail', 'slack'], tag: ['alerts'] })?.ids).toEqual(['slack-ai']);
    expect(engine.search(4, '', { trigger: ['WEBHOOK', 'schedule'] })?.total).toBe(3);
    expect(engine.search(5, '', { capability: ['code'] })?.ids).toEqual(['gmail-code']);
    expect(engine.search(6, '', { capability: ['ai'], rights: 'redistributable' })?.ids.sort()).toEqual(['sheets-ai', 'slack-ai']);
    expect(engine.search(7, 'Inbox', { grade: 'LOW', rights: 'redistributable' })?.ids).toEqual(['gmail-code']);
  });

  it('matches an intentional unknown bucket but rejects an unsupported taxonomy filter', () => {
    const entry = makeEntry({
      id: 'unknown-trigger', slug: 'unknown-trigger', rights: { status: 'redistributable' },
      structure: { nodeCount: 4, integrations: ['slack'], trigger: 'Kafka Event' },
    });
    const index = buildSearchIndex([entry]);
    const engine = new SearchEngine();
    engine.init(index.serializedIndex, buildFacets([entry]), index.semanticIndex.serializedIndex);

    expect(engine.search(1, '', { trigger: ['unknown'] })?.ids).toEqual(['unknown-trigger']);
    expect(engine.search(2, '', { trigger: ['kafka-event'] })?.total).toBe(0);
  });
});
