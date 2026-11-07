import { describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeEntry as makeFixtureEntry, type DeepPartial } from '../test-support/make-entry';
import { buildRelatedIndex, computeRelated } from './related';

function makeEntry(overrides: DeepPartial<Entry>): Entry {
  return makeFixtureEntry({
    structure: { nodeCount: 5, integrations: ['slack'], trigger: 'webhook', complexity: 'simple', hasCode: true, hasAI: false, hasWebhook: true },
    ...overrides,
  });
}

describe('computeRelated', () => {
  it('excludes self and non-indexable entries', () => {
    const main = makeEntry({ id: 'main', slug: 'main-slug' });
    const selfCandidate = makeEntry({ id: 'main', slug: 'main-slug' });
    const nonIndexable = makeEntry({
      id: 'non-indexable',
      slug: 'non-idx',
      descriptionSource: 'fallback', // causes isIndexable to return false
    });
    const valid = makeEntry({ id: 'valid', slug: 'valid-slug' });

    const result = computeRelated(main, [selfCandidate, nonIndexable, valid]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('valid');
  });

  it('orders by primary integration > structuralHash > trigger & complexity', () => {
    const main = makeEntry({
      id: 'main',
      structure: {
        nodeCount: 5,
        connectionCount: 4,
        nodeTypes: ['n8n-nodes-base.slack', 'n8n-nodes-base.github'],
        integrations: ['slack', 'github'],
        trigger: 'webhook',
        complexity: 'medium',
        hasCode: false,
        hasAI: false,
        hasWebhook: true,
      },
      dedup: { fingerprint: 'f', structuralHash: 'hash-a', canonical: true, alsoFoundIn: [] },
    });

    const matchIntegrations = makeEntry({
      id: 'match-int',
      slug: 'slug-int',
      structure: {
        nodeCount: 3,
        connectionCount: 2,
        nodeTypes: ['n8n-nodes-base.slack'],
        integrations: ['slack'],
        trigger: 'manual',
        complexity: 'simple',
        hasCode: false,
        hasAI: false,
        hasWebhook: false,
      },
    });

    const matchHashOnly = makeEntry({
      id: 'match-hash',
      slug: 'slug-hash',
      structure: {
        nodeCount: 3,
        connectionCount: 2,
        nodeTypes: ['n8n-nodes-base.gmail'],
        integrations: ['gmail'],
        trigger: 'manual',
        complexity: 'simple',
        hasCode: false,
        hasAI: false,
        hasWebhook: false,
      },
      dedup: { fingerprint: 'f', structuralHash: 'hash-a', canonical: true, alsoFoundIn: [] },
    });

    const matchTriggerComplexity = makeEntry({
      id: 'match-tc',
      slug: 'slug-tc',
      structure: {
        nodeCount: 3,
        connectionCount: 2,
        nodeTypes: ['n8n-nodes-base.gmail'],
        integrations: ['gmail'],
        trigger: 'webhook',
        complexity: 'medium',
        hasCode: false,
        hasAI: false,
        hasWebhook: true,
      },
    });

    const result = computeRelated(main, [
      matchTriggerComplexity,
      matchHashOnly,
      matchIntegrations,
    ]);

    expect(result.map((e) => e.id)).toEqual(['match-int', 'match-hash', 'match-tc']);
  });

  it('returns exactly the same entries whether or not a prebuilt index is supplied', () => {
    // The index exists only to stop re-deriving the same facts 13,221 times.
    // If it ever changes an answer it has stopped being an optimisation, so
    // this compares the two paths over a corpus wide enough to exercise every
    // tie-break in the comparator.
    const corpus = Array.from({ length: 300 }, (_, i) =>
      makeEntry({
        id: `id-${String(i).padStart(3, '0')}`,
        slug: `slug-${i}`,
        structure: {
          nodeCount: 3 + (i % 9),
          connectionCount: i % 5,
          nodeTypes: ['n8n-nodes-base.httpRequest'],
          integrations: [['slack', 'gmail', 'notion'][i % 3], 'http'],
          trigger: ['webhook', 'manual', 'schedule'][i % 3],
          complexity: ['simple', 'medium', 'complex'][i % 3] as 'simple' | 'medium' | 'complex',
          hasCode: false,
          hasAI: false,
          hasWebhook: i % 2 === 0,
        },
        dedup: { fingerprint: `f${i}`, structuralHash: `hash-${i % 40}`, canonical: true, alsoFoundIn: [] },
        security: { grade: i % 11 === 0 ? 'CRITICAL' : 'LOW', score: 90 - (i % 30), findings: [] },
      }),
    );
    const index = buildRelatedIndex(corpus);

    for (const subject of [corpus[0], corpus[41], corpus[150], corpus[299]]) {
      const withIndex = computeRelated(subject, corpus, 6, undefined, index);
      const without = computeRelated(subject, corpus, 6);
      expect(withIndex.map((e) => e.id), subject.id).toEqual(without.map((e) => e.id));
    }
  });

  it('honours a caller-supplied quality function through the index', () => {
    const corpus = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ id: `q-${i}`, slug: `q-${i}`, structure: { nodeCount: 4, integrations: ['zzz'] } }),
    );
    const preferHighIndex = (entry: Entry) => Number(entry.id.split('-')[1]);
    const index = buildRelatedIndex(corpus, preferHighIndex);

    expect(computeRelated(corpus[0], corpus, 3, preferHighIndex, index).map((e) => e.id))
      .toEqual(computeRelated(corpus[0], corpus, 3, preferHighIndex).map((e) => e.id));
  });
});
