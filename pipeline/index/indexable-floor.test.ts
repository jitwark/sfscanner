import { describe, expect, it } from 'vitest';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { assertIndexableFloor, indexableFloorReport } from './indexable-floor.js';

const publishable = () => makeEntry({ structure: { nodeCount: 5, integrations: ['slack'] } });
const unpublishable = () => makeEntry({ descriptionSource: 'fallback', structure: { nodeCount: 5, integrations: ['slack'] } });

describe('assertIndexableFloor', () => {
  it('fails when most canonical entries cannot be published', () => {
    const entries = [publishable(), unpublishable(), unpublishable()];

    expect(() => assertIndexableFloor(entries)).toThrow(/SEO-3 Gate Failed/);
  });

  it('passes when most canonical entries clear the floor', () => {
    const entries = Array.from({ length: 10 }, publishable);

    expect(() => assertIndexableFloor(entries)).not.toThrow();
  });

  it('can still fail once publication stops asking about rights', () => {
    // The denominator used to be *redistributable canonicals*. With 288
    // redistributable and 12,923 indexable that ratio is 44.9 — a gate that
    // cannot fail is not a gate. Canonical entries is the denominator that
    // matches the claim the gate makes.
    const entries = [
      ...Array.from({ length: 5 }, () => makeEntry({ rights: { status: 'redistributable' }, structure: { nodeCount: 5, integrations: ['slack'] } })),
      ...Array.from({ length: 95 }, () => makeEntry({ rights: { status: 'link_only' }, descriptionSource: 'fallback', structure: { nodeCount: 5, integrations: ['slack'] } })),
    ];

    expect(() => assertIndexableFloor(entries)).toThrow(/SEO-3 Gate Failed/);
  });

  it('says nothing about a corpus with no canonical entries rather than dividing by zero', () => {
    const entries = [makeEntry({ dedup: { canonical: false } })];

    expect(() => assertIndexableFloor(entries)).not.toThrow();
  });
});

describe('indexableFloorReport', () => {
  it('reports the counts the gate decided on', () => {
    const entries = [publishable(), publishable(), unpublishable()];

    expect(indexableFloorReport(entries)).toContain('Indexable: 2');
    expect(indexableFloorReport(entries)).toContain('Noindex: 1');
  });
});
