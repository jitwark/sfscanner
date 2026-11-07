import { describe, expect, it } from 'vitest';
import { canonicalizeFindings } from '@hub/scanner-core/result/canonical-findings';
import { nodeFinding } from '@hub/scanner-core/policy-helpers';
import { betaDefaultRuleCatalog, betaHardenedRuleCatalog, TAINT_POLICY_IDS } from '@hub/scanner-core/rule-catalog';

const node = { id: 'n1', name: 'Sink', type: 'n8n-nodes-base.executeCommand', parameters: {}, sourcePath: '/nodes/0' };

describe('betaDefaultRuleCatalog', () => {
  it('contains no taint rule and scores every rule it does contain', () => {
    for (const rule of betaDefaultRuleCatalog) {
      expect(rule.policyEffect).toBe('LEGACY_SCORE');
      expect(TAINT_POLICY_IDS).not.toContain(rule.policyId);
    }
  });
});

describe('betaHardenedRuleCatalog', () => {
  it('catalogs every taint policy identifier as report-only', () => {
    for (const policyId of TAINT_POLICY_IDS) {
      const rule = betaHardenedRuleCatalog.find((entry) => entry.policyId === policyId);

      expect(rule, `${policyId} is missing from the hardened catalog`).toBeDefined();
      expect(rule?.policyEffect).toBe('REPORT_ONLY');
      expect(rule?.curationAction).toBe('REVIEW');
    }
  });

  it('lists every policy identifier exactly once', () => {
    const ids = betaHardenedRuleCatalog.map((rule) => rule.policyId);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('canonical boundary', () => {
  it('stamps a catalogued taint finding report-only so it cannot reach the legacy score', () => {
    const findings = TAINT_POLICY_IDS.map((policyId) => nodeFinding({
      policyId, severity: 'HIGH', node, evidence: {}, message: 'x', remediation: 'y',
    }));

    const canonical = canonicalizeFindings(findings, betaHardenedRuleCatalog);

    expect(canonical.rejectedCount).toBe(0);
    expect(canonical.findings.every((finding) => finding.policyEffect === 'REPORT_ONLY')).toBe(true);
  });

  it('would score an uncatalogued taint finding, which is why the catalog lands first', () => {
    const findings = [nodeFinding({
      policyId: TAINT_POLICY_IDS[0], severity: 'HIGH', node, evidence: {}, message: 'x', remediation: 'y',
    })];

    const canonical = canonicalizeFindings(findings, betaDefaultRuleCatalog);

    expect(canonical.findings[0].policyEffect).toBe('LEGACY_SCORE');
  });
});
