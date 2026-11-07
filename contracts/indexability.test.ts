import { describe, expect, it } from 'vitest';
import { makeEntry } from '../pipeline/__fixtures__/make-entry.js';
import { isIndexable, isSearchable } from './indexability';

describe('indexability', () => {
  it('requires a canonical entry with useful content and structure', () => {
    expect(isIndexable(makeEntry({ structure: { nodeCount: 3, integrations: ['slack'] } }))).toBe(true);
    expect(isIndexable(makeEntry({ dedup: { canonical: false }, structure: { nodeCount: 3, integrations: ['slack'] } }))).toBe(false);
    expect(isIndexable(makeEntry({ descriptionSource: 'fallback', structure: { nodeCount: 3, integrations: ['slack'] } }))).toBe(false);
  });

  it('publishes a link-only entry, because a page about a workflow republishes nothing', () => {
    const linkOnly = makeEntry({
      rights: { status: 'link_only', licence: null, licenceUrl: null, reason: 'no licence file' },
      structure: { nodeCount: 5, integrations: ['slack'] },
    });

    expect(isIndexable(linkOnly)).toBe(true);
  });

  it('still refuses an entry below the structure floor', () => {
    expect(isIndexable(makeEntry({ structure: { nodeCount: 2, integrations: ['slack'] } }))).toBe(false);
    expect(isIndexable(makeEntry({ structure: { nodeCount: 9, nodeTypes: [] } }))).toBe(false);
  });

  it('does not let the vendor vocabulary decide what is published', () => {
    // The canonical taxonomy counts vendor products only, so a workflow built
    // entirely from n8n's own nodes has an empty integration list. It is still a
    // real, described, multi-node workflow and must stay findable: 1,015
    // published entries are exactly this shape.
    const coreNodesOnly = makeEntry({
      structure: {
        nodeCount: 5,
        nodeTypes: ['n8n-nodes-base.webhook', 'n8n-nodes-base.code', 'n8n-nodes-base.httpRequest'],
        integrations: [],
      },
    });

    expect(isIndexable(coreNodesOnly)).toBe(true);
    expect(isSearchable(coreNodesOnly)).toBe(true);
  });

  it('asks exactly what search asks, because they answer the same question', () => {
    // The two predicates differ only on generated-description provenance: a
    // fallback description may not be *published*, but the entry is still worth
    // finding. Anything else that separates them is a bug in one of them.
    const cases = [
      makeEntry({ structure: { nodeCount: 3, integrations: ['slack'] } }),
      makeEntry({ rights: { status: 'link_only' }, structure: { nodeCount: 7, integrations: ['notion'] } }),
      makeEntry({ structure: { nodeCount: 1, integrations: [] } }),
      makeEntry({ dedup: { canonical: false }, structure: { nodeCount: 4, integrations: ['gmail'] } }),
    ];

    for (const entry of cases) {
      expect(isIndexable(entry), entry.id).toBe(isSearchable(entry));
    }
  });

  it('cannot diverge when a legacy indexable property contradicts the contract', () => {
    const accepted = makeEntry({ structure: { nodeCount: 3, integrations: ['slack'] } });
    const rejected = makeEntry({ structure: { nodeCount: 1, integrations: [] } });
    (accepted as unknown as { indexable: boolean }).indexable = false;
    (rejected as unknown as { indexable: boolean }).indexable = true;

    expect(isIndexable(accepted)).toBe(true);
    expect(isIndexable(rejected)).toBe(false);
  });
});
