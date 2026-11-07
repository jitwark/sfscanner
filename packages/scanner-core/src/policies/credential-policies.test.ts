import { describe, expect, it } from 'vitest';
import type { NormalizedWorkflow, NormalizedWorkflowNode } from '../workflow';
import { rawAuthorizationHeaderPolicy } from './credential-policies';

function node(id: string, parameters: Record<string, unknown>): NormalizedWorkflowNode {
  return {
    id,
    name: id,
    type: 'n8n-nodes-base.httpRequest',
    parameters,
    sourcePath: `/nodes/${id}`,
  };
}

function workflow(nodes: NormalizedWorkflowNode[]): NormalizedWorkflow {
  return { nodes } as NormalizedWorkflow;
}

describe('raw Authorization header expression islands', () => {
  it('treats an expression-mode header with a literal island as raw credential material', () => {
    const findings = rawAuthorizationHeaderPolicy.evaluate(workflow([
      node('literal', { headers: { Authorization: '=Bearer abc123' } }),
    ]));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      policyId: 'RAW_AUTH_HEADER',
      title: 'Raw Authorization header may expose credentials',
      severity: 'HIGH',
      evidence: { header: 'Authorization', literalValue: true },
    });
  });

  it('keeps the INFO signal when the header only references runtime data', () => {
    const values = [
      '={{ $credentials.token }}',
      "='https://' + $json.x",
    ];

    expect(values.map((value, index) => {
      const findings = rawAuthorizationHeaderPolicy.evaluate(workflow([
        node(`expression-${index}`, { headers: { Authorization: value } }),
      ]));
      return findings.map((finding) => ({
        title: finding.title,
        severity: finding.severity,
        evidence: finding.evidence,
      }));
    })).toEqual(values.map(() => [{
      title: 'Authorization header is set from an expression',
      severity: 'INFO',
      evidence: { header: 'Authorization', literalValue: false },
    }]));
  });

  it('keeps the INFO signal when a public scheme prefix accompanies a managed credential', () => {
    // A bare RFC 7235 auth-scheme island is public protocol text, not credential material. Only
    // additional literal text next to the managed `$credentials` reference makes the header raw.
    const findings = rawAuthorizationHeaderPolicy.evaluate(workflow([
      node('scheme', { headers: { Authorization: '=Bearer {{ $credentials.token }}' } }),
    ]));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      title: 'Authorization header is set from an expression',
      severity: 'INFO',
      evidence: { header: 'Authorization', literalValue: false },
    });
  });

  it('keeps a literal scheme prefix with adjacent material at HIGH', () => {
    const cases = [
      '=Bearer abc123',
      '=Bearer abc123{{ $credentials.token }}',
      '=Bearer {{ $credentials.token }} extra',
    ];

    const outcomes = cases.map((value) => rawAuthorizationHeaderPolicy.evaluate(workflow([
      node('literal', { headers: { Authorization: value } }),
    ])));

    expect(outcomes).toEqual(cases.map(() => [expect.objectContaining({
      policyId: 'RAW_AUTH_HEADER',
      severity: 'HIGH',
      evidence: { header: 'Authorization', literalValue: true },
    })]));
  });

  it('treats a provider token quoted inside an expression as literal material', () => {
    const findings = rawAuthorizationHeaderPolicy.evaluate(workflow([
      node('quoted', { headers: { Authorization: '=Bearer {{ "sk_live_1234567890abcdef" }}' } }),
    ]));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'HIGH',
      evidence: { header: 'Authorization', literalValue: true },
    });
    expect(JSON.stringify(findings)).not.toContain('sk_live_1234567890abcdef');
  });
});
