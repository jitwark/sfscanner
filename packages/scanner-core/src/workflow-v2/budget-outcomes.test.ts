import { describe, expect, it } from 'vitest';
import {
  BUDGET_KEYS_V2,
  classifyBudgetOutcome,
  diagnosticCapacity,
  type BudgetKeyV2,
} from './budget-outcomes';

const shapeBudgets: BudgetKeyV2[] = [
  'maxSyntaxNodes', 'maxDocumentDepth', 'maxMembersAndElements', 'maxNodes', 'maxSourceWork',
  'maxRawEdges', 'maxEdges', 'maxConnectionDepth', 'maxParameterDepth',
  'maxParameterLeaves', 'maxDuplicateKeys', 'maxSerializedResultBytes',
];
const capabilityBudgets: BudgetKeyV2[] = [
  'maxExpressionTokens', 'maxCodeSyntaxNodes', 'maxTaintStates',
  'maxTraceStepsPerFinding', 'maxFindings', 'maxEvidenceBytes', 'maxRuleOperations',
];

describe('classifyBudgetOutcome', () => {
  it('covers every ScannerLimitsV2 budget exactly once', () => {
    expect(new Set(BUDGET_KEYS_V2).size).toBe(BUDGET_KEYS_V2.length);
    expect(BUDGET_KEYS_V2).toHaveLength(26);
  });

  it('maps byte and source/normalization/serialization exhaustion to item errors', () => {
    expect(classifyBudgetOutcome({ budget: 'maxBytes' })).toMatchObject({ kind: 'ITEM_ERROR', code: 'WORKFLOW_TOO_LARGE' });
    for (const budget of shapeBudgets) {
      expect(classifyBudgetOutcome({ budget })).toMatchObject({ kind: 'ITEM_ERROR', code: 'WORKFLOW_TOO_COMPLEX' });
    }
  });

  it('reserves exactly one diagnostic slot when the diagnostic budget exhausts', () => {
    expect(classifyBudgetOutcome({ budget: 'maxDiagnostics' })).toEqual({
      kind: 'DIAGNOSTIC', code: 'REQUIRED_LIMIT_EXCEEDED', aggregateEffect: 'INDETERMINATE',
      assessmentEligible: false, reservedDiagnosticSlots: 1,
    });
    expect(diagnosticCapacity(1)).toBe(0);
    expect(diagnosticCapacity(10)).toBe(9);
  });

  it('distinguishes optional presentation spans from security-required spans', () => {
    expect(classifyBudgetOutcome({ budget: 'maxStoredSourceSpans' })).toMatchObject({
      kind: 'DIAGNOSTIC', code: 'OPTIONAL_LIMIT_EXCEEDED', aggregateEffect: 'DEGRADED', assessmentEligible: true,
    });
    expect(classifyBudgetOutcome({ budget: 'maxStoredSourceSpans', securityRequired: true })).toMatchObject({
      kind: 'DIAGNOSTIC', code: 'REQUIRED_LIMIT_EXCEEDED', aggregateEffect: 'INDETERMINATE', assessmentEligible: false,
    });
  });

  it('reduces capability budgets from fixed requiredness', () => {
    for (const budget of capabilityBudgets) {
      expect(classifyBudgetOutcome({ budget, capabilityRequired: false })).toMatchObject({
        code: 'OPTIONAL_LIMIT_EXCEEDED', aggregateEffect: 'DEGRADED', assessmentEligible: true,
      });
      expect(classifyBudgetOutcome({ budget, capabilityRequired: true })).toMatchObject({
        code: 'REQUIRED_LIMIT_EXCEEDED', aggregateEffect: 'INDETERMINATE', assessmentEligible: false,
      });
    }
  });

  it('keeps graph, redaction, and host-only outcomes distinct', () => {
    expect(classifyBudgetOutcome({ budget: 'maxGraphOperations', capabilityRequired: false })).toMatchObject({
      kind: 'DIAGNOSTIC', code: 'GRAPH_WORK_LIMIT_EXCEEDED', aggregateEffect: 'DEGRADED', assessmentEligible: true,
    });
    expect(classifyBudgetOutcome({ budget: 'maxGraphOperations', capabilityRequired: true })).toMatchObject({
      kind: 'DIAGNOSTIC', code: 'GRAPH_WORK_LIMIT_EXCEEDED', aggregateEffect: 'INDETERMINATE', assessmentEligible: false,
    });
    for (const budget of ['maxRedactionPatches', 'maxRedactedArtifactBytes'] as const) {
      expect(classifyBudgetOutcome({ budget })).toEqual({ kind: 'REDACTION_ERROR', code: 'REDACTION_LIMIT_EXCEEDED' });
    }
    expect(classifyBudgetOutcome({ budget: 'workerDeadlineMs' })).toEqual({ kind: 'HOST_ERROR', code: 'SCAN_TIMEOUT' });
  });

  it('returns frozen outcomes and rejects missing requiredness', () => {
    const outcome = classifyBudgetOutcome({ budget: 'maxFindings', capabilityRequired: true });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(() => classifyBudgetOutcome({ budget: 'maxFindings' })).toThrow(TypeError);
    expect(() => classifyBudgetOutcome({ budget: 'unknown' as BudgetKeyV2 })).toThrow(TypeError);
    expect(() => diagnosticCapacity(0)).toThrow(TypeError);
  });
});
