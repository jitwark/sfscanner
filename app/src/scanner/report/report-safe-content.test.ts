import { describe, expect, it } from 'vitest';
import type { ScanWorkflowResult } from '../engine';
import type { CanonicalScanFinding } from '@hub/scanner-core/policy';
import {
  MAX_EVIDENCE_ENTRIES,
  MAX_REPORT_TEXT_CHARS,
  MAX_REMEDIATION_ACTIONS,
  evidenceEntries,
  remediationActions,
  remediationSteps,
  safeReportText,
} from './report-safe-content';

const finding: CanonicalScanFinding = {
  policyId: 'TEST', title: 'Test finding', severity: 'HIGH', location: {},
  evidence: {}, message: 'Message', explanation: 'Explanation', whyItMatters: 'Why',
  possibleImpact: 'Impact', remediation: 'Fix', remediationSteps: ['Fix one', 'Fix one', 'Fix two'],
  confidence: 'HIGH', policyEffect: 'LEGACY_SCORE',
};

describe('report-safe-content', () => {
  it('redacts and clips report text', () => {
    const value = `Token sk_live_abc123456789 ${'x'.repeat(500)}`;

    const safe = safeReportText(value);

    expect(safe).toContain('[REDACTED]');
    expect(safe).not.toContain('sk_live_abc123456789');
    expect(safe.length).toBe(MAX_REPORT_TEXT_CHARS);
  });

  it('sorts bounded evidence and omits source or secret values', () => {
    const entries = evidenceEntries({
      sourceCode: 'const secret = "do-not-render";',
      workflowJson: '{"nodes":[{"parameters":{"token":"do-not-render"}}]}',
      codeSnippet: ['fetch', '("https://do-not-render.example")'].join(''),
      script: ['process', '.', 'env.SECRET'].join(''),
      expression: '={{ $json.secret }}',
      token: 'sk_live_abc123456789',
      parameterPath: 'headers.authorization',
      indicator: 'EVAL',
      nodeType: 'x'.repeat(500),
      extraOne: true,
      extraTwo: false,
      extraThree: null,
      extraFour: 4,
      extraFive: 5,
      extraSix: 6,
    });

    expect(entries.length).toBeLessThanOrEqual(MAX_EVIDENCE_ENTRIES);
    expect(entries.map((entry) => entry.label)).toEqual([...entries.map((entry) => entry.label)].sort());
    expect(entries.map((entry) => entry.label)).not.toContain('Source Code');
    expect(entries.map((entry) => entry.label)).not.toContain('Workflow Json');
    expect(entries.map((entry) => entry.label)).not.toContain('Code Snippet');
    expect(entries.map((entry) => entry.label)).not.toContain('Script');
    expect(entries.map((entry) => entry.label)).not.toContain('Expression');
    expect(entries.map((entry) => entry.value).join(' ')).not.toContain('sk_live_abc123456789');
    expect(entries.find((entry) => entry.label === 'Node Type')?.value.length).toBe(MAX_REPORT_TEXT_CHARS);
  });

  it('deduplicates and bounds remediation steps and actions', () => {
    const steps = remediationSteps(finding);
    const scan = {
      findings: [finding],
      humanSummary: { recommendedActions: Array.from({ length: 10 }, (_, index) => `Action ${index}`) },
    } as unknown as ScanWorkflowResult;

    expect(steps).toEqual(['Fix one', 'Fix two']);
    expect(remediationActions(scan)).toHaveLength(MAX_REMEDIATION_ACTIONS);
  });
});
