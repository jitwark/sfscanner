import type { ScanPolicy } from '../policy/policy';
import {
  authorizationHeaderEvidence,
  isNonSecretLiteral,
  nodeFinding,
} from '../policy/policy-helpers';
import { collectSecretIndicators } from './secret-indicators';

export const rawSecretIndicatorPolicy: ScanPolicy = {
  id: 'RAW_SECRET_INDICATOR',
  name: 'Raw secret indicator',
  description: 'Flags workflow parameters that look like embedded secrets.',
  evaluate(workflow) {
    return workflow.nodes.flatMap((node) =>
      collectSecretIndicators(node.parameters).slice(0, 10).map((indicator) => nodeFinding({
        policyId: 'RAW_SECRET_INDICATOR',
        title:
          indicator.indicator === 'sensitive_value'
            ? 'Workflow parameters contain raw secret material'
            : 'Workflow parameter is named like a secret',
        severity:
          indicator.indicator === 'sensitive_value'
            ? 'HIGH'
            : indicator.hasLiteralValue
              ? 'MEDIUM'
              : 'LOW',
        node,
        evidence: {
          parameterPath: indicator.path,
          secretKind: indicator.kind,
          indicator: indicator.indicator,
          hasLiteralValue: indicator.hasLiteralValue,
        },
        message: 'This node contains a parameter that looks like a raw secret.',
        explanation:
          'The scanner found a parameter key or value pattern commonly used for tokens, passwords, API keys, cookies, or credentials.',
        whyItMatters:
          'Raw secrets in workflow JSON can be exposed through exports, scan history, logs, backups, or support bundles.',
        possibleImpact:
          'An exposed token or password can allow unauthorized access to connected systems even if the workflow itself is not malicious.',
        remediation:
          'Move the value into n8n credentials or an approved secret manager, then rotate any exposed secret.',
        remediationSteps: [
          'Move the raw value into n8n credentials or an approved secret manager.',
          'Rotate the secret if it has already been exported, shared, or stored in history.',
          'Re-scan the workflow after replacing the raw value with a managed credential reference.',
        ],
        confidence: indicator.indicator === 'sensitive_key' ? 'MEDIUM' : 'HIGH',
      })),
    );
  },
};

export const rawAuthorizationHeaderPolicy: ScanPolicy = {
  id: 'RAW_AUTH_HEADER',
  name: 'Raw Authorization header',
  description: 'Flags manually configured Authorization headers.',
  evaluate(workflow) {
    return workflow.nodes
      .map((node) => ({ node, evidence: authorizationHeaderEvidence(node.parameters) }))
      .filter((candidate) => candidate.evidence.present)
      .map(({ node, evidence }) => nodeFinding({
        policyId: 'RAW_AUTH_HEADER',
        title: evidence.literal
          ? 'Raw Authorization header may expose credentials'
          : 'Authorization header is set from an expression',
        severity: evidence.literal ? 'HIGH' : 'INFO',
        node,
        evidence: { header: 'Authorization', literalValue: evidence.literal },
        message: 'This node configures a raw Authorization header.',
        explanation:
          'The workflow parameters appear to define an Authorization header directly instead of using managed n8n credentials.',
        whyItMatters:
          'Raw credential material in node parameters is easier to copy, persist, log, or expose in exported workflow JSON.',
        possibleImpact:
          'API keys or bearer tokens can be leaked through workflow exports, scan history, logs, or support bundles.',
        remediation: 'Use n8n credentials or a managed secret reference instead of raw headers.',
        remediationSteps: [
          'Move the secret into n8n credentials or an approved secret manager.',
          'Rotate any token that has already been stored in raw workflow JSON.',
          'Re-scan after replacing the raw header with a managed credential reference.',
        ],
        confidence: 'MEDIUM',
      }));
  },
};

export { isNonSecretLiteral };
