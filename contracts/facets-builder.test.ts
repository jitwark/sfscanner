import { describe, expect, it } from 'vitest';
import { makeEntry } from '../pipeline/__fixtures__/make-entry';
import { buildFacets } from './facets-builder';

describe('contract facet builder', () => {
  it('preserves the pipeline counts, bounds, bitsets, and ordinal order', () => {
    const entries = [
      makeEntry({
        id: 'd', summary: 'x', structure: {
          nodeCount: 3, integrations: ['Slack'], trigger: 'Webhook', complexity: 'simple',
          hasCode: true, hasAI: true, hasWebhook: true,
        }, tags: ['Common', 'Delta'],
      }),
      makeEntry({
        id: 'b', summary: 'x', structure: {
          nodeCount: 3, integrations: ['Gmail'], trigger: 'Schedule', complexity: 'complex',
          hasCode: false, hasAI: true, hasWebhook: false,
        }, tags: ['Common', 'Beta'],
      }),
      makeEntry({
        id: 'a', summary: 'x', structure: {
          nodeCount: 3, integrations: ['Slack', 'Google Sheets'], trigger: 'Webhook', complexity: 'simple',
          hasCode: true, hasAI: false, hasWebhook: true,
        }, tags: ['Common', 'Alpha'],
      }),
      makeEntry({
        id: 'c', summary: 'x', structure: {
          nodeCount: 3, integrations: ['Slack'], trigger: 'Manual', complexity: 'medium',
          hasCode: false, hasAI: false, hasWebhook: false,
        }, tags: ['Common', 'Gamma'],
      }),
    ];

    expect(buildFacets(entries, 2)).toEqual({
      total: 4,
      counts: {
        rights: { redistributable: 4 },
        grade: { LOW: 4 },
        trigger: { webhook: 2, manual: 1, schedule: 1 },
        complexity: { simple: 2, complex: 1, medium: 1 },
        capabilities: { code: 2, webhook: 2, ai: 2 },
        integrations: { slack: 3, gmail: 1 },
        tags: { common: 4, alpha: 1 },
      },
      facets: [
        { slug: 'redistributable', label: 'Redistributable', group: 'rights', count: 4 },
        { slug: 'LOW', label: 'LOW', group: 'security', count: 4 },
        { slug: 'webhook', label: 'Webhook', group: 'trigger', count: 2 },
        { slug: 'manual', label: 'Manual', group: 'trigger', count: 1 },
        { slug: 'schedule', label: 'Schedule', group: 'trigger', count: 1 },
        { slug: 'simple', label: 'Simple', group: 'complexity', count: 2 },
        { slug: 'complex', label: 'Complex', group: 'complexity', count: 1 },
        { slug: 'medium', label: 'Medium', group: 'complexity', count: 1 },
        { slug: 'ai', label: 'AI', group: 'capability', count: 2 },
        { slug: 'code', label: 'Code', group: 'capability', count: 2 },
        { slug: 'webhook', label: 'Webhook', group: 'capability', count: 2 },
        { slug: 'slack', label: 'Slack', group: 'integration', count: 3 },
        { slug: 'gmail', label: 'Gmail', group: 'integration', count: 1 },
        { slug: 'common', label: 'Common', group: 'intent', count: 4 },
        { slug: 'alpha', label: 'Alpha', group: 'intent', count: 1 },
      ],
      bitsets: {
        'rights:redistributable': 'DwAAAA==',
        'grade:LOW': 'DwAAAA==',
        'trigger:webhook': 'CQAAAA==',
        'complexity:simple': 'CQAAAA==',
        'capability:code': 'CQAAAA==',
        'capability:webhook': 'CQAAAA==',
        'integration:slack': 'DQAAAA==',
        'integration:google-sheets': 'AQAAAA==',
        'tag:common': 'DwAAAA==',
        'tag:alpha': 'AQAAAA==',
        'trigger:schedule': 'AgAAAA==',
        'capability:ai': 'CgAAAA==',
        'integration:gmail': 'AgAAAA==',
        'tag:beta': 'AgAAAA==',
        'trigger:manual': 'BAAAAA==',
        'complexity:medium': 'BAAAAA==',
        'tag:gamma': 'BAAAAA==',
        'complexity:complex': 'AgAAAA==',
        'tag:delta': 'CAAAAA==',
      },
      ordinals: ['a', 'b', 'c', 'd'],
    });
  });
});
