import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../pipeline/__fixtures__/make-entry';
import { entryToCardItem } from './hub-grid';

describe('entryToCardItem', () => {
  it('projects an entry through the explicit search display contract', () => {
    const entry = makeEntry({
      structure: {
        nodeCount: 4, integrations: ['Custom CRM'], trigger: 'Webhook',
        hasCode: true, hasAI: false, hasWebhook: true,
      },
      rights: { status: 'redistributable' },
      security: { grade: 'LOW' },
    });
    entry.isPrerendered = true;

    expect(entryToCardItem(entry)).toMatchObject({
      integrations: ['custom-crm'], triggers: ['webhook'], capabilities: ['code', 'webhook'],
      grade: 'LOW', rights: 'redistributable', complexity: 'simple',
      isIndexable: true, isPrerendered: true,
    });
  });
});
