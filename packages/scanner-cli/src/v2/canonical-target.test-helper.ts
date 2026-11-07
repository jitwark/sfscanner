import { createTargetContextDigestV3 } from '@hub/contracts/scanner-target-v3';
import type { TargetContextV3 } from '@hub/contracts/scanner-v2-result';

/** Keep result fixtures admitted without repairing arbitrary caller-supplied target mutations. */
export function canonicalTargetFixture(overrides: Partial<Omit<TargetContextV3, 'contextDigest'>> = {}): TargetContextV3 {
  const target = { schemaVersion: 'scanner-target-v3', edition: 'UNKNOWN', deployment: 'UNKNOWN',
    role: 'UNKNOWN', taskRunner: 'UNKNOWN', communityPackages: [], configuration: [], ...overrides } as const;
  return { ...target, contextDigest: createTargetContextDigestV3(target) };
}
