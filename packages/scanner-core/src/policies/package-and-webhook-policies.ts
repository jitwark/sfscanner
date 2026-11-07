import type { ScanPolicy } from '../policy/policy';
import { hasWebhookAuthentication, nodeFinding } from '../policy/policy-helpers';

const officialNodeNamespaces = ['n8n-nodes-base.', '@n8n/'];

export const unknownNodePackagePolicy: ScanPolicy = {
  id: 'UNKNOWN_NODE_PACKAGE',
  name: 'Unknown node package',
  description: 'Flags nodes that do not come from an official n8n package namespace.',
  evaluate(workflow) {
    const seen = new Set<string>();
    return workflow.nodes
      .filter((node) => !officialNodeNamespaces.some((namespace) => node.type.startsWith(namespace)))
      .filter((node) => {
        const packageName = node.type.split('.')[0] ?? node.type;
        if (seen.has(packageName)) return false;
        seen.add(packageName);
        return true;
      })
      .map((node) => nodeFinding({
        policyId: 'UNKNOWN_NODE_PACKAGE',
        title: 'Node package is not from an official n8n namespace',
        severity: 'LOW',
        node,
        evidence: { nodeType: node.type, nodePackage: node.type.split('.')[0] ?? node.type },
        message: 'This workflow uses a community or custom node package.',
        explanation:
          'The node type does not start with an official n8n package namespace, so it comes from a community or custom package.',
        whyItMatters:
          'Community and custom packages can add supply-chain, maintenance, and permission risks that differ from core nodes.',
        possibleImpact:
          'A vulnerable or unmaintained package could process sensitive workflow data or run unexpected code.',
        remediation: 'Review the package source, version, permissions, and maintenance status.',
        remediationSteps: [
          'Verify the package source, maintainer, and version history.',
          'Check whether the node requires credentials or broad runtime permissions.',
          'Pin approved versions and remove packages that are not actively maintained.',
        ],
        confidence: 'MEDIUM',
      }));
  },
};

export const webhookExposurePolicy: ScanPolicy = {
  id: 'WEBHOOK_EXPOSURE',
  name: 'Webhook exposure',
  description: 'Flags webhook triggers without clear authentication markers.',
  evaluate(workflow) {
    return workflow.nodes
      .filter((node) => node.type === 'n8n-nodes-base.webhook')
      .filter((node) => !hasWebhookAuthentication(node.parameters))
      .map((node) => nodeFinding({
        policyId: 'WEBHOOK_EXPOSURE',
        title: 'Webhook trigger lacks clear authentication',
        severity: 'MEDIUM',
        node,
        evidence: { authentication: node.parameters.authentication ?? null },
        message: 'This webhook does not show a clear authentication marker.',
        explanation:
          'The webhook node appears to accept inbound requests without an explicit authentication mode in the workflow parameters.',
        whyItMatters:
          'Unauthenticated inbound endpoints can be abused for spam, data injection, or unexpected workflow execution.',
        possibleImpact:
          'External callers may trigger automations, create records, or send data into connected systems without authorization.',
        remediation: 'Require webhook authentication or place the endpoint behind trusted controls.',
        remediationSteps: [
          'Enable webhook authentication in n8n when the endpoint is not intentionally public.',
          'Place the endpoint behind a gateway, allowlist, or rate limiter for production use.',
          'Monitor webhook usage for unexpected request volume or payloads.',
        ],
        confidence: 'MEDIUM',
      }));
  },
};
