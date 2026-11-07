import { LIMITS } from '@hub/contracts';

export type ScannerParityFixture = {
  id: 'safe' | 'risky' | 'malformed' | 'oversized' | 'analyzer-cap';
  kind: 'valid' | 'rejected';
  json: string;
  rejectionCode?: 'INVALID_JSON' | 'WORKFLOW_TOO_LARGE';
};

const safeWorkflow = {
  name: 'Parity safe workflow',
  nodes: [{ id: 'manual', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} }],
  connections: {},
};

const riskyWorkflow = {
  name: 'Parity risky workflow',
  nodes: [
    { id: 'webhook', name: 'Public webhook', type: 'n8n-nodes-base.webhook', parameters: { authentication: 'none' } },
    { id: 'command', name: 'Run shell', type: 'n8n-nodes-base.executeCommand', parameters: { command: 'rm -rf /tmp/example' } },
    { id: 'http', name: 'Call API', type: 'n8n-nodes-base.httpRequest', parameters: { apiKey: 'sk_live_parity_fixture_secret' } },
  ],
  connections: {
    'Public webhook': { main: [[{ node: 'Run shell', type: 'main', index: 0 }]] },
    'Run shell': { main: [[{ node: 'Call API', type: 'main', index: 0 }]] },
  },
};

const analyzerCapWorkflow = {
  name: 'Parity analyzer cap workflow',
  nodes: Array.from({ length: 20 }, (_, index) => ({
    id: `code-${index}`,
    name: `Code ${index}`,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    parameters: { language: 'javaScript', jsCode: 'eval(a);\n'.repeat(10) },
  })),
  connections: {},
};

export const scannerParityFixtures: readonly ScannerParityFixture[] = [
  { id: 'safe', kind: 'valid', json: JSON.stringify(safeWorkflow) },
  { id: 'risky', kind: 'valid', json: JSON.stringify(riskyWorkflow) },
  { id: 'analyzer-cap', kind: 'valid', json: JSON.stringify(analyzerCapWorkflow) },
  { id: 'malformed', kind: 'rejected', json: '{"nodes":[', rejectionCode: 'INVALID_JSON' },
  {
    id: 'oversized',
    kind: 'rejected',
    json: JSON.stringify({ nodes: [{ name: 'Large', type: 'n8n-nodes-base.noOp', parameters: { value: 'x'.repeat(LIMITS.maxWorkflowBytes + 1) } }], connections: {} }),
    rejectionCode: 'WORKFLOW_TOO_LARGE',
  },
];

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires finite numbers');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${fields.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}
