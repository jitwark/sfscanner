import MiniSearch from 'minisearch';
import { describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import type { DeepPartial } from '../__fixtures__/make-entry.js';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { SEARCH_FIELDS, SEARCH_STORE_FIELDS } from '@hub/contracts';
import { DEFAULT_SEARCH_OPTIONS, buildSearchIndex } from './build-search-index.js';

function makeDummyEntry(id: string, overrides: DeepPartial<Entry> = {}): Entry {
  return makeEntry({
    id,
    slug: `slug-${id}`,
    title: `Workflow ${id}`,
    summary: `Summary for ${id}`,
    description: `Description for ${id}`,
    descriptionSource: 'upstream',
    source: {
      kind: 'github',
      repo: 'owner/repo',
      path: `path/${id}.json`,
      commit: '1234567890123456789012345678901234567890',
      author: { name: 'dev' },
    },
    rights: { status: 'redistributable', licence: 'MIT' },
    structure: {
      nodeCount: 5,
      connectionCount: 4,
      nodeTypes: ['n8n-nodes-base.webhook'],
      integrations: ['webhook'],
      trigger: 'Webhook',
      complexity: 'simple',
      hasCode: false,
      hasAI: false,
      hasWebhook: true,
    },
    security: {
      grade: 'LOW',
      score: 95,
      counts: { critical: 0, high: 0, medium: 0, low: 1, info: 0 },
      findings: [],
      scannerVersion: '1.0.0',
      profile: 'beta-default',
    },
    tags: ['automation'],
    dedup: {
      fingerprint: `fp-${id}`,
      structuralHash: `sh-${id}`,
      canonical: true,
      alsoFoundIn: [],
    },
    ...overrides,
  });
}

describe('build-search-index', () => {
  it('builds search index and stats for entries', () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeDummyEntry(`entry-${i + 1}`, {
        title: i === 0 ? 'Unique Title Keyword' : `Workflow ${i + 1}`,
        summary: i === 1 ? 'Unique Title Keyword in summary' : `Summary ${i + 1}`,
      }),
    );

    const result = buildSearchIndex(entries);
    expect(result.serializedIndex).toBeTruthy();
    expect(result.displayItems.length).toBe(20);
    expect(result.stats.uncompressedBytes).toBeGreaterThan(0);
    expect(result.stats.compressedBytes).toBeGreaterThan(0);
    expect(result.stats.compressedBytes).toBeLessThan(result.stats.uncompressedBytes);
    expect(result.displayItems[0]).toMatchObject({
      descriptionSource: 'upstream',
      isIndexable: true,
      integrations: ['webhook'],
      tags: ['automation'],
      triggers: ['webhook'],
      capabilities: ['webhook'],
      grade: 'LOW',
      rights: 'redistributable',
      complexity: 'simple',
    });
  });

  /**
   * Search membership is canonicality plus structure — not rights, and not
   * whether prose could be generated. A duplicate is genuinely the same
   * workflow twice; a fallback description is a workflow we could not write
   * about, which is no reason to make it unfindable by title or integration.
   */
  it('excludes duplicates from both search and display ordinals', () => {
    const visible = makeDummyEntry('visible');
    const hidden = makeDummyEntry('hidden', { dedup: { canonical: false } });
    const result = buildSearchIndex([visible, hidden]);

    expect(result.displayItems.map((item) => item.id)).toEqual(['visible']);
    const loaded = MiniSearch.loadJSON(result.serializedIndex, {
      fields: [...SEARCH_FIELDS],
      storeFields: [...SEARCH_STORE_FIELDS],
      searchOptions: DEFAULT_SEARCH_OPTIONS,
    });
    expect(loaded.search('hidden')).toEqual([]);
  });

  it('ranks title matches above summary matches due to field boosts', () => {
    const docTitleMatch = makeDummyEntry('doc-title', {
      title: 'Zebra Integration',
      summary: 'Normal workflow summary',
      tags: ['test'],
    });
    const docTagMatch = makeDummyEntry('doc-tag', {
      title: 'Normal Title',
      summary: 'Normal summary',
      tags: ['zebra'],
    });
    const docSummaryMatch = makeDummyEntry('doc-summary', {
      title: 'Normal Title',
      summary: 'Zebra details here',
      tags: ['test'],
    });

    const fillerDocs = Array.from({ length: 17 }, (_, i) => makeDummyEntry(`filler-${i}`));
    const entries = [docSummaryMatch, docTagMatch, docTitleMatch, ...fillerDocs];

    const { serializedIndex } = buildSearchIndex(entries);

    const loaded = MiniSearch.loadJSON(serializedIndex, {
      fields: [...SEARCH_FIELDS],
      storeFields: [...SEARCH_STORE_FIELDS],
      searchOptions: DEFAULT_SEARCH_OPTIONS,
    });

    const searchResults = loaded.search('Zebra');
    expect(searchResults.length).toBeGreaterThanOrEqual(3);
    expect(searchResults[0]?.id).toBe('doc-title');
    expect(searchResults[1]?.id).toBe('doc-tag');
    expect(searchResults[2]?.id).toBe('doc-summary');
  });

  it('supports prefix and fuzzy search', () => {
    const entry = makeDummyEntry('fuzzy-doc', {
      title: 'Telegram Bot Assistant',
      tags: ['telegram'],
    });
    const fillerDocs = Array.from({ length: 19 }, (_, i) => makeDummyEntry(`filler-${i}`));
    const entries = [entry, ...fillerDocs];

    const { serializedIndex } = buildSearchIndex(entries);
    const loaded = MiniSearch.loadJSON(serializedIndex, {
      fields: [...SEARCH_FIELDS],
      storeFields: [...SEARCH_STORE_FIELDS],
      searchOptions: DEFAULT_SEARCH_OPTIONS,
    });

    const prefixResults = loaded.search('Telegr');
    expect(prefixResults.some((r) => r.id === 'fuzzy-doc')).toBe(true);

    const fuzzyResults = loaded.search('Telegrame');
    expect(fuzzyResults.some((r) => r.id === 'fuzzy-doc')).toBe(true);
  });
});
