import { describe, expect, it } from 'vitest';
import { ADMITTED_LIMIT_STATES, DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { BUDGET_KEYS_V2 } from '../workflow-v2/budget-outcomes';
import { scanWorkflowV2, type ScanWorkflowV2Result } from './index';

const encoder = new TextEncoder();
const PROFILE = { id: 'beta-default', version: '2.0.0' } as const;
const EMPTY = '{"nodes":[],"connections":{}}';
const TWO_NODES = '{"nodes":[{"id":"start","name":"Start","type":"n8n-nodes-base.manualTrigger","typeVersion":1,"parameters":{}},{"id":"finish","name":"Finish","type":"n8n-nodes-base.noOp","typeVersion":1,"parameters":{}}],"connections":{"Start":{"main":[[{"node":"Finish","type":"main","index":0}]]}}}';
const row = (result: ScanWorkflowV2Result, id: string) => {
  if (!result.ok) throw new Error(result.message);
  return result.result.limits.usage.find((entry) => entry.id === id);
};

const EXPECTED_ROWS = [
  'maxBytes', 'maxConnectionDepth', 'maxDiagnostics', 'maxDuplicateKeys', 'maxEdges',
  'maxFindings', 'maxNodes', 'maxParameterDepth', 'maxParameterLeaves', 'maxRawEdges',
  'maxSourceWork', 'maxStoredSourceSpans', 'maxSyntaxNodes',
] as const;
const NO_ROW = [
  'maxCodeSyntaxNodes', 'maxEvidenceBytes', 'maxExpressionTokens', 'maxGraphOperations',
  'maxRedactedArtifactBytes', 'maxRedactionPatches', 'maxRuleOperations',
  'maxSerializedResultBytes', 'maxTaintStates', 'maxTraceStepsPerFinding',
  'workerDeadlineMs', 'maxDocumentDepth', 'maxMembersAndElements',
] as const;

describe('limit state authority', () => {
  it('classifies every advertised limit exactly once', () => {
    expect(Object.keys(ADMITTED_LIMIT_STATES).sort()).toEqual([...BUDGET_KEYS_V2].sort());
    for (const id of BUDGET_KEYS_V2) {
      expect(['WIRED', 'DORMANT', 'UNWIRED'], id).toContain(ADMITTED_LIMIT_STATES[id]);
    }
    expect(ADMITTED_LIMIT_STATES.maxBytes).toBe('WIRED');
    expect(ADMITTED_LIMIT_STATES.workerDeadlineMs).toBe('WIRED');
    expect(ADMITTED_LIMIT_STATES.maxGraphOperations).toBe('WIRED');
    expect(ADMITTED_LIMIT_STATES.maxRedactionPatches).toBe('UNWIRED');
    expect(Object.values(ADMITTED_LIMIT_STATES).filter((state) => state === 'WIRED')).toHaveLength(22);
    expect(Object.values(ADMITTED_LIMIT_STATES).filter((state) => state === 'DORMANT')).toHaveLength(2);
    expect(Object.values(ADMITTED_LIMIT_STATES).filter((state) => state === 'UNWIRED')).toHaveLength(2);
  });

  it('emits rows only for measured budgets and reports real counters', () => {
    const bytes = encoder.encode(EMPTY);
    const result = scanWorkflowV2({ bytes, profile: PROFILE });
    if (!result.ok) throw new Error(result.message);
    expect(result.result.limits.usage.map(({ id }) => id).sort()).toEqual([...EXPECTED_ROWS].sort());
    for (const id of NO_ROW) expect(row(result, id), id).toBeUndefined();
    expect(row(result, 'maxBytes')?.examined).toBe(bytes.length);
    expect(row(result, 'maxNodes')?.examined).toBe(0);
    expect(row(result, 'maxDiagnostics')?.examined).toBe(0);
    expect(row(result, 'maxFindings')?.examined).toBe(0);
    expect(row(result, 'maxConnectionDepth')?.maximum).toBe(64);
    expect(row(result, 'maxStoredSourceSpans')?.maximum).toBe(DEFAULT_SCANNER_LIMITS_V2.maxStoredSourceSpans);

    const twoNodes = encoder.encode(TWO_NODES);
    const counted = scanWorkflowV2({ bytes: twoNodes, profile: PROFILE });
    expect(row(counted, 'maxBytes')?.examined).toBe(twoNodes.length);
    expect(row(counted, 'maxNodes')?.examined).toBe(2);
  });

  it('keeps a zero graph budget from appearing as an enforced maximum', () => {
    const result = scanWorkflowV2({ bytes: encoder.encode(EMPTY), profile: PROFILE, limits: { maxGraphOperations: 0 } });
    expect(row(result, 'maxGraphOperations')).toBeUndefined();
    if (!result.ok) return;
    expect(result.result.analysis.status).toBe('COMPLETE');
  });
});
