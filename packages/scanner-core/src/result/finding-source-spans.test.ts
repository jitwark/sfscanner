import { describe, expect, it } from 'vitest';
import type { CanonicalScanFinding } from '../policy/policy';
import type { NormalizedWorkflowNode, SourceSpan } from '../workflow';
import { attachFindingSourceSpans } from './finding-source-spans';

const span = (line: number): SourceSpan => ({
  start: { line, column: 1, offset: line * 10 },
  end: { line, column: 6, offset: line * 10 + 5 },
});

function node(id: string, sourceSpan?: SourceSpan): NormalizedWorkflowNode {
  return { id, name: id, type: 'n8n-nodes-base.noOp', parameters: {}, sourcePath: `/nodes/0`, ...(sourceSpan ? { sourceSpan } : {}) };
}

function finding(nodeId?: string): CanonicalScanFinding {
  return {
    policyId: 'POLICY',
    title: 'Title',
    severity: 'HIGH',
    location: { ...(nodeId === undefined ? {} : { nodeId, nodeName: nodeId }), path: '/nodes/0' },
    evidence: { indicator: 'value' },
    message: 'Message',
    explanation: 'Explanation',
    whyItMatters: 'Why',
    possibleImpact: 'Impact',
    remediation: 'Fix',
    remediationSteps: ['Fix'],
    confidence: 'HIGH',
    policyEffect: 'LEGACY_SCORE',
  };
}

describe('attachFindingSourceSpans', () => {
  it('attaches the single matching node span and counts nothing unresolved', () => {
    const result = attachFindingSourceSpans([finding('a')], [node('a', span(3)), node('b', span(4))]);

    expect(result.unresolvedCount).toBe(0);
    expect(result.findings[0]?.location.sourceSpan).toEqual(span(3));
  });

  it('leaves a finding for a duplicated node id unresolved', () => {
    const result = attachFindingSourceSpans([finding('dup')], [node('dup', span(3)), node('dup', span(4))]);

    expect(result.unresolvedCount).toBe(1);
    expect(result.findings[0]?.location.sourceSpan).toBeUndefined();
  });

  it('leaves a finding for an unknown or span-less node unresolved', () => {
    const result = attachFindingSourceSpans([finding('missing'), finding('bare')], [node('bare')]);

    expect(result.unresolvedCount).toBe(2);
    expect(result.findings.every((item) => item.location.sourceSpan === undefined)).toBe(true);
  });

  it('passes a finding with no node id through without counting it unresolved', () => {
    const result = attachFindingSourceSpans([finding()], [node('a', span(3))]);

    expect(result.unresolvedCount).toBe(0);
    expect(result.findings[0]?.location).toEqual({ path: '/nodes/0' });
  });

  it('does not mutate the input findings', () => {
    const input = finding('a');
    attachFindingSourceSpans([input], [node('a', span(3))]);

    expect(input.location.sourceSpan).toBeUndefined();
  });
});
