import { describe, expect, it } from 'vitest';
import MiniSearch from 'minisearch';
import { buildSemanticVector, SEARCH_FIELDS, SEARCH_OPTIONS, SEARCH_STORE_FIELDS, SEMANTIC_DIMENSIONS } from '@hub/contracts';
import { qualityScore, SearchEngine } from './worker';
import { handleWorkerSearchMessage } from './worker-message-handler';

describe('worker / SearchEngine boundary', () => {
  it('keeps worker-message results identical to direct evaluator calls', () => {
    const mini = new MiniSearch({ fields: [...SEARCH_FIELDS], storeFields: [...SEARCH_STORE_FIELDS], searchOptions: SEARCH_OPTIONS });
    const fields = { summary: 'A scheduled inbox update', tags: ['email'], integrations: ['gmail'], triggers: ['schedule'], capabilities: [], content: 'send a daily digest', grade: 'LOW', rights: 'redistributable', complexity: 'simple', nodeCount: 4, descriptionSource: 'generated', isIndexable: true, isPrerendered: true };
    mini.add({ id: 'digest', slug: 'digest', title: 'Inbox digest', ...fields });
    mini.add({ id: 'other', slug: 'other', title: 'Other workflow', ...fields, tags: ['other'], integrations: ['slack'] });
    const engine = new SearchEngine();
    const directEngine = new SearchEngine();
    engine.init(JSON.stringify(mini));
    directEngine.init(JSON.stringify(mini));
    const message = { type: 'search' as const, id: 1, query: 'email', filters: undefined, options: { limit: 1, page: 1 } };
    expect(handleWorkerSearchMessage(engine, message)).toEqual(directEngine.search(message.id, message.query, message.filters, message.options));
  });

  it('calculates qualityScore deterministically', () => {
    const scoreRedist = qualityScore({ rights: 'redistributable', grade: 'LOW', nodeCount: 10, summary: 'A great workflow for sending email' });
    const scoreLink = qualityScore({ rights: 'link_only', grade: 'CRITICAL', nodeCount: 2, summary: '' });
    expect(scoreRedist).toBeGreaterThan(scoreLink);
    expect(scoreRedist).toBeLessThanOrEqual(1.4);
    expect(scoreLink).toBeGreaterThanOrEqual(0.6);
  });

  it('applies the normalized grade bonus and penalties regardless of input casing', () => {
    expect(qualityScore({ grade: 'low' })).toBe(1.05);
    expect(qualityScore({ grade: 'HIGH' })).toBe(0.95);
    expect(qualityScore({ grade: 'critical' })).toBe(0.85);
  });

  it('applies the requested quality sort independently from relevance ranking', () => {
    const mini = new MiniSearch({ fields: [...SEARCH_FIELDS], storeFields: [...SEARCH_STORE_FIELDS], searchOptions: SEARCH_OPTIONS });
    const fields = { summary: '', tags: [], integrations: [], triggers: [], capabilities: [], content: '', complexity: 'simple', nodeCount: 4, descriptionSource: 'generated', isIndexable: true, isPrerendered: true };
    mini.add({ id: 'exact-low', slug: 'exact-low', title: 'target', ...fields, grade: 'CRITICAL', rights: 'link-only' });
    mini.add({ id: 'broad-high', slug: 'broad-high', title: 'helper', ...fields, tags: ['target'], grade: 'LOW', rights: 'link-only' });
    const engine = new SearchEngine();
    engine.init(JSON.stringify(mini));

    const relevance = engine.search(1, 'target', undefined, { sort: 'relevance', limit: 2 });
    const quality = engine.search(2, 'target', undefined, { sort: 'quality', limit: 2 });

    expect(relevance?.items[0]?.id).toBe('exact-low');
    expect(quality?.items[0]?.id).toBe('broad-high');
    expect(quality?.items.map((item) => item.qualityScore)).toEqual([
      expect.closeTo(qualityScore({ grade: 'LOW', rights: 'link-only', nodeCount: 4, summary: '' })),
      expect.closeTo(qualityScore({ grade: 'CRITICAL', rights: 'link_only', nodeCount: 4, summary: '' })),
    ]);
  });

  it('uses a canonical ID tie-break for equal-score results', () => {
    const mini = new MiniSearch({ fields: [...SEARCH_FIELDS], storeFields: [...SEARCH_STORE_FIELDS], searchOptions: SEARCH_OPTIONS });
    const fields = { summary: 'Same summary', tags: ['same'], integrations: ['same'], triggers: ['manual'], capabilities: [], content: '', grade: 'LOW', rights: 'redistributable', complexity: 'simple', nodeCount: 4, descriptionSource: 'generated', isIndexable: true, isPrerendered: true };
    mini.add({ id: 'z-last', slug: 'z-last', title: 'Same title', ...fields });
    mini.add({ id: 'a-first', slug: 'a-first', title: 'Same title', ...fields });

    const engine = new SearchEngine();
    engine.init(JSON.stringify(mini));
    expect(engine.search(1, '')?.items.map((item) => item.id)).toEqual(['a-first', 'z-last']);
  });

  it('uses semantic vectors for an intent query without an exact lexical match', () => {
    const mini = new MiniSearch({ fields: [...SEARCH_FIELDS], storeFields: [...SEARCH_STORE_FIELDS], searchOptions: SEARCH_OPTIONS });
    mini.add({ id: 'digest', slug: 'digest', title: 'Inbox summary', summary: 'A scheduled team update', tags: ['email'], integrations: ['gmail'], triggers: ['schedule'], capabilities: [], content: 'send a daily digest to a team inbox', grade: 'low', rights: 'redistributable', complexity: 'simple', nodeCount: 4, descriptionSource: 'generated', isIndexable: true, isPrerendered: true });
    mini.add({ id: 'unrelated', slug: 'unrelated', title: 'Transform a file', summary: 'Parse a document', tags: ['file'], integrations: ['http'], triggers: ['webhook'], capabilities: ['webhook'], content: 'parse and transform a document', grade: 'low', rights: 'redistributable', complexity: 'simple', nodeCount: 4, descriptionSource: 'generated', isIndexable: true, isPrerendered: true });
    const digestVector = buildSemanticVector({ title: 'Inbox summary', summary: 'A scheduled team update', tags: 'email', integrations: 'gmail', trigger: 'Schedule', content: 'send a daily digest to a team inbox' });
    const unrelatedVector = buildSemanticVector({ title: 'Transform a file', summary: 'Parse a document', tags: 'file', integrations: 'http', trigger: 'Webhook', content: 'parse and transform a document' });
    const semanticIndex = JSON.stringify({ version: 1, dimensions: SEMANTIC_DIMENSIONS, documents: [{ id: 'digest', vector: digestVector }, { id: 'unrelated', vector: unrelatedVector }] });
    const engine = new SearchEngine();
    engine.init(JSON.stringify(mini), undefined, semanticIndex);
    const result = engine.search(1, 'send a message notification');
    expect(result?.items[0]?.id).toBe('digest');
    expect(result?.items[0]?.semanticScore).toBeGreaterThan(0);
  });

  it('trusts the shared index contract instead of applying a second indexability heuristic', () => {
    const mini = new MiniSearch({ fields: [...SEARCH_FIELDS], storeFields: [...SEARCH_STORE_FIELDS], searchOptions: SEARCH_OPTIONS });
    mini.add({ id: 'contract-item', slug: 'contract-item', title: 'Contract item', summary: 'Already selected upstream', tags: ['contract'], integrations: ['http'], triggers: ['manual'], capabilities: [], content: 'contract', grade: 'unknown', rights: 'link-only', complexity: 'simple', nodeCount: 4, descriptionSource: 'fallback', isIndexable: false, isPrerendered: false });
    const engine = new SearchEngine();
    engine.init(JSON.stringify(mini));
    expect(engine.search(1, 'contract')?.total).toBe(1);
  });
});
