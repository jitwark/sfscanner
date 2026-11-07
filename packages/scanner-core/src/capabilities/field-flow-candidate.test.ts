import { describe, expect, it } from 'vitest';
import type { CompileWorkflowFlowWitnessesInput } from '../analyzers/taint/scan-local-workflow-flow-witnesses';
import { createFieldFlowAccessorV1 } from '../analyzers/taint/scan-local-workflow-flow-witnesses';
import type { AnalyzerContextV2 } from './scheduler';
import { BETA_HARDENED_PROFILE_MANIFEST } from './profile-manifest';
import { fieldFlowCandidate } from './field-flow-candidate';

const input = {} as CompileWorkflowFlowWitnessesInput;

describe('field-flow accessor', () => {
  it('memoizes a detached fail-closed result for an invalid scan input', () => {
    const accessor = createFieldFlowAccessorV1(input);
    const first = accessor();
    expect(first).toMatchObject({ status: 'LIMITED', facts: [], traces: [] });
    expect(first.diagnostics).toHaveLength(1);
    expect(first.diagnostics[0]).toMatchObject({ code: 'GRAPH_ANALYSIS_DEGRADED', omitted: 1 });
    expect(accessor()).toBe(first);
    expect(Object.isFrozen(first.facts)).toBe(true);
    expect(Object.isFrozen(first.traces)).toBe(true);
    expect(Object.isFrozen(first.diagnostics)).toBe(true);
  });
});

describe('field-flow candidate dependency', () => {
  it('returns a counted degradation when no accessor was injected', () => {
    const capability = BETA_HARDENED_PROFILE_MANIFEST.capabilities.find((item) => item.id === 'taint-integrity')!;
    const context = { workflow: { nodes: [{}, {}] }, rules: { rules: new Map() } } as unknown as AnalyzerContextV2;
    const candidate = fieldFlowCandidate(context, capability);
    expect(candidate).toMatchObject({ facts: [], traces: [], seen: 2, analyzed: 2, skipped: 0, omitted: 1 });
    expect(candidate.diagnostics).toHaveLength(1);
    expect(candidate.diagnostics[0]).toMatchObject({ capabilityId: 'taint-integrity', code: 'DEPENDENCY_UNAVAILABLE' });
  });
});
