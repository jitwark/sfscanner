import { describe, expect, it } from 'vitest';
import { deriveReadiness } from './readiness.js';

describe('deriveReadiness — hostile input', () => {
  it('returns all-empty readiness for an empty workflow', () => {
    const readiness = deriveReadiness({ nodes: [], connections: {} });
    expect(readiness).toEqual({
      analysis: 'derived',
      credentials: [],
      replaceableValues: [],
      writeActions: [],
      aiModel: { present: false, model: null },
      extraPackages: [],
      versionNotes: [],
      pinnedData: { present: false, nodeCount: 0 },
      isSubWorkflow: false,
    });
  });

  it('handles a workflow that is not an object', () => {
    expect(deriveReadiness(null)).toEqual(deriveReadiness({}));
    expect(deriveReadiness(undefined)).toEqual(deriveReadiness({}));
    expect(deriveReadiness('not a workflow')).toEqual(deriveReadiness({}));
    expect(deriveReadiness(42)).toEqual(deriveReadiness({}));
    expect(deriveReadiness([])).toEqual(deriveReadiness({}));
  });

  it('drops non-object entries from the nodes array without throwing', () => {
    const workflow = { nodes: [null, 'x', 42, { name: 'Real', type: 'n8n-nodes-base.slack', credentials: { slackApi: {} } }] };
    const readiness = deriveReadiness(workflow);
    expect(readiness.credentials).toEqual(['Slack']);
  });

  it('treats a sticky-note-only workflow as functionally empty', () => {
    const workflow = {
      nodes: [
        { name: 'Note 1', type: 'n8n-nodes-base.stickyNote', parameters: { content: 'hello' } },
        { name: 'Note 2', type: 'n8n-nodes-base.noOp' },
      ],
    };
    const readiness = deriveReadiness(workflow);
    expect(readiness.credentials).toEqual([]);
    expect(readiness.writeActions).toEqual([]);
    expect(readiness.aiModel.present).toBe(false);
    expect(readiness.extraPackages).toEqual([]);
  });

  it('survives an oversized, deeply nested, hostile input without throwing or hanging', () => {
    let deep: Record<string, unknown> = { leaf: 'https://example.com/callback', chatId: '999' };
    for (let i = 0; i < 500; i++) deep = { nested: deep };

    const bigParams: Record<string, unknown> = { deep };
    for (let i = 0; i < 5000; i++) bigParams[`field${i}`] = `value-${i}@example.com`;

    const manyNodes = Array.from({ length: 8000 }, (_, i) => ({
      name: `Node ${i}`,
      type: 'n8n-nodes-base.set',
      parameters: i === 0 ? bigParams : { note: `n${i}` },
    }));

    const workflow = { nodes: manyNodes, connections: {} };
    expect(() => deriveReadiness(workflow)).not.toThrow();
    const readiness = deriveReadiness(workflow);
    expect(readiness.replaceableValues.length).toBeLessThanOrEqual(200);
  });
});

describe('deriveReadiness — credentials', () => {
  it('maps credential keys to human product names via the owning node type', () => {
    const workflow = {
      nodes: [
        { name: 'Sheets', type: 'n8n-nodes-base.googleSheets', credentials: { googleSheetsOAuth2Api: {} } },
        { name: 'Bot', type: 'n8n-nodes-base.telegram', credentials: { telegramApi: {} } },
      ],
    };
    expect(deriveReadiness(workflow).credentials).toEqual(['Google Sheets', 'Telegram']);
  });

  it('deduplicates and sorts, and falls back to a humanized key for unmapped types', () => {
    const workflow = {
      nodes: [
        { name: 'A', type: 'n8n-nodes-base.slack', credentials: { slackApi: {} } },
        { name: 'B', type: 'n8n-nodes-base.slack', credentials: { slackApi: {} } },
        { name: 'C', type: 'n8n-nodes-unknownvendor.thing', credentials: { someWeirdVendorApi: {} } },
      ],
    };
    expect(deriveReadiness(workflow).credentials).toEqual(['Slack', 'Some Weird Vendor']);
  });

  it('ignores malformed credentials values', () => {
    const workflow = {
      nodes: [
        { name: 'A', type: 'n8n-nodes-base.slack', credentials: 'not-an-object' },
        { name: 'B', type: 'n8n-nodes-base.slack', credentials: ['array'] },
        { name: 'C', type: 'n8n-nodes-base.slack', credentials: null },
      ],
    };
    expect(deriveReadiness(workflow).credentials).toEqual([]);
  });
});

