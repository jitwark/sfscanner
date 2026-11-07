import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { canonicalizeFindings } from '@hub/scanner-core/result/canonical-findings';
import { scanWorkflow } from './engine';
import type { ScanFinding, ScanPolicy } from '@hub/scanner-core/policy';
import type { RuleCatalogEntry } from '@hub/scanner-core/rule-catalog';

const catalog: readonly RuleCatalogEntry[] = [];

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

const fieldDifferences: Array<[string, Partial<ScanFinding>]> = [
  ['policyId', { policyId: 'OTHER_POLICY' }],
  ['title', { title: 'Other title' }],
  ['severity', { severity: 'CRITICAL' }],
  ['location.nodeId', { location: { nodeId: 'other-node', nodeName: 'Node', path: '/nodes/0' } }],
  ['location.nodeName', { location: { nodeId: 'node-1', nodeName: 'Other', path: '/nodes/0' } }],
  ['location.path', { location: { nodeId: 'node-1', nodeName: 'Node', path: '/nodes/1' } }],
  ['location.sourceSpan', {
    location: {
      nodeId: 'node-1', nodeName: 'Node', path: '/nodes/0',
      sourceSpan: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 2, offset: 1 } },
    },
  }],
  ['evidence', { evidence: { indicator: 'other' } }],
  ['message', { message: 'Other message' }],
  ['explanation', { explanation: 'Other explanation' }],
  ['whyItMatters', { whyItMatters: 'Other why' }],
  ['possibleImpact', { possibleImpact: 'Other impact' }],
  ['remediation', { remediation: 'Other fix' }],
  ['remediationSteps', { remediationSteps: ['Other step'] }],
  ['confidence', { confidence: 'LOW' }],
];

describe('duplicate finding merging', () => {
  it('collapses exact duplicates and reports the collapse internally', () => {
    const result = canonicalizeFindings([finding(), finding()], catalog);

    expect(result.findings).toHaveLength(1);
    expect(result.collapsedCount).toBe(1);
  });

  it.each(fieldDifferences)('keeps findings differing in %s', (_field, difference) => {
    const result = canonicalizeFindings([finding(), finding(difference)], catalog);

    expect(result.findings).toHaveLength(2);
    expect(result.collapsedCount).toBe(0);
  });

  it('does not merge findings from different policies', () => {
    const result = canonicalizeFindings([finding(), finding({ policyId: 'OTHER_POLICY' })], catalog);

    expect(result.findings).toHaveLength(2);
    expect(result.collapsedCount).toBe(0);
  });

  it('preserves first occurrence order without sorting', () => {
    const first = finding({ policyId: 'FIRST' });
    const second = finding({ policyId: 'SECOND' });

    const result = canonicalizeFindings([second, first, second], catalog);

    expect(result.findings.map(({ policyId }) => policyId)).toEqual(['SECOND', 'FIRST']);
  });

  it('keys evidence before redaction so distinct secrets survive identical redaction', () => {
    const result = canonicalizeFindings([
      finding({ evidence: { token: 'sk_live_alpha123456789' } }),
      finding({ evidence: { token: 'sk_live_bravo123456789' } }),
    ], catalog);

    expect(result.findings).toHaveLength(2);
    expect(result.findings.map(({ evidence }) => evidence)).toEqual([
      { token: '[REDACTED]' },
      { token: '[REDACTED]' },
    ]);
    expect(JSON.stringify(result)).not.toContain('sk_live_alpha123456789');
    expect(JSON.stringify(result)).not.toContain('sk_live_bravo123456789');
  });

  it('merges before applying the analyzer cap so duplicates do not consume budget', () => {
    const unique = Array.from({ length: 101 }, (_, index) => finding({ evidence: { index } }));
    const result = canonicalizeFindings(
      [unique[0], unique[0], ...unique.slice(1)],
      catalog,
      { legacyFindingCount: 0, maxAnalyzerFindings: 100 },
    );

    expect(result.findings).toHaveLength(100);
    expect(result.findings.at(-1)?.evidence).toEqual({ index: 99 });
  });

  it('does not merge findings with an ambiguous node id', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: [
        { id: 'duplicate', name: 'Danger', type: 'n8n-nodes-base.executeCommand', parameters: { command: 'ls' } },
        { id: 'duplicate', name: 'Danger', type: 'n8n-nodes-base.executeCommand', parameters: { command: 'ls' } },
      ],
      connections: {},
    }));
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.workflow.parseDiagnostics).toContainEqual({ code: 'DUPLICATE_NODE_ID', nodeIndexes: [0, 1] });

    const policy: ScanPolicy = {
      id: 'DUPLICATE_NODE_POLICY', name: 'Duplicate node policy', description: 'test',
      evaluate: (workflow) => workflow.nodes.map((node) => finding({
        policyId: 'DUPLICATE_NODE_POLICY',
        location: { nodeId: node.id, nodeName: node.name },
      })),
    };
    const result = scanWorkflow(parsed.workflow, { policyFactory: () => [policy] });

    expect(result.findings.filter(({ policyId }) => policyId === policy.id)).toHaveLength(2);
    expect(result.analysisDiagnostics).not.toContainEqual({ code: 'DUPLICATE_FINDING_COLLAPSED', category: 'POLICY' });
  });

  it('reports a duplicate evaluator registration while keeping one finding', () => {
    const policy: ScanPolicy = {
      id: 'DUPLICATE_POLICY', name: 'Duplicate policy', description: 'test',
      evaluate: () => [finding({ policyId: 'DUPLICATE_POLICY' })],
    };
    const parsed = parseWorkflowJson(JSON.stringify({ nodes: [], connections: {} }));
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow, { policyFactory: () => [policy, policy] });

    expect(result.findings.filter(({ policyId }) => policyId === policy.id)).toHaveLength(1);
    expect(result.analysisDiagnostics).toContainEqual({ code: 'DUPLICATE_FINDING_COLLAPSED', category: 'POLICY' });
  });

  it('keeps truncated scans degraded rather than complete', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: Array.from({ length: 11 }, (_, index) => ({
        id: `code-${index}`, name: `Code ${index}`, type: 'n8n-nodes-base.code', typeVersion: 2,
        parameters: { language: 'javaScript', jsCode: 'eval(a);\n'.repeat(10) },
      })),
      connections: {},
    }));
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' });

    expect(result.analysisDiagnostics).toContainEqual({ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' });
    expect(result.analysisStatus).toBe('DEGRADED');
    expect(result.analysisStatus).not.toBe('COMPLETE');
  });
});
