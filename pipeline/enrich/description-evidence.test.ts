import { describe, expect, test } from 'vitest';
import { buildDescriptionEvidence } from './description-evidence';

describe('buildDescriptionEvidence', () => {
  test('extracts only deterministic workflow facts', () => {
    const evidence = buildDescriptionEvidence({
      name: 'website title must not become evidence',
      description: 'website prose',
      nodes: [
        { name: 'Receive', type: 'n8n-nodes-base.webhook', parameters: {} },
        { name: 'Run code', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return items;' } },
        { name: 'Slack', type: 'n8n-nodes-base.slack', parameters: {} },
      ],
      connections: { Receive: { main: [[{ node: 'Run code', type: 'main', index: 0 }]] } },
    });
    expect(evidence.nodeCount).toBe(3);
    expect(evidence.nodeNames).toEqual(['Receive', 'Run code', 'Slack']);
    expect(evidence.integrations).toContain('slack');
    expect(evidence.integrations).not.toContain('website');
    expect(evidence.hasCode).toBe(true);
  });

  test('recognizes service evidence from visible node names and parameters', () => {
    const evidence = buildDescriptionEvidence({
      nodes: [
        { name: 'Google Sheets lookup', type: 'n8n-nodes-base.httpRequest', parameters: { spreadsheetId: 'sheet-123' } },
        { name: 'Upload to S3', type: 'n8n-nodes-base.httpRequest', parameters: { bucket: 'reports' } },
      ],
      connections: {},
    });
    expect(evidence.integrations).toEqual(expect.arrayContaining(['googlesheets', 's3']));
  });
});
