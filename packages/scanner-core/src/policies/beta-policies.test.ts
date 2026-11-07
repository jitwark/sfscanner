import { describe, expect, it } from 'vitest';
import type { NormalizedWorkflow, NormalizedWorkflowNode } from '../workflow';
import { createBetaDefaultPolicies } from './beta-policies';

function node(
  id: string,
  type: string,
  parameters: Record<string, unknown> = {},
): NormalizedWorkflowNode {
  return { id, name: id, type, parameters, sourcePath: `/nodes/${id}` };
}

function workflow(nodes: NormalizedWorkflowNode[]): NormalizedWorkflow {
  return { nodes } as NormalizedWorkflow;
}

function policy(id: string, approvedDomains?: string[]) {
  const found = createBetaDefaultPolicies({ approvedDomains }).find((entry) => entry.id === id);
  expect(found).toBeDefined();
  if (!found) throw new Error(`Missing policy ${id}`);
  return found;
}

describe('package-local beta-default policies', () => {
  it('keeps the reviewed policy order and all seven identifiers', () => {
    expect(createBetaDefaultPolicies().map((entry) => entry.id)).toEqual([
      'N8N_EXECUTE_COMMAND',
      'N8N_CODE_NODE',
      'RAW_AUTH_HEADER',
      'RAW_SECRET_INDICATOR',
      'UNAPPROVED_DOMAIN',
      'UNKNOWN_NODE_PACKAGE',
      'WEBHOOK_EXPOSURE',
    ]);
  });

  it('reports execute-command findings with reviewed metadata', () => {
    const finding = policy('N8N_EXECUTE_COMMAND').evaluate(workflow([
      node('command', 'n8n-nodes-base.executeCommand', { command: 'echo hello' }),
    ]))[0];

    expect(finding).toMatchObject({
      policyId: 'N8N_EXECUTE_COMMAND',
      title: 'Execute Command node can run shell commands',
      severity: 'CRITICAL',
      evidence: { nodeType: 'n8n-nodes-base.executeCommand' },
      remediation: 'Remove the Execute Command node or isolate it behind strict approval.',
    });
  });

  it('reports code-node findings as low-severity review signals', () => {
    const finding = policy('N8N_CODE_NODE').evaluate(workflow([
      node('code', 'n8n-nodes-base.code'),
      node('function', 'n8n-nodes-base.function'),
      node('function-item', 'n8n-nodes-base.functionItem'),
    ]));

    expect(finding).toHaveLength(3);
    expect(finding.map((entry) => [entry.title, entry.severity, entry.evidence])).toEqual([
      ['Custom code node requires security review', 'LOW', { nodeType: 'n8n-nodes-base.code' }],
      ['Custom code node requires security review', 'LOW', { nodeType: 'n8n-nodes-base.function' }],
      ['Custom code node requires security review', 'LOW', { nodeType: 'n8n-nodes-base.functionItem' }],
    ]);
  });

  it('distinguishes literal and expression Authorization headers', () => {
    const literal = policy('RAW_AUTH_HEADER').evaluate(workflow([
      node('literal', 'n8n-nodes-base.httpRequest', { headers: { Authorization: 'Bearer literal-token' } }),
    ]))[0];
    const expression = policy('RAW_AUTH_HEADER').evaluate(workflow([
      node('expression', 'n8n-nodes-base.httpRequest', { headers: { Authorization: '={{ $credentials.token }}' } }),
    ]))[0];

    expect(literal).toMatchObject({
      title: 'Raw Authorization header may expose credentials',
      severity: 'HIGH',
      evidence: { header: 'Authorization', literalValue: true },
      remediation: 'Use n8n credentials or a managed secret reference instead of raw headers.',
    });
    expect(expression).toMatchObject({
      title: 'Authorization header is set from an expression',
      severity: 'INFO',
      evidence: { header: 'Authorization', literalValue: false },
    });
  });

  it('preserves secret-indicator severity, evidence, and placeholder suppression', () => {
    const findings = policy('RAW_SECRET_INDICATOR').evaluate(workflow([
      node('secret', 'n8n-nodes-base.set', {
        apiKey: 'sk_live_12345678',
        password: 'plain-value',
        token: '{{ $credentials.token }}',
      }),
    ]));

    expect(findings).toHaveLength(2);
    expect(findings.map((entry) => ({
      title: entry.title,
      severity: entry.severity,
      evidence: entry.evidence,
    }))).toEqual([
      {
        title: 'Workflow parameters contain raw secret material',
        severity: 'HIGH',
        evidence: {
          parameterPath: 'parameters.apiKey',
          secretKind: 'Stripe API key',
          indicator: 'sensitive_value',
          hasLiteralValue: true,
        },
      },
      {
        title: 'Workflow parameter is named like a secret',
        severity: 'MEDIUM',
        evidence: {
          parameterPath: 'parameters.password',
          secretKind: 'password',
          indicator: 'sensitive_key',
          hasLiteralValue: true,
        },
      },
    ]);
  });

  it('reports unique unapproved URL hostnames and honors a case-insensitive allowlist', () => {
    const parameters = {
      first: 'https://API.example.test/v1',
      nested: ['https://api.example.test/other', 'https://blocked.example.test'],
    };
    expect(policy('UNAPPROVED_DOMAIN').evaluate(workflow([
      node('request', 'n8n-nodes-base.httpRequest', parameters),
    ]))).toEqual([]);

    const findings = policy('UNAPPROVED_DOMAIN', ['api.example.test']).evaluate(workflow([
      node('request', 'n8n-nodes-base.httpRequest', parameters),
    ]));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      title: 'External domain is outside the approved allowlist',
      severity: 'MEDIUM',
      evidence: { domain: 'blocked.example.test' },
      remediation: 'Add the domain to the approved list or replace the external call.',
    });
  });

  it('deduplicates unknown node packages while preserving official namespaces', () => {
    const findings = policy('UNKNOWN_NODE_PACKAGE').evaluate(workflow([
      node('community-a', 'community.nodes.first'),
      node('community-b', 'community.nodes.second'),
      node('other', '@vendor/custom.node'),
      node('core', 'n8n-nodes-base.httpRequest'),
      node('langchain', '@n8n/n8n-nodes-langchain.agent'),
    ]));

    expect(findings.map((entry) => entry.evidence)).toEqual([
      { nodeType: 'community.nodes.first', nodePackage: 'community' },
      { nodeType: '@vendor/custom.node', nodePackage: '@vendor/custom' },
    ]);
  });

  it('reports only webhook triggers without explicit authentication', () => {
    const findings = policy('WEBHOOK_EXPOSURE').evaluate(workflow([
      node('missing', 'n8n-nodes-base.webhook'),
      node('none', 'n8n-nodes-base.webhook', { authentication: 'NONE' }),
      node('header', 'n8n-nodes-base.webhook', { authentication: 'headerAuth' }),
    ]));

    expect(findings).toHaveLength(2);
    expect(findings.map((entry) => [entry.location.nodeId, entry.evidence, entry.severity])).toEqual([
      ['missing', { authentication: null }, 'MEDIUM'],
      ['none', { authentication: 'NONE' }, 'MEDIUM'],
    ]);
  });

  it('reports case, whitespace, and unknown webhook values the pinned runtime fails open on', () => {
    // n8n-nodes-base@2.15.1 `validateWebhookAuthentication` compares the stored value with
    // `===` against basicAuth/headerAuth/jwtAuth, has no final else, and never trims or
    // case-folds. Every value below therefore reaches the handler unauthenticated.
    const unauthenticated = [
      'BASICAUTH', 'BasicAuth', ' basicAuth ', 'basicAuth ', ' headerAuth', 'jwtAuth\r\n',
      'oauth2', 'bearerAuth', 'unknown',
    ];
    const exact = ['basicAuth', 'headerAuth', 'jwtAuth'];
    const findings = policy('WEBHOOK_EXPOSURE').evaluate(workflow([
      ...unauthenticated.map((value, index) => node(`variant-${index}`, 'n8n-nodes-base.webhook', { authentication: value })),
      ...exact.map((value, index) => node(`exact-${index}`, 'n8n-nodes-base.webhook', { authentication: value })),
    ]));

    expect(findings.map((entry) => entry.location.nodeId)).toEqual(
      unauthenticated.map((_, index) => `variant-${index}`),
    );
    expect(findings.map((entry) => entry.severity)).toEqual(unauthenticated.map(() => 'MEDIUM'));
    expect(findings.map((entry) => entry.evidence)).toEqual(
      unauthenticated.map((value) => ({ authentication: value })),
    );
  });
});
