import { describe, expect, test } from 'vitest';
import { hasAiNode, isAiNodeType } from './ai-detection';

/**
 * The false-positive cases below are the reason this module exists. The
 * previous rule tested `type.includes('ai')`, which flagged 21.8% of the
 * published catalogue as calling an AI model when it calls none.
 */
describe('node types that merely contain the letters "ai"', () => {
  test.each([
    'n8n-nodes-base.airtable',
    'n8n-nodes-base.gmail',
    'n8n-nodes-base.emailSend',
    'n8n-nodes-base.emailReadImap',
    'n8n-nodes-base.mailchimp',
    'n8n-nodes-base.mailgun',
    'n8n-nodes-base.sendGrid',
  ])('%s is not an AI node', (type) => {
    expect(isAiNodeType(type)).toBe(false);
  });
});

describe('real AI nodes', () => {
  test.each([
    '@n8n/n8n-nodes-langchain.lmChatOpenAi',
    '@n8n/n8n-nodes-langchain.chainLlm',
    '@n8n/n8n-nodes-langchain.agent',
    '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
    '@n8n/n8n-nodes-langchain.embeddingsOpenAi',
    'n8n-nodes-base.openAi',
    'n8n-nodes-base.anthropic',
    'some-community-package.deepseekChat',
    'n8n-nodes-base.aiTransform',
  ])('%s is an AI node', (type) => {
    expect(isAiNodeType(type)).toBe(true);
  });
});

describe('ordinary integrations are not AI', () => {
  test.each([
    'n8n-nodes-base.slack',
    'n8n-nodes-base.httpRequest',
    'n8n-nodes-base.postgres',
    'n8n-nodes-base.stickyNote',
    'n8n-nodes-base.code',
  ])('%s is not an AI node', (type) => {
    expect(isAiNodeType(type)).toBe(false);
  });
});

describe('hostile and empty input', () => {
  test('does not throw or match on junk', () => {
    expect(isAiNodeType('')).toBe(false);
    expect(isAiNodeType(undefined as unknown as string)).toBe(false);
    expect(isAiNodeType(123 as unknown as string)).toBe(false);
  });

  test('a package namespace cannot smuggle a match past the compact type', () => {
    // The vendor name is in the package, not the node: still not a model call.
    expect(isAiNodeType('openai-helpers.formatDate')).toBe(false);
  });
});

describe('hasAiNode', () => {
  test('is false for a workflow of Airtable and Gmail alone', () => {
    expect(hasAiNode(['n8n-nodes-base.airtable', 'n8n-nodes-base.gmail'])).toBe(false);
  });

  test('is true when one real AI node is present', () => {
    expect(
      hasAiNode(['n8n-nodes-base.airtable', '@n8n/n8n-nodes-langchain.chainLlm']),
    ).toBe(true);
  });

  test('is false for an empty workflow', () => {
    expect(hasAiNode([])).toBe(false);
  });
});
