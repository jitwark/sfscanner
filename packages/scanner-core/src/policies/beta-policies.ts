import type { ScanPolicy } from '../policy/policy';
import { createUnapprovedDomainPolicy } from './domain-policy';
import { rawAuthorizationHeaderPolicy, rawSecretIndicatorPolicy } from './credential-policies';
import { codeNodePolicy, executeCommandPolicy } from './execution-policies';
import { unknownNodePackagePolicy, webhookExposurePolicy } from './package-and-webhook-policies';

export type BetaPolicyOptions = {
  approvedDomains?: readonly string[];
};

export function createBetaDefaultPolicies(options: BetaPolicyOptions = {}): ScanPolicy[] {
  return [
    executeCommandPolicy,
    codeNodePolicy,
    rawAuthorizationHeaderPolicy,
    rawSecretIndicatorPolicy,
    createUnapprovedDomainPolicy(options.approvedDomains ?? []),
    unknownNodePackagePolicy,
    webhookExposurePolicy,
  ];
}
