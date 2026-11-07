import { describe, expect, it } from 'vitest';
import type { NormalizedWorkflow, NormalizedWorkflowNode } from '../workflow';
import { createUnapprovedDomainPolicy } from './domain-policy';

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

describe('unapproved domain expression islands', () => {
  const policy = createUnapprovedDomainPolicy(['api.example.test']);

  it('flags the literal hostname of an expression-mode URL', () => {
    const findings = policy.evaluate(workflow([
      node('url', { url: '=https://evil.example.com/exfil' }),
    ]));

    expect(findings.map((finding) => finding.evidence.domain)).toEqual(['evil.example.com']);
  });

  it('flags a literal URL that carries an evaluated path island', () => {
    const findings = policy.evaluate(workflow([
      node('url', { url: 'https://evil.example.com/{{ $json.path }}' }),
    ]));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      policyId: 'UNAPPROVED_DOMAIN',
      severity: 'MEDIUM',
      evidence: { domain: 'evil.example.com' },
    });
  });

  it('keeps the host while redacting userinfo', () => {
    const findings = policy.evaluate(workflow([
      node('url', { url: 'https://user:pass@evil.example.com/x?token=sentinel#frag' }),
    ]));
    expect(findings.map((finding) => finding.evidence.domain)).toEqual(['evil.example.com']);
    expect(JSON.stringify(findings)).not.toContain('sentinel');
    expect(JSON.stringify(findings)).not.toContain('user:pass');
  });

  it('emits a completeness diagnostic for dynamic destinations when the allowlist is configured', () => {
    const flow = workflow([
      node('expression', { url: '={{ $json.url }}' }),
      node('literal', { url: 'https://approved.example/path' }),
    ]);
    expect(policy.diagnose?.(flow)).toEqual([
      expect.objectContaining({ code: 'POLICY_EXECUTION_FAILED', category: 'POLICY', location: expect.objectContaining({ nodeId: 'expression' }) }),
    ]);
  });

  it('leaves dynamic destinations to the canonical UNKNOWN inventory', () => {
    const findings = policy.evaluate(workflow([
      node('expression', { url: '={{ $json.url }}' }),
      node('concatenated', { url: "='https://' + $json.x" }),
    ]));

    expect(findings).toEqual([]);
  });
});
