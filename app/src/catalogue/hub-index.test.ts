import { describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeEntry as makeFixtureEntry, type DeepPartial } from '../test-support/make-entry';
import {
  buildHubIndex,
} from './hub-index';
import { formatHubTitle, generateIntroCopy, slugify } from './hub-copy';

function createMockEntry(overrides: DeepPartial<Entry> & { id: string; slug: string }): Entry {
  return makeFixtureEntry(overrides);
}

describe('hub-index', () => {
  it('slugifies titles and names correctly', () => {
    expect(slugify('Google Sheets')).toBe('google-sheets');
    expect(slugify('  OpenAI API  ')).toBe('openai-api');
    expect(slugify('n8n-nodes-base.webhook')).toBe('n8n-nodes-base-webhook');
  });

  it('formats hub titles cleanly', () => {
    expect(formatHubTitle('openai', 'integration')).toBe('OpenAI');
    expect(formatHubTitle('google-sheets', 'integration')).toBe('Google Sheets');
    expect(formatHubTitle('webhook', 'trigger')).toBe('Webhook Trigger');
    expect(formatHubTitle('low', 'security')).toBe('LOW Security Risk');
  });

  it('filters out hubs with fewer than 3 entries', () => {
    const entries: Entry[] = [
      createMockEntry({
        id: '1',
        slug: 'w1',
        structure: {
          nodeCount: 5,
          connectionCount: 4,
          nodeTypes: ['n8n-nodes-base.httpRequest'],
          integrations: ['rare-service', 'common-service'],
          trigger: 'Webhook',
          complexity: 'simple',
          hasCode: false,
          hasAI: false,
          hasWebhook: true,
        },
      }),
      createMockEntry({
        id: '2',
        slug: 'w2',
        structure: {
          nodeCount: 5,
          connectionCount: 4,
          nodeTypes: ['n8n-nodes-base.httpRequest'],
          integrations: ['rare-service', 'common-service'],
          trigger: 'Webhook',
          complexity: 'simple',
          hasCode: false,
          hasAI: false,
          hasWebhook: true,
        },
      }),
      createMockEntry({
        id: '3',
        slug: 'w3',
        structure: {
          nodeCount: 5,
          connectionCount: 4,
          nodeTypes: ['n8n-nodes-base.httpRequest'],
          integrations: ['common-service'],
          trigger: 'Webhook',
          complexity: 'simple',
          hasCode: false,
          hasAI: false,
          hasWebhook: true,
        },
      }),
    ];

    const hubIndex = buildHubIndex(entries);

    // 'rare-service' has 2 entries -> excluded
    expect(hubIndex.integrations['rare-service']).toBeUndefined();
    // 'common-service' has 3 entries -> included
    expect(hubIndex.integrations['common-service']).toBeDefined();
    expect(hubIndex.integrations['common-service'].totalEntries).toBe(3);
  });

  it('limits tags to top 150 by count', () => {
    const entries: Entry[] = [];
    // Generate 200 distinct tags, each with 3 entries
    for (let i = 0; i < 200; i++) {
      const tag = `tag-${i.toString().padStart(3, '0')}`;
      for (let j = 0; j < 3; j++) {
        entries.push(
          createMockEntry({
            id: `entry-${i}-${j}`,
            slug: `entry-${i}-${j}`,
            tags: [tag],
          })
        );
      }
    }

    const hubIndex = buildHubIndex(entries);
    const tagKeys = Object.keys(hubIndex.tags);
    expect(tagKeys.length).toBeLessThanOrEqual(150);
  });

  it('generates non-empty deterministic intro copy', () => {
    const hubInfo = {
      kind: 'integration' as const,
      slug: 'openai',
      title: 'OpenAI',
      entryIds: ['1', '2', '3'],
      totalEntries: 3,
      totalPages: 1,
      companionIntegrations: [
        { name: 'slack', count: 2 },
        { name: 'google-sheets', count: 1 },
      ],
      companionTags: [{ name: 'ai', count: 3 }],
      dominantTrigger: 'webhook',
      gradeSpread: { low: 2, medium: 1, high: 0, critical: 0, unknown: 0 },
    };

    const copy1 = generateIntroCopy(hubInfo);
    const copy2 = generateIntroCopy(hubInfo);

    expect(copy1).toBe(copy2);
    expect(copy1).toContain('OpenAI');
    expect(copy1).toContain('3');
    expect(copy1.split('. ').length).toBeGreaterThanOrEqual(2);
  });

  it('builds valid security grade hubs with advisory notice', () => {
    const entries: Entry[] = [
      createMockEntry({ id: '1', slug: 'w1', structure: { nodeCount: 3, integrations: ['slack'] }, security: { grade: 'LOW', score: 90, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [], scannerVersion: '1.0.0', profile: 'beta-default' } }),
      createMockEntry({ id: '2', slug: 'w2', structure: { nodeCount: 3, integrations: ['slack'] }, security: { grade: 'LOW', score: 95, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [], scannerVersion: '1.0.0', profile: 'beta-default' } }),
      createMockEntry({ id: '3', slug: 'w3', structure: { nodeCount: 3, integrations: ['slack'] }, security: { grade: 'LOW', score: 85, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [], scannerVersion: '1.0.0', profile: 'beta-default' } }),
    ];

    const hubIndex = buildHubIndex(entries);
    expect(hubIndex.security['low']).toBeDefined();
    expect(hubIndex.security['low'].totalEntries).toBe(3);
    expect(hubIndex.security['low'].introCopy).toContain('advisory signal');
  });
});
