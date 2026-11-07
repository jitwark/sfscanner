import { describe, expect, it } from 'vitest';
import { canonicalizeFindings } from '@hub/scanner-core/result/canonical-findings';
import type { RuleCatalogEntry } from '@hub/scanner-core/rule-catalog';

const catalog: readonly RuleCatalogEntry[] = [
  {
    policyId: 'SCORED', defaultSeverity: 'HIGH', defaultConfidence: 'HIGH', precision: 'HIGH',
    policyEffect: 'LEGACY_SCORE', curationAction: 'NONE', serveAction: 'DISPLAY', cweIds: [],
  },
  {
    policyId: 'ADVISORY', defaultSeverity: 'HIGH', defaultConfidence: 'HIGH', precision: 'HIGH',
    policyEffect: 'REPORT_ONLY', curationAction: 'REVIEW', serveAction: 'DISPLAY', cweIds: [],
  },
];

function finding(policyId: string) {
  return {
    policyId, title: 'Title', severity: 'HIGH' as const, location: {}, evidence: {},
    message: 'Message', explanation: 'Explanation', whyItMatters: 'Why',
    possibleImpact: 'Impact', remediation: 'Fix', remediationSteps: ['Fix'],
    confidence: 'HIGH' as const,
  };
}

describe('canonicalizeFindings', () => {
  it('stamps the catalog policy effect onto each finding', () => {
    const result = canonicalizeFindings(
      [finding('SCORED'), finding('ADVISORY'), finding('UNLISTED')],
      catalog,
    );

    expect(result.findings.map((entry) => [entry.policyId, entry.policyEffect])).toEqual([
      ['SCORED', 'LEGACY_SCORE'],
      ['ADVISORY', 'REPORT_ONLY'],
      ['UNLISTED', 'LEGACY_SCORE'],
    ]);
  });

  it('ignores a policy-supplied effect and uses the catalog', () => {
    const result = canonicalizeFindings(
      [{ ...finding('ADVISORY'), policyEffect: 'LEGACY_SCORE' }],
      catalog,
    );

    expect(result.findings[0].policyEffect).toBe('REPORT_ONLY');
  });

  it('returns a redacted copy without changing the stable finding contract', () => {
    const secret = 'sk_live_abc123456789';
    const finding = {
      policyId: 'TEST_POLICY', title: 'Test', severity: 'HIGH' as const,
      location: { nodeName: `Run ${secret}` }, evidence: { token: secret },
      message: `Token ${secret}`, explanation: 'Explanation', whyItMatters: 'Why',
      possibleImpact: 'Impact', remediation: 'Fix', remediationSteps: ['Fix'], confidence: 'HIGH' as const,
    };

    const result = canonicalizeFindings([finding], catalog);

    expect(result).toEqual({
      findings: [{
        ...finding, location: { nodeName: 'Run [REDACTED]' }, evidence: { token: '[REDACTED]' },
        message: 'Token [REDACTED]', policyEffect: 'LEGACY_SCORE',
      }],
      rejectedCount: 0,
      collapsedCount: 0,
    });
    expect(finding.evidence.token).toBe(secret);
  });

  it('drops malformed findings without discarding valid redacted findings', () => {
    const valid = {
      policyId: 'VALID_POLICY', title: 'Valid', severity: 'HIGH' as const,
      location: {}, evidence: {}, message: 'Message', explanation: 'Explanation',
      whyItMatters: 'Why', possibleImpact: 'Impact', remediation: 'Fix',
      remediationSteps: ['Fix'], confidence: 'HIGH' as const,
    };
    const malformed = { policyId: 'BROKEN_POLICY', severity: 'HIGH' };

    expect(canonicalizeFindings([valid, malformed as never], catalog)).toEqual({
      findings: [{ ...valid, policyEffect: 'LEGACY_SCORE' }],
      rejectedCount: 1,
      collapsedCount: 0,
    });
  });
});