describe('deriveReadiness — replaceableValues', () => {
  it('flags emails, chat ids, sheet ids, and url-ish fields', () => {
    const workflow = {
      nodes: [
        {
          name: 'Telegram',
          type: 'n8n-nodes-base.telegram',
          parameters: { chatId: '123456789', text: 'hi' },
        },
        {
          name: 'Sheets',
          type: 'n8n-nodes-base.googleSheets',
          parameters: { documentId: '1AbCdEfGhIjKlMnOp', sheetName: 'Sheet1' },
        },
        {
          name: 'Notify',
          type: 'n8n-nodes-base.emailSend',
          parameters: { toEmail: 'ops@realcompany.io' },
        },
        {
          name: 'Callback',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { webhookUrl: 'https://hooks.realcompany.io/abc123' },
        },
      ],
    };
    const values = deriveReadiness(workflow).replaceableValues;
    const kinds = values.map(v => v.kind).sort();
    expect(kinds).toEqual(['chat_id', 'email', 'sheet_id', 'url']);
    for (const item of values) {
      expect(item.node).toBeTruthy();
      expect(item.field).toBeTruthy();
    }
  });

  it('never returns the raw value, only node, field, and kind', () => {
    const workflow = {
      nodes: [
        { name: 'Notify', type: 'n8n-nodes-base.emailSend', parameters: { toEmail: 'secret-person@company.com' } },
      ],
    };
    const values = deriveReadiness(workflow).replaceableValues;
    const serialized = JSON.stringify(values);
    expect(serialized).not.toContain('secret-person@company.com');
    expect(serialized).not.toContain('company.com');
    expect(values[0]).toEqual({ node: 'Notify', field: 'toEmail', kind: 'email' });
  });

  it('does not flag n8n expressions as hardcoded', () => {
    const workflow = {
      nodes: [
        { name: 'Sheets', type: 'n8n-nodes-base.googleSheets', parameters: { documentId: '={{ $json.sheetId }}' } },
        { name: 'Notify', type: 'n8n-nodes-base.emailSend', parameters: { toEmail: '={{ $node["Prev"].json.email }}' } },
      ],
    };
    expect(deriveReadiness(workflow).replaceableValues).toEqual([]);
  });

  it('does not flag obvious placeholder text', () => {
    const workflow = {
      nodes: [
        { name: 'Notify', type: 'n8n-nodes-base.emailSend', parameters: { toEmail: 'YOUR_EMAIL@example.com' } },
        { name: 'Bot', type: 'n8n-nodes-base.telegram', parameters: { chatId: '<your chat id>' } },
      ],
    };
    expect(deriveReadiness(workflow).replaceableValues).toEqual([]);
  });
});

describe('deriveReadiness — writeActions', () => {
  it('lists distinct write/send actions, sorted', () => {
    const workflow = {
      nodes: [
        { name: 'A', type: 'n8n-nodes-base.telegram', parameters: {} },
        { name: 'B', type: 'n8n-nodes-base.telegram', parameters: {} },
        { name: 'C', type: 'n8n-nodes-base.googleSheets', parameters: {} },
        { name: 'D', type: 'n8n-nodes-base.httpRequest', parameters: {} },
      ],
    };
    expect(deriveReadiness(workflow).writeActions).toEqual(['sends Telegram messages', 'updates Google Sheets']);
  });
});

