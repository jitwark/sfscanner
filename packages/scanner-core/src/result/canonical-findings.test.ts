import { describe, expect, it } from 'vitest';
import type { RuleCatalogEntry } from '../policy/rule-catalog';
import type { ScanFinding } from '../policy/policy';
import { canonicalizeFindings } from './canonical-findings';

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

function finding(overrides: Partial<ScanFinding> = {}): ScanFinding {
  return {
    policyId: 'POLICY',
    title: 'Title',
    severity: 'HIGH',
    location: { nodeId: 'node-1', nodeName: 'Node', path: '/nodes/0' },
    evidence: { indicator: 'value' },
    message: 'Message',
    explanation: 'Explanation',
    whyItMatters: 'Why',
    possibleImpact: 'Impact',
    remediation: 'Fix',
    remediationSteps: ['Fix'],
    confidence: 'HIGH',
    ...overrides,
  };
}

describe('canonicalizeFindings', () => {
  it('collapses exact duplicates in first-occurrence order', () => {
    const second = finding({ policyId: 'SECOND' });
    const first = finding({ policyId: 'FIRST' });

    const result = canonicalizeFindings([second, first, second], catalog);

    expect(result.findings.map(({ policyId }) => policyId)).toEqual(['SECOND', 'FIRST']);
    expect(result.collapsedCount).toBe(1);
  });

  it('does not collapse findings whose node id is ambiguous', () => {
    const result = canonicalizeFindings(
      [finding({ location: { nodeId: 'duplicate' } }), finding({ location: { nodeId: 'duplicate' } })],
      catalog,
      { ambiguousNodeIds: new Set(['duplicate']) },
    );

    expect(result.findings).toHaveLength(2);
    expect(result.collapsedCount).toBe(0);
  });

  it('caps analyzer findings after duplicate collapse while retaining legacy findings', () => {
    const legacy = finding({ policyId: 'LEGACY' });
    const analyzerOne = finding({ policyId: 'ANALYZER_ONE', evidence: { index: 1 } });
    const analyzerTwo = finding({ policyId: 'ANALYZER_TWO', evidence: { index: 2 } });
    const analyzerThree = finding({ policyId: 'ANALYZER_THREE', evidence: { index: 3 } });

    const result = canonicalizeFindings(
      [legacy, analyzerOne, analyzerOne, analyzerTwo, analyzerThree],
      catalog,
      { legacyFindingCount: 1, maxAnalyzerFindings: 2 },
    );

    expect(result.findings.map(({ policyId }) => policyId)).toEqual([
      'LEGACY', 'ANALYZER_ONE', 'ANALYZER_TWO',
    ]);
    expect(result.collapsedCount).toBe(1);
  });

  it('stamps policy effects from the catalog and defaults unlisted policies', () => {
    const result = canonicalizeFindings([
      finding({ policyId: 'SCORED' }),
      { ...finding({ policyId: 'ADVISORY' }), policyEffect: 'LEGACY_SCORE' },
      finding({ policyId: 'UNLISTED' }),
    ], catalog);

    expect(result.findings.map(({ policyId, policyEffect }) => [policyId, policyEffect])).toEqual([
      ['SCORED', 'LEGACY_SCORE'],
      ['ADVISORY', 'REPORT_ONLY'],
      ['UNLISTED', 'LEGACY_SCORE'],
    ]);
  });

  it('redacts a canonical copy without using redacted values for duplicate keys', () => {
    const alpha = 'sk_live_alpha123456789';
    const bravo = 'sk_live_bravo123456789';
    const result = canonicalizeFindings([
      finding({ evidence: { token: alpha }, message: `Token ${alpha}` }),
      finding({ evidence: { token: bravo }, message: `Token ${bravo}` }),
    ], catalog);

    expect(result.findings).toHaveLength(2);
    expect(result.findings.every(({ evidence, message }) =>
      evidence.token === '[REDACTED]' && message === 'Token [REDACTED]')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(alpha);
    expect(JSON.stringify(result)).not.toContain(bravo);
  });

  it('rejects malformed and cyclic findings without throwing', () => {
    const cyclicEvidence: Record<string, unknown> = {};
    cyclicEvidence.self = cyclicEvidence;

    const result = canonicalizeFindings([
      finding({ policyId: 'VALID' }),
      { policyId: 'BROKEN', severity: 'HIGH' },
      finding({ policyId: 'CYCLIC', evidence: cyclicEvidence }),
    ], catalog);

    expect(result.findings.map(({ policyId }) => policyId)).toEqual(['VALID']);
    expect(result.rejectedCount).toBe(2);
  });
});
