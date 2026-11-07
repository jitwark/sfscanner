import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SCANNER_RESULT_SCHEMA_VERSION } from '@hub/contracts';
import { scanJson } from './scan-core';

const parserControl = vi.hoisted(() => ({ throwUnexpected: false }));

vi.mock('@hub/scanner-core/workflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hub/scanner-core/workflow')>();
  const parse = actual.parseWorkflowJson;
  return {
    ...actual,
    parseWorkflowJson: (json: string, options?: Parameters<typeof parse>[1]) => {
      if (parserControl.throwUnexpected) throw new Error('synthetic parser invariant failure');
      return parse(json, options);
    },
  };
});

const safeWorkflow = JSON.stringify({
  name: 'CLI safe fixture',
  nodes: [
    { id: 'trigger', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
    { id: 'set', name: 'Set value', type: 'n8n-nodes-base.set', parameters: { value: 'hello' } },
  ],
  connections: { Start: { main: [[{ node: 'Set value', type: 'main', index: 0 }]] } },
});

const riskyWorkflow = JSON.stringify({
  name: 'CLI risky fixture',
  nodes: [{
    id: 'command', name: 'Run command', type: 'n8n-nodes-base.executeCommand',
    parameters: { command: 'echo test' },
  }],
  connections: {},
});

describe('CLI scanner core boundary', () => {
  it('returns the authoritative browser-compatible result for valid JSON', () => {
    const outcome = scanJson(safeWorkflow, { profile: 'beta-default', approvedDomains: [] });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.schemaVersion).toBe(SCANNER_RESULT_SCHEMA_VERSION);
      expect(outcome.result.policyProfile).toBe('beta-default');
      expect(outcome.result.workflow.nodeCount).toBe(2);
    }
  });

  it('passes the selected profile and approved domains to the deterministic engine', () => {
    const outcome = scanJson(safeWorkflow, { profile: 'beta-hardened', approvedDomains: ['api.example.test'] });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.policyProfile).toBe('beta-hardened');
  });

  it('keeps valid, malformed, and risky fixture behavior compatible', () => {
    const valid = scanJson(safeWorkflow, { profile: 'beta-default', approvedDomains: [] });
    const malformed = scanJson('{"nodes":', { profile: 'beta-default', approvedDomains: [] });
    const risky = scanJson(riskyWorkflow, { profile: 'beta-default', approvedDomains: [] });

    expect(valid).toMatchObject({ ok: true, result: { analysisStatus: 'COMPLETE', findings: [] } });
    expect(malformed).toMatchObject({ ok: false, kind: 'input', code: 'INVALID_JSON' });
    expect(risky).toMatchObject({
      ok: true,
      result: {
        analysisStatus: 'COMPLETE',
        riskAssessment: { grade: 'HIGH', score: 55 },
        findings: [expect.objectContaining({ policyId: 'N8N_EXECUTE_COMMAND', severity: 'CRITICAL' })],
      },
    });
  });

  it('does not load app-local workflow or scanner modules at the CLI boundary', () => {
    const sources = [
      new URL('./scan-core.ts', import.meta.url),
      new URL('../scan/scanner-core-adapter.ts', import.meta.url),
      new URL('./cli-metadata.ts', import.meta.url),
    ].map((url) => readFileSync(url, 'utf8')).join('\n');

    expect(sources).not.toMatch(/(?:from\s+|import\(\s*)['"][^'"]*app[\\/]src[\\/](?:workflow|scanner)/u);
  });

  it.each([
    ['invalid JSON', '{"nodes":', 'INVALID_JSON'],
    ['wrong root', JSON.stringify({ nodes: [], connections: [] }), 'MALFORMED_WORKFLOW'],
  ] as const)('returns a typed input failure for %s', (_label, json, code) => {
    expect(scanJson(json, { profile: 'beta-default', approvedDomains: [] })).toMatchObject({ ok: false, kind: 'input', code });
  });

  it('does not throw or report INTERNAL for raw JSON containing prototype-like keys', () => {
    const json = '{"__proto__":{"polluted":true},"nodes":[{"id":"start",'
      + '"name":"Start","type":"n8n-nodes-base.manualTrigger",'
      + '"parameters":{"__proto__":{"nested":true},"constructor":"value",'
      + '"prototype":"value"}}],"connections":{}}';

    expect(() => scanJson(json, { profile: 'beta-default', approvedDomains: [] })).not.toThrow();
    expect(scanJson(json, { profile: 'beta-default', approvedDomains: [] })).toMatchObject({ ok: true });
  });

  it('contains an unexpected parser exception at the direct CLI boundary', () => {
    parserControl.throwUnexpected = true;

    try {
      expect(() => scanJson(safeWorkflow, { profile: 'beta-default', approvedDomains: [] })).not.toThrow();
      expect(scanJson(safeWorkflow, { profile: 'beta-default', approvedDomains: [] })).toMatchObject({
        ok: false,
        kind: 'internal',
        code: 'INTERNAL',
      });
    } finally {
      parserControl.throwUnexpected = false;
    }
  });

  it('does not include raw workflow secrets in the returned presentation', () => {
    const secret = 'sk_live_cli_fixture_not_for_output';
    const outcome = scanJson(JSON.stringify({
      nodes: [{ id: 'http', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', parameters: { header: `Authorization: Bearer ${secret}` } }],
      connections: {},
    }), { profile: 'beta-hardened', approvedDomains: [] });

    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it('withholds grade fields when a required analyzer cannot read or parse a unit', () => {
    const outcome = scanJson(JSON.stringify({
      nodes: [
        { id: 'trigger', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
        { id: 'expression', name: 'Runner', type: 'n8n-nodes-base.executeCommand', parameters: { command: '={{ $json.( }}' } },
        { id: 'javascript', name: 'Broken JavaScript', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { language: 'javaScript', jsCode: 'const = ;' } },
        { id: 'legacy', name: 'Legacy JavaScript', type: 'n8n-nodes-base.function', typeVersion: 1, parameters: { functionItemCode: 'eval(input)' } },
        { id: 'unsupported', name: 'Unsupported variant', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { language: 'ruby', jsCode: 'eval(input)' } },
        { id: 'python', name: 'Broken Python', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { language: 'pythonNative', pythonCode: 'def broken(:' } },
        { id: 'python-missing', name: 'Missing Python', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { language: 'pythonNative' } },
      ],
      connections: { Webhook: { main: [[{ node: 'Runner', type: 'main', index: 0 }]] } },
    }), { profile: 'beta-hardened', approvedDomains: [] });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.analysisStatus).toBe('INDETERMINATE');
      expect(outcome.result.analysisDiagnostics).toEqual(expect.arrayContaining(
        [1, 2, 3, 4, 5, 6].map((index) => expect.objectContaining({
          code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY', location: { path: `/nodes/${index}` },
        })),
      ));
      expect(outcome.result).not.toHaveProperty('riskAssessment');
      expect(outcome.result).not.toHaveProperty('humanSummary');
      expect(outcome.result).not.toHaveProperty('summary');
    }
  });

  it('keeps the grade for ordinary source-span omissions', () => {
    const outcome = scanJson(JSON.stringify({
      nodes: [
        { id: 'duplicate', name: 'Run command', type: 'n8n-nodes-base.executeCommand', parameters: { command: 'echo test' } },
        { id: 'duplicate', name: 'Other node', type: 'n8n-nodes-base.set', parameters: {} },
      ],
      connections: {},
    }), { profile: 'beta-hardened', approvedDomains: [] });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.analysisStatus).toBe('DEGRADED');
      expect(outcome.result.analysisDiagnostics).toContainEqual({ code: 'SOURCE_SPAN_UNAVAILABLE', category: 'SOURCE' });
      expect(outcome.result).toHaveProperty('riskAssessment');
      expect(outcome.result).toHaveProperty('humanSummary');
      expect(outcome.result).toHaveProperty('summary');
    }
  });
});
