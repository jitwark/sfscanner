import { describe, expect, it } from 'vitest';
import { makeEntry } from '../__fixtures__/make-entry';
import { buildSemanticIndex } from './semantic-index';

describe('semantic index', () => {
  it('is stable and excludes fallback content', () => {
    const entries = [
      makeEntry({ id: 'generated', descriptionSource: 'generated', descriptionContent: {
        headline: 'Send email updates', summary: 'Send email updates.', outcome: 'A team gets updates.', beforeAfter: { before: 'Manual work.', after: 'Automated updates.' }, exampleScenario: 'Example: imagine a daily update.', howItWorks: ['Read data.', 'Format data.', 'Send email.'], limitations: ['Credentials are required.'], audience: 'Teams.',
      }}),
      makeEntry({ id: 'fallback', descriptionSource: 'fallback' }),
    ];
    const first = buildSemanticIndex(entries);
    const second = buildSemanticIndex(entries);
    expect(first.serializedIndex).toBe(second.serializedIndex);
    const parsed = JSON.parse(first.serializedIndex) as { documents: Array<{ id: string }>; ordinals?: string[] };
    expect(parsed.documents.map((doc) => doc.id)).toEqual(['generated']);
    // Empty by design. Ordinals ship with the facet bitsets they index — that
    // is what lets this file be fetched lazily — and this index now covers only
    // the primary tier, so a list built from it would be a partial one that
    // silently mis-addresses every bitset.
    expect(parsed.ordinals).toEqual([]);
  });
});
