import { describe, expect, it } from 'vitest';
import type { ScanFinding } from '../policy/policy';
import { summarizeFindings } from './summary';

function finding(severity: ScanFinding['severity']): ScanFinding {
  return {
    policyId: 'POLICY',
    title: 'Title',
    severity,
    location: {},
    evidence: {},
    message: 'Message',
    explanation: 'Explanation',
    whyItMatters: 'Why',
    possibleImpact: 'Impact',
    remediation: 'Fix',
    remediationSteps: ['Fix'],
    confidence: 'HIGH',
  };
}

describe('summarizeFindings', () => {
  it('counts each severity into the ScanSummary shape', () => {
    expect(summarizeFindings([
      finding('CRITICAL'), finding('CRITICAL'), finding('HIGH'), finding('MEDIUM'),
      finding('LOW'), finding('INFO'), finding('INFO'),
    ])).toEqual({ critical: 2, high: 1, medium: 1, low: 1, info: 2 });
  });
});