describe('deriveReadiness — aiModel', () => {
  it('is absent when no AI node exists', () => {
    const workflow = { nodes: [{ name: 'A', type: 'n8n-nodes-base.set', parameters: {} }] };
    expect(deriveReadiness(workflow).aiModel).toEqual({ present: false, model: null });
  });

  it('detects an AI node with no pinned model', () => {
    const workflow = { nodes: [{ name: 'OpenAI', type: '@n8n/n8n-nodes-langchain.openAi', parameters: {} }] };
    expect(deriveReadiness(workflow).aiModel).toEqual({ present: true, model: null });
  });

  it('extracts a pinned model string', () => {
    const workflow = {
      nodes: [
        {
          name: 'Chat Model',
          type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
          parameters: { model: { value: 'gpt-4o-mini' } },
        },
      ],
    };
    expect(deriveReadiness(workflow).aiModel).toEqual({ present: true, model: 'gpt-4o-mini' });
  });

  it('extracts a plain string model field', () => {
    const workflow = {
      nodes: [{ name: 'Chat Model', type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', parameters: { modelId: 'claude-3-5-sonnet' } }],
    };
    expect(deriveReadiness(workflow).aiModel).toEqual({ present: true, model: 'claude-3-5-sonnet' });
  });

  it('does not mistake Airtable for an AI node', () => {
    const workflow = { nodes: [{ name: 'A', type: 'n8n-nodes-base.airtable', parameters: {} }] };
    expect(deriveReadiness(workflow).aiModel).toEqual({ present: false, model: null });
  });
});

describe('deriveReadiness — extraPackages', () => {
  it('is empty when every node ships with n8n', () => {
    const workflow = { nodes: [{ name: 'A', type: 'n8n-nodes-base.slack' }, { name: 'B', type: '@n8n/n8n-nodes-langchain.agent' }] };
    expect(deriveReadiness(workflow).extraPackages).toEqual([]);
  });

  it('lists packages outside n8n-nodes-base and @n8n', () => {
    const workflow = {
      nodes: [
        { name: 'A', type: 'n8n-nodes-mcp.mcpClientTool' },
        { name: 'B', type: '@blotato/n8n-nodes-blotato.blotato' },
        { name: 'C', type: 'n8n-nodes-mcp.mcpClient' },
      ],
    };
    expect(deriveReadiness(workflow).extraPackages).toEqual(['@blotato/n8n-nodes-blotato', 'n8n-nodes-mcp']);
  });
});

describe('deriveReadiness — versionNotes', () => {
  it('is empty for a workflow with no legacy signals', () => {
    const workflow = { nodes: [{ name: 'A', type: 'n8n-nodes-base.set', typeVersion: 3, parameters: { x: 'y' } }] };
    expect(deriveReadiness(workflow).versionNotes).toEqual([]);
  });

  it('flags the legacy Function node', () => {
    const workflow = { nodes: [{ name: 'A', type: 'n8n-nodes-base.function', parameters: {} }] };
    expect(deriveReadiness(workflow).versionNotes).toEqual(['Uses the legacy Function node']);
  });

  it('flags legacy $node[...] expressions', () => {
    const workflow = {
      nodes: [{ name: 'A', type: 'n8n-nodes-base.set', parameters: { value: '={{$node["Webhook"].json["id"]}}' } }],
    };
    expect(deriveReadiness(workflow).versionNotes).toEqual(['Uses legacy $node[...] expression syntax']);
  });

  it('flags a notable node at typeVersion 1', () => {
    const workflow = { nodes: [{ name: 'A', type: 'n8n-nodes-base.code', typeVersion: 1, parameters: {} }] };
    expect(deriveReadiness(workflow).versionNotes).toEqual(['Uses Code at its original version (typeVersion 1)']);
  });
});

describe('deriveReadiness — pinnedData', () => {
  it('is absent when workflow.pinData is missing', () => {
    expect(deriveReadiness({ nodes: [] }).pinnedData).toEqual({ present: false, nodeCount: 0 });
  });

  it('counts pinned nodes when present', () => {
    const workflow = { nodes: [], pinData: { 'Node A': [{ json: {} }], 'Node B': [{ json: {} }] } };
    expect(deriveReadiness(workflow).pinnedData).toEqual({ present: true, nodeCount: 2 });
  });

  it('treats a non-object pinData as absent', () => {
    expect(deriveReadiness({ nodes: [], pinData: 'nope' }).pinnedData).toEqual({ present: false, nodeCount: 0 });
    expect(deriveReadiness({ nodes: [], pinData: [] }).pinnedData).toEqual({ present: false, nodeCount: 0 });
  });
});

describe('deriveReadiness — isSubWorkflow', () => {
  it('is true when the only trigger is executeWorkflowTrigger', () => {
    const workflow = { nodes: [{ name: 'Start', type: 'n8n-nodes-base.executeWorkflowTrigger' }] };
    expect(deriveReadiness(workflow).isSubWorkflow).toBe(true);
  });

  it('is false when an independent trigger also exists', () => {
    const workflow = {
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.executeWorkflowTrigger' },
        { name: 'Hook', type: 'n8n-nodes-base.webhook' },
      ],
    };
    expect(deriveReadiness(workflow).isSubWorkflow).toBe(false);
  });
});
