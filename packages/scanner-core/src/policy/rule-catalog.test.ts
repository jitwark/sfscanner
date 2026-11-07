import { describe, expect, it } from 'vitest';
import {
  betaDefaultRuleCatalog,
  betaHardenedRuleCatalog,
  RULES_WITHOUT_CWE,
  TAINT_POLICY_IDS,
} from './rule-catalog';

const CWE_ID_PATTERN = /^CWE-\d+$/;
const AGENTIC_POLICY_IDS = ['TAINTED_AI_PROMPT', 'AI_AGENT_UNGATED_TOOL'];

describe('rule catalogs', () => {
  it('preserves beta-default order, metadata, and legacy scoring effect', () => {
    expect(betaDefaultRuleCatalog.map((rule) => rule.policyId)).toEqual([
      'N8N_EXECUTE_COMMAND',
      'N8N_CODE_NODE',
      'RAW_AUTH_HEADER',
      'RAW_SECRET_INDICATOR',
      'UNAPPROVED_DOMAIN',
      'UNKNOWN_NODE_PACKAGE',
      'WEBHOOK_EXPOSURE',
    ]);
    expect(betaDefaultRuleCatalog[0]).toEqual({
      policyId: 'N8N_EXECUTE_COMMAND',
      defaultSeverity: 'CRITICAL',
      defaultConfidence: 'HIGH',
      precision: 'HIGH',
      policyEffect: 'LEGACY_SCORE',
      curationAction: 'NONE',
      serveAction: 'DISPLAY',
      cweIds: ['CWE-78'],
    });
    expect(betaDefaultRuleCatalog.every((rule) => rule.policyEffect === 'LEGACY_SCORE')).toBe(true);
  });

  it('appends hardened report-only rules in deterministic order', () => {
    expect(betaHardenedRuleCatalog.slice(0, betaDefaultRuleCatalog.length)).toEqual(betaDefaultRuleCatalog);
    expect(betaHardenedRuleCatalog.slice(betaDefaultRuleCatalog.length).map((rule) => rule.policyId)).toEqual([
      'JAVASCRIPT_DYNAMIC_EXECUTION',
      'PYTHON_DYNAMIC_EXECUTION',
      ...TAINT_POLICY_IDS,
    ]);
    expect(betaHardenedRuleCatalog.every((rule, index) => index < betaDefaultRuleCatalog.length
      ? rule.policyEffect === 'LEGACY_SCORE'
      : rule.policyEffect === 'REPORT_ONLY')).toBe(true);
    expect(new Set(betaHardenedRuleCatalog.map((rule) => rule.policyId)).size)
      .toBe(betaHardenedRuleCatalog.length);
    expect(JSON.stringify(betaHardenedRuleCatalog)).toBe(JSON.stringify([...betaHardenedRuleCatalog]));
  });

  it('catalogs every taint identifier as reviewable report-only metadata', () => {
    for (const policyId of TAINT_POLICY_IDS) {
      expect(betaHardenedRuleCatalog).toContainEqual(expect.objectContaining({
        policyId,
        defaultSeverity: expect.any(String),
        defaultConfidence: expect.any(String),
        precision: expect.any(String),
        policyEffect: 'REPORT_ONLY',
        curationAction: 'REVIEW',
        serveAction: 'DISPLAY',
      }));
    }
  });
});

describe('CWE and OWASP Agentic mappings', () => {
  it('gives every rule at least one well-formed CWE ID, except the documented exception list', () => {
    for (const rule of betaHardenedRuleCatalog) {
      if ((RULES_WITHOUT_CWE as readonly string[]).includes(rule.policyId)) {
        expect(rule.cweIds, `${rule.policyId} is on RULES_WITHOUT_CWE but declares CWE IDs`).toEqual([]);
        continue;
      }
      expect(rule.cweIds.length, `${rule.policyId} has no CWE mapping`).toBeGreaterThan(0);
      for (const cweId of rule.cweIds) {
        expect(cweId, `${rule.policyId} has a malformed CWE ID: ${cweId}`).toMatch(CWE_ID_PATTERN);
      }
    }
  });

  it('documents exactly why each RULES_WITHOUT_CWE entry has no CWE mapping', () => {
    // UNAPPROVED_DOMAIN is the sole entry: docs/scanner/policy-inventory.md's `[^domain]`
    // footnote rejects CWE-918 (SSRF) as inaccurate for this rule (it fires on any
    // non-allowlisted URL, including one the workflow author hardcoded with no external
    // input involved) and reserves CWE-918 for TAINTED_REQUEST_URL instead.
    expect(RULES_WITHOUT_CWE).toEqual(['UNAPPROVED_DOMAIN']);
  });

  it('gives both agentic rules a non-empty OWASP Agentic mapping', () => {
    for (const policyId of AGENTIC_POLICY_IDS) {
      const rule = betaHardenedRuleCatalog.find((entry) => entry.policyId === policyId);
      expect(rule, `${policyId} is missing from the hardened catalog`).toBeDefined();
      expect(rule?.owaspAgenticIds?.length, `${policyId} has no OWASP Agentic mapping`).toBeGreaterThan(0);
      for (const owaspId of rule?.owaspAgenticIds ?? []) {
        expect(owaspId.length, `${policyId} has an empty OWASP Agentic entry`).toBeGreaterThan(0);
      }
    }
  });

  it('does not give non-agentic rules an OWASP Agentic mapping', () => {
    for (const rule of betaHardenedRuleCatalog) {
      if (AGENTIC_POLICY_IDS.includes(rule.policyId)) continue;
      expect(rule.owaspAgenticIds, `${rule.policyId} unexpectedly declares an OWASP Agentic mapping`).toBeUndefined();
    }
  });
});
