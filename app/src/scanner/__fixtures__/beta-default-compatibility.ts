import { SCANNER_RESULT_SCHEMA_VERSION } from '@hub/contracts';

export const betaDefaultCompatibilityFixture = {
  workflowJson: JSON.stringify({
    name: 'Beta default compatibility fixture',
    nodes: [
      {
        id: 'command-1',
        name: 'Run command',
        type: 'n8n-nodes-base.executeCommand',
        parameters: { command: 'echo safe-fixture' },
      },
      {
        id: 'code-1',
        name: 'Transform data',
        type: 'n8n-nodes-base.code',
        parameters: { jsCode: 'return items;' },
      },
      {
        id: 'community-1',
        name: 'Community package',
        type: '@acme/n8n-nodes-example.example',
        parameters: {},
      },
      {
        id: 'webhook-1',
        name: 'Public webhook',
        type: 'n8n-nodes-base.webhook',
        parameters: { path: 'compatibility', authentication: 'none' },
      },
    ],
    connections: {},
  }),
  expected: {
    schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
    scannerVersion: 'scanner-beta-1',
    policyProfile: 'beta-default',
    analysisStatus: 'COMPLETE',
    analysisDiagnostics: [],
    summary: { critical: 1, high: 0, medium: 1, low: 2, info: 0 },
    findings: [
      { policyId: 'N8N_EXECUTE_COMMAND', severity: 'CRITICAL', nodeId: 'command-1' },
      { policyId: 'N8N_CODE_NODE', severity: 'LOW', nodeId: 'code-1' },
      { policyId: 'UNKNOWN_NODE_PACKAGE', severity: 'LOW', nodeId: 'community-1' },
      { policyId: 'WEBHOOK_EXPOSURE', severity: 'MEDIUM', nodeId: 'webhook-1' },
    ],
  },
} as const;
