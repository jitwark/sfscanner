import type { AnalysisDiagnostic, ScanPolicy } from '../policy/policy';
import { nodeFinding } from '../policy/policy-helpers';
import { collectUrlOutcome } from '../policy/url-outcome';

export function createUnapprovedDomainPolicy(approvedDomains: readonly string[]): ScanPolicy {
  const approved = new Set(approvedDomains.map((domain) => domain.toLowerCase()));

  return {
    id: 'UNAPPROVED_DOMAIN',
    name: 'Unapproved external domain',
    description: 'Flags external URLs outside the configured domain allowlist.',
    diagnose(workflow) {
      if (approved.size === 0) return [];
      const diagnostics: AnalysisDiagnostic[] = [];
      for (const node of workflow.nodes) {
        const collected = collectUrlOutcome(node.parameters);
        if (collected.state !== 'UNKNOWN') continue;
        diagnostics.push({
          code: 'POLICY_EXECUTION_FAILED', category: 'POLICY',
          location: { nodeId: node.id, nodeName: node.name, path: node.sourcePath },
        });
      }
      return diagnostics;
    },
    evaluate(workflow) {
      if (approved.size === 0) return [];

      return workflow.nodes.flatMap((node) => {
        const collected = collectUrlOutcome(node.parameters);
        // Dynamic/unsupported destinations stay UNKNOWN at the collector and are carried by the
        // canonical destination inventory. This rule never turns an unknown into an approved host.
        const domains = collected.urls.map((url) => url.hostname.toLowerCase());
        return domains
          .filter((domain, index) => domains.indexOf(domain) === index)
          .filter((domain) => !approved.has(domain))
          .map((domain) => nodeFinding({
            policyId: 'UNAPPROVED_DOMAIN',
            title: 'External domain is outside the approved allowlist',
            severity: 'MEDIUM',
            node,
            evidence: { domain },
            message: 'This workflow calls a domain outside the approved allowlist.',
            explanation:
              'The node parameters contain a URL whose hostname is not present in the approved domain list supplied for this scan.',
            whyItMatters:
              'Unexpected outbound domains can indicate data exfiltration, shadow integrations, or environment drift.',
            possibleImpact:
              'Workflow data may be sent to an unreviewed third party or an endpoint that is not covered by enterprise controls.',
            remediation: 'Add the domain to the approved list or replace the external call.',
            remediationSteps: [
              'Confirm the business owner and purpose for the external domain.',
              'Add the domain to the approved list only after security and compliance review.',
              'Replace the call if the destination is unnecessary or untrusted.',
            ],
            confidence: 'HIGH',
          }));
      });
    },
  };
}
