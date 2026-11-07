import { describe, test, expect } from 'vitest';
import { fallbackDescription } from './fallback-prose';
import { validateDescription } from './validate-description';
import type { FactPacket } from './facts';

const baseFacts: FactPacket = {
  id: 'f1',
  title: 'Webhook Slack Integration',
  trigger: 'webhookTrigger',
  nodeCount: 4,
  integrations: ['slack'],
  capabilities: { hasCode: false, hasAI: false, hasWebhook: true },
  complexity: 'simple',
  nodeNames: ['webhookTrigger', 'slack'],
};

describe('fallbackDescription', () => {
  test('is deterministic for identical facts', () => {
    const res1 = fallbackDescription(baseFacts);
    const res2 = fallbackDescription(baseFacts);
    expect(res1).toEqual(res2);
  });

  test('passes validation for webhook trigger', () => {
    const res = fallbackDescription(baseFacts);
    const val = validateDescription(res.summary, res.description, baseFacts);
    expect(val).toEqual({ valid: true });
  });

  test('passes validation for schedule trigger with AI capabilities', () => {
    const facts: FactPacket = {
      ...baseFacts,
      trigger: 'scheduleTrigger',
      capabilities: { hasCode: false, hasAI: true, hasWebhook: false },
      integrations: ['openai', 'google sheets'],
    };
    const res = fallbackDescription(facts);
    const val = validateDescription(res.summary, res.description, facts);
    expect(val).toEqual({ valid: true });
  });

  test('passes validation for chat trigger with code capabilities', () => {
    const facts: FactPacket = {
      ...baseFacts,
      trigger: 'chatTrigger',
      capabilities: { hasCode: true, hasAI: false, hasWebhook: false },
      integrations: ['telegram', 'github'],
    };
    const res = fallbackDescription(facts);
    const val = validateDescription(res.summary, res.description, facts);
    expect(val).toEqual({ valid: true });
  });

  test('passes validation for email trigger with multiple integrations', () => {
    const facts: FactPacket = {
      ...baseFacts,
      trigger: 'emailReadImap',
      capabilities: { hasCode: false, hasAI: false, hasWebhook: false },
      integrations: ['gmail', 'trello', 'slack'],
    };
    const res = fallbackDescription(facts);
    const val = validateDescription(res.summary, res.description, facts);
    expect(val).toEqual({ valid: true });
  });
});
