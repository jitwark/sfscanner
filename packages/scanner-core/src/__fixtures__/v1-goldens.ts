export type V1GoldenCase = Readonly<{
  id: 'safe' | 'risky' | 'analyzer-cap';
  json: string;
  profile: 'beta-default' | 'beta-hardened';
  expectedDigest: string;
}>;

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

// Digests are SHA-256 of the canonical shared v1 identity/finding projection,
// derived from the current native core result and reviewed against each adapter.
export const V1_GOLDEN_CASES: readonly V1GoldenCase[] = Object.freeze([
  Object.freeze({ id: 'safe', json: JSON.stringify(safeWorkflow), profile: 'beta-default', expectedDigest: '19c3a210743dc88978a8d8508ad9affb893037d10dc3fa47dd6ef4ff7657eedf' }),
  Object.freeze({ id: 'safe', json: JSON.stringify(safeWorkflow), profile: 'beta-hardened', expectedDigest: '9bc15a88c041aa57c320d45e170b6045ddb80c059bd310758139f86b73b8a88d' }),
  Object.freeze({ id: 'risky', json: JSON.stringify(riskyWorkflow), profile: 'beta-default', expectedDigest: '0bfd1f8b4ba5ed692f849f2fb34c4f739b9b90d920d444d7d6d451b9da996b63' }),
  Object.freeze({ id: 'risky', json: JSON.stringify(riskyWorkflow), profile: 'beta-hardened', expectedDigest: '06374ad0919eda66448f363ae44958afeebd8af528ae4cb11a2f44abc0d8bb82' }),
  Object.freeze({ id: 'analyzer-cap', json: JSON.stringify(analyzerCapWorkflow), profile: 'beta-default', expectedDigest: 'd6ca7bb8e0bb8b383bc43b35d7d31fc1592a229e982d1ba3b02f9f1f8120b139' }),
  Object.freeze({ id: 'analyzer-cap', json: JSON.stringify(analyzerCapWorkflow), profile: 'beta-hardened', expectedDigest: 'c7c98d2dd50ab196e8e385168d79b56fbe120bbe8c787ccbc27ef2c488582e74' }),
]);
