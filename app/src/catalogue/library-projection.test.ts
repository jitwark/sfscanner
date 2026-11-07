import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../pipeline/__fixtures__/make-entry';
import { buildLibraryProjection } from './library-projection';

describe('library projection', () => {
  /**
   * The invariant is that the total, the facet denominator and the item list
   * come from one decision — not that link-only entries are excluded. Search is
   * no longer gated on redistribution rights (being findable is not
   * republishing; `src/catalogue/download.ts` still holds that gate), so a
   * link-only entry belongs in all three or in none.
   */
  it('uses one searchability decision for totals, facets, and display items', () => {
    const visible = makeEntry({
      id: 'visible', slug: 'visible', structure: {
        nodeCount: 4, integrations: ['Custom CRM'], trigger: 'Webhook',
        hasAI: true, hasCode: false, hasWebhook: true,
      },
    });
    const linkOnly = makeEntry({
      id: 'link-only', rights: { status: 'link_only' },
      structure: { nodeCount: 4, integrations: ['slack'] },
    });
    (visible as unknown as { indexable: boolean }).indexable = false;
    (linkOnly as unknown as { indexable: boolean }).indexable = true;

    const projection = buildLibraryProjection([visible, linkOnly], new Set(['visible']));

    expect(projection.total).toBe(2);
    expect(projection.facets.total).toBe(2);
    expect(projection.items).toHaveLength(2);
    expect(projection.items.map((item) => item.id).sort()).toEqual(['link-only', 'visible']);
    expect(projection.items.find((item) => item.id === 'visible')).toMatchObject({
      integrations: ['custom-crm'], triggers: ['webhook'],
      capabilities: ['ai', 'webhook'], grade: 'LOW', rights: 'redistributable',
      isIndexable: true, isPrerendered: true,
    });
    // A link-only entry is findable *and* publishable: describing a workflow
    // and linking upstream republishes nothing (see `isIndexable`). What routes
    // the reader to a prerendered page or the client shell is `isPrerendered`,
    // which is a separate field and stays false here.
    expect(projection.items.find((item) => item.id === 'link-only')).toMatchObject({
      rights: 'link_only', isIndexable: true, isPrerendered: false,
    });
  });
});
