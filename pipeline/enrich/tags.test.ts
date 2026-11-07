import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { deriveTags } from './tags.js';
import { INTEGRATION_MAP } from './integration-map.js';

describe('tags', () => {
  it('is deterministic and orders tags properly', () => {
    const structure = {
      nodeCount: 3,
      connectionCount: 2,
      nodeTypes: ['n8n-nodes-base.googleSheets', 'n8n-nodes-base.slack', 'n8n-nodes-base.webhook'],
      integrations: ['google-sheets', 'slack'],
      trigger: 'Webhook',
      complexity: 'simple' as const,
      hasCode: false,
      hasAI: false,
      hasWebhook: true,
    };

    const tags1 = deriveTags(structure);
    const tags2 = deriveTags(structure);

    expect(tags1).toEqual(tags2);
    expect(tags1).toContain('google-sheets');
    expect(tags1).toContain('slack');
    expect(tags1).toContain('webhook');
    expect(tags1).toContain('simple');
  });

  it('skips unknown node types without creating garbage tags', () => {
    const structure = {
      nodeCount: 2,
      connectionCount: 1,
      nodeTypes: ['unknown.garbageNodeType', 'another.unknownType'],
      integrations: [],
      trigger: 'Manual',
      complexity: 'simple' as const,
      hasCode: false,
      hasAI: false,
      hasWebhook: false,
    };

    const tags = deriveTags(structure);
    expect(tags).toEqual(['simple']);
  });

  it('truncates tags to a maximum of 12', () => {
    const manyTypes = [
      'n8n-nodes-base.googleSheets',
      'n8n-nodes-base.slack',
      'n8n-nodes-base.gmail',
      'n8n-nodes-base.telegram',
      'n8n-nodes-base.airtable',
      'n8n-nodes-base.postgres',
      'n8n-nodes-base.notion',
      'n8n-nodes-base.github',
      'n8n-nodes-base.jira',
      'n8n-nodes-base.hubspot',
      'n8n-nodes-base.discord',
      'n8n-nodes-base.twilio',
      'n8n-nodes-base.youTube',
      'n8n-nodes-base.code',
      'n8n-nodes-base.webhook',
    ];

    const structure = {
      nodeCount: 15,
      connectionCount: 14,
      nodeTypes: manyTypes,
      integrations: [],
      trigger: 'Webhook',
      complexity: 'complex' as const,
      hasCode: true,
      hasAI: false,
      hasWebhook: true,
    };

    const tags = deriveTags(structure);
    expect(tags.length).toBeLessThanOrEqual(12);
    expect(tags).toContain('complex');
  });

  it('samples 1,000 real workflows from vault templates', () => {
    const templatesDir = 'D:/projects/n8n-vault-core/templates';
    if (!fs.existsSync(templatesDir)) return;

    const files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.json')).slice(0, 1000);
    expect(files.length).toBeGreaterThan(0);

    let totalTags = 0;
    let zeroTagCount = 0;
    const tagFrequency: Record<string, number> = {};

    let totalNodes = 0;
    let recognizedNodes = 0;

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(templatesDir, file), 'utf-8');
        const json = JSON.parse(content);
        const nodes = Array.isArray(json.nodes) ? json.nodes : [];
        const nodeTypes = nodes.map((n: Record<string, unknown>) => String(n.type || n.nodeType || ''));

        for (const t of nodeTypes) {
          if (!t) continue;
          totalNodes++;
          const short = t.includes('.') ? t.split('.').pop() || '' : t;
          if (INTEGRATION_MAP[t] || INTEGRATION_MAP[`n8n-nodes-base.${short}`] || INTEGRATION_MAP[`@n8n/n8n-nodes-langchain.${short}`]) {
            recognizedNodes++;
          }
        }

        const tags = deriveTags({
          nodeCount: nodes.length,
          connectionCount: 0,
          nodeTypes,
          integrations: [],
          trigger: 'Manual',
          complexity: 'simple',
          hasCode: false,
          hasAI: false,
          hasWebhook: false,
        });

        totalTags += tags.length;
        if (tags.length === 0) zeroTagCount++;

        for (const tag of tags) {
          tagFrequency[tag] = (tagFrequency[tag] || 0) + 1;
        }
      } catch {
        // ignore parse error
      }
    }

    const meanTags = totalTags / files.length;
    const sortedTags = Object.entries(tagFrequency).sort((a, b) => b[1] - a[1]);
    const top20 = sortedTags.slice(0, 20).map(([tag, count]) => `${tag}:${count}`);
    const nodeCoveragePct = (recognizedNodes / totalNodes) * 100;

    console.log(`[Corpus Test Stats] Sampled ${files.length} workflows.`);
    console.log(`[Corpus Test Stats] Mean tags per workflow: ${meanTags.toFixed(2)}`);
    console.log(`[Corpus Test Stats] Workflows with zero tags: ${zeroTagCount}`);
    console.log(`[Corpus Test Stats] Top 20 tags: ${top20.join(', ')}`);
    console.log(`[Corpus Test Stats] Node instance coverage: ${nodeCoveragePct.toFixed(2)}% (${recognizedNodes}/${totalNodes})`);

    expect(meanTags).toBeGreaterThan(1);
    expect(zeroTagCount).toBeLessThan(10);
    expect(nodeCoveragePct).toBeGreaterThan(90);
  }, 30000);
});
