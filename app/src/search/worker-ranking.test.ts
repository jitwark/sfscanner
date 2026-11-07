import { describe, expect, it } from 'vitest';
import MiniSearch from 'minisearch';
import { buildSemanticVector, SEARCH_FIELDS, SEARCH_OPTIONS, SEARCH_STORE_FIELDS, SEMANTIC_DIMENSIONS } from '@hub/contracts';
import { SearchEngine } from './worker';
import { buildSearchIndex } from '../../../pipeline/index/build-search-index';
import { buildFacets } from '../../../pipeline/index/facets';
import { makeEntry } from '../../../pipeline/__fixtures__/make-entry';

describe('worker / SearchEngine ranking', () => {
  it('accepts semantic vectors after init and reports whether any landed', () => {
    const entries = [makeEntry({
      id: 'semantic-1', slug: 'semantic-1', title: 'Send invoices to accounting',
      descriptionSource: 'generated', rights: { status: 'redistributable' }, structure: { nodeCount: 4, integrations: ['slack'] },
    })];
    const index = buildSearchIndex(entries);
    const engine = new SearchEngine();
    engine.init(index.serializedIndex, buildFacets(entries));

    expect(engine.loadSemanticVectors('not json at all')).toBe(false);
    expect(engine.loadSemanticVectors(index.semanticIndex.serializedIndex)).toBe(true);
    expect(engine.search(1, 'invoices')?.total).toBe(1);
  });

  it('keeps quoted phrase searches lexical-only', () => {
    const mini = new MiniSearch({ fields: [...SEARCH_FIELDS], storeFields: [...SEARCH_STORE_FIELDS], searchOptions: SEARCH_OPTIONS });
    mini.add({ id: 'exact', slug: 'exact', title: 'Inbox summary', summary: 'A scheduled team update', tags: ['email'], integrations: ['gmail'], triggers: ['schedule'], capabilities: [], content: 'send a daily digest to a team inbox', grade: 'low', rights: 'redistributable', complexity: 'simple', nodeCount: 4, descriptionSource: 'generated', isIndexable: true, isPrerendered: true });
    mini.add({ id: 'partial', slug: 'partial', title: 'Inbox report', summary: 'A digest for a team update', tags: ['email'], integrations: ['gmail'], triggers: ['schedule'], capabilities: [], content: 'send a daily report to a team inbox', grade: 'low', rights: 'redistributable', complexity: 'simple', nodeCount: 4, descriptionSource: 'generated', isIndexable: true, isPrerendered: true });
    const vector = buildSemanticVector({ title: 'Inbox summary', summary: 'A scheduled team update', tags: 'email', integrations: 'gmail', trigger: 'Schedule', content: 'send a daily digest to a team inbox' });
    const semanticIndex = JSON.stringify({ version: 1, dimensions: SEMANTIC_DIMENSIONS, documents: [{ id: 'exact', vector }, { id: 'partial', vector }] });
    const engine = new SearchEngine();
    engine.init(JSON.stringify(mini), undefined, semanticIndex);

    const result = engine.search(1, '"Inbox summary"');
    expect(result?.items[0]?.id).toBe('exact');
    expect(result?.ids).toEqual(['exact', 'partial']);
    expect(result?.items[0]?.semanticScore).toBe(0);
  });

  it('applies prefix and fuzzy matching, then narrows lexical results with a facet filter', () => {
    const entries = [
      makeEntry({ id: 'prefix', slug: 'prefix', title: 'Scheduled Gmail digest', rights: { status: 'redistributable' }, structure: { nodeCount: 4 } }),
      makeEntry({ id: 'fuzzy', slug: 'fuzzy', title: 'Notification workflow', rights: { status: 'link_only' }, structure: { nodeCount: 4 } }),
      makeEntry({ id: 'other', slug: 'other', title: 'Manual workflow', rights: { status: 'redistributable' }, structure: { nodeCount: 4 } }),
    ];
    const index = buildSearchIndex(entries);
    const engine = new SearchEngine();
    engine.init(index.serializedIndex, buildFacets(entries));

    expect(engine.search(1, 'sched')?.ids).toEqual(['prefix']);
    expect(engine.search(2, 'notificaton')?.ids).toEqual(['fuzzy']);
    expect(engine.search(3, 'gmail', { rights: 'redistributable' })?.ids).toEqual(['prefix']);
  });

  it('combines semantic-only admission with lexical evidence and still applies filters', () => {
    const entries = [
      makeEntry({ id: 'lexical', slug: 'lexical', title: 'Digest workflow', rights: { status: 'redistributable' }, structure: { nodeCount: 4 } }),
      makeEntry({ id: 'semantic-only', slug: 'semantic-only', title: 'Transform a file', rights: { status: 'link_only' }, structure: { nodeCount: 4 } }),
    ];
    const index = buildSearchIndex(entries);
    const semanticVector = buildSemanticVector({ title: 'digest', summary: '', tags: '', integrations: '', trigger: '', content: 'digest' });
    const semanticIndex = JSON.stringify({
      version: 1, dimensions: SEMANTIC_DIMENSIONS,
      documents: [{ id: 'lexical', vector: semanticVector }, { id: 'semantic-only', vector: semanticVector }],
    });
    const engine = new SearchEngine();
    engine.init(index.serializedIndex, buildFacets(entries), semanticIndex);

    const unfiltered = engine.search(1, 'digest');
    expect(unfiltered?.ids).toEqual(expect.arrayContaining(['semantic-only', 'lexical']));
    expect(unfiltered?.total).toBe(2);
    expect(unfiltered?.items.find((item) => item.id === 'semantic-only')?.lexicalScore).toBe(0);

    const filtered = engine.search(2, 'digest', { rights: 'link-only' });
    expect(filtered?.ids).toEqual(['semantic-only']);
    expect(filtered?.items[0]?.semanticScore).toBeGreaterThan(0);
  });
});
