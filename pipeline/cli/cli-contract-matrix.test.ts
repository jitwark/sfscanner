import { describe, expect, it } from 'vitest';
import { parseCliArguments, type FailSeverity } from './cli-contract.js';
import { runCli } from './cli-runner.js';
import { validateSarifDocument } from './cli-schema.js';

const severities: readonly FailSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

type JsonFinding = { policyId: string; severity: FailSeverity };
type JsonItem =
  | { input: string; ok: true; result: { findings: JsonFinding[] } }
  | { input: string; ok: false; error: { kind: string; code: string } };
type JsonDocument = {
  results: JsonItem[];
  summary: { findings: number };
};

type SeverityFixture = {
  label: string;
  severity: FailSeverity;
  policyId: string;
  json: string;
};

function workflow(nodes: readonly object[]): string {
  return JSON.stringify({ name: 'CLI contract matrix fixture', nodes, connections: {} });
}

const fixtures: readonly SeverityFixture[] = [
  {
    label: 'critical command', severity: 'CRITICAL', policyId: 'N8N_EXECUTE_COMMAND',
    json: workflow([{ id: 'command', name: 'Run shell', type: 'n8n-nodes-base.executeCommand', parameters: { command: 'echo matrix' } }]),
  },
  {
    label: 'high authorization header', severity: 'HIGH', policyId: 'RAW_AUTH_HEADER',
    json: workflow([{ id: 'http', name: 'Call API', type: 'n8n-nodes-base.httpRequest', parameters: {
      headerParameters: { parameters: [{ name: 'Authorization', value: 'Bearer fake-matrix-token' }] },
    } }]),
  },
  {
    label: 'medium unapproved domain', severity: 'MEDIUM', policyId: 'UNAPPROVED_DOMAIN',
    json: workflow([{ id: 'http', name: 'Call API', type: 'n8n-nodes-base.httpRequest', parameters: {
      url: 'https://unapproved.example.test/events',
    } }]),
  },
  {
    label: 'low code node', severity: 'LOW', policyId: 'N8N_CODE_NODE',
    json: workflow([{ id: 'code', name: 'Transform', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return items;' } }]),
  },
  {
    label: 'info expression header', severity: 'INFO', policyId: 'RAW_AUTH_HEADER',
    json: workflow([{ id: 'http', name: 'Call API', type: 'n8n-nodes-base.httpRequest', parameters: {
      headerParameters: { parameters: [{ name: 'Authorization', value: '={{ $credentials.token }}' }] },
    } }]),
  },
];

function parseJson(stdout: string): JsonDocument {
  return JSON.parse(stdout) as JsonDocument;
}

function reachesThreshold(finding: FailSeverity, threshold: FailSeverity): boolean {
  return severities.indexOf(finding) <= severities.indexOf(threshold);
}

describe('CLI fail-on threshold matrix', () => {
  for (const fixture of fixtures) {
    describe(fixture.label, () => {
      it.each(severities)('returns findings exit code only at or above %s', async (threshold) => {
        const result = await runCli([
          'scan', '-', '--format', 'json', '--fail-on', threshold.toLowerCase(),
          '--approved-domain', 'approved.example.test',
        ], { stdin: new TextEncoder().encode(fixture.json) });
        const document = parseJson(result.stdout);
        const item = document.results[0];

        expect(item?.ok).toBe(true);
        if (!item || !item.ok) return;
        expect(item.result.findings).toEqual(expect.arrayContaining([
          expect.objectContaining({ policyId: fixture.policyId, severity: fixture.severity }),
        ]));
        expect(item.result.findings.every((finding) => finding.severity === fixture.severity)).toBe(true);
        expect(document.summary.findings).toBe(item.result.findings.length);
        expect(result.exitCode).toBe(reachesThreshold(fixture.severity, threshold) ? 1 : 0);
      });
    });
  }
});

describe('CLI contract matrix boundaries', () => {
  it('preserves repeated approved domains when options are interleaved with inputs', () => {
    expect(parseCliArguments([
      'scan', '-', '--approved-domain=API.Example.Test', 'workflow.json',
      '--approved-domain', 'hooks.example.test', '--approved-domain=API.Example.Test',
    ])).toMatchObject({
      ok: true,
      command: {
        kind: 'scan', inputs: ['-', 'workflow.json'],
        approvedDomains: ['API.Example.Test', 'hooks.example.test', 'API.Example.Test'],
      },
    });
  });

  it('gives cancellation precedence over findings and emits valid SARIF diagnostics', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCli(
      ['scan', '-', '--format', 'sarif', '--fail-on', 'CRITICAL'],
      { stdin: new TextEncoder().encode(fixtures[0]!.json), signal: controller.signal },
    );
    const sarif = JSON.parse(result.stdout) as {
      runs: Array<{ results: unknown[]; invocations: Array<{ executionSuccessful: boolean; toolExecutionNotifications: unknown[] }> }>;
    };

    expect(result).toMatchObject({ exitCode: 130, stderr: '' });
    expect(validateSarifDocument(sarif)).toEqual({ ok: true });
    expect(sarif.runs[0]!.results).toEqual([]);
    expect(sarif.runs[0]!.invocations[0]).toMatchObject({
      executionSuccessful: false,
      toolExecutionNotifications: [expect.objectContaining({
        properties: { input: '-', kind: 'cancelled', code: 'CANCELLED' },
      })],
    });
  });
});
