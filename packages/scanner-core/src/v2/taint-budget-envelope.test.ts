import { describe, expect, it } from 'vitest';
import { validateTargetContextV3 } from '../semantics/target-context';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import {
  chargeGraphOperation,
  createGraphOperationBudget,
  normalizeGraphOperationBudget,
  type GraphOperationBudgetV2,
} from '../analyzers/graph-v2/budget';
import { createConfidentialityState, createIntegrityState } from '../analyzers/taint-v2/labels';
import type { MaterializationStep } from '../analyzers/taint-v2/trace-helpers';
import { materializeTraceV2, type MaterializeTraceInputV2 } from '../analyzers/taint-v2/traces';
import type { TaintTraceStepV2 } from '../analyzers/taint-v2/transfer';
import { runTaintWorklistV2, type TaintFactV2, type TaintWorklistInputV2, type TaintWorklistResultV2 } from '../analyzers/taint-v2/worklist';
import { createDiagnostic } from '../capabilities/adapter-evidence';
import type { SubjectV2 } from '../capabilities/scheduler';
import { composeScannerResultV2, type ComposeScannerResultV2Input } from '../result-v2/compose-result';
import type { IdentityContextV2 } from '../result-v2/identities';
import type { ResolvedNodeSemanticsV2 } from '../semantics/catalogue-schema';
import { createNodeIdentityDigest } from '../workflow-v2/node-edge-identity';
import type { SecurityWorkflowV2 } from '../workflow-v2/security-workflow';
import { scanWorkflowV2 } from './scan-workflow';

/**
 * Packet B3 (P2 row SC-07). The allegation under test is the envelope, not the inner loops: the v2
 * taint solver charges graph work in `transfer.ts`, `traces.ts` and the `graph-v2` analyzers, but
 * `v2/scan-workflow.ts` used to report the top-level `maxGraphOperations` usage as a literal zero.
 * These
 * tests pin what each final result reports, at the boundary and under saturation, and record what
 * the scan reports while the run schedules real capability work.
 *
 * The shipped `maxGraphOperations` limit is `1_000_000`, which no fixture can reach (a transfer
 * charges 3 operations at best per node, and `maxNodes` is far smaller). The boundary is therefore
 * driven with test-local budgets — `{ maxGraphOperations }` limits objects normalized through the
 * same production path the analyzers accept (`normalizeGraphOperationBudget`) — through the existing
 * injection point: `TaintGraphOutputV2.usage` on the worklist result and `graphBudget` on the trace
 * result. Every budget value asserted here is the test-local one; no production limit was changed.
 */

const encoder = new TextEncoder();
const PROFILE = { id: 'beta-default', version: '2.0.0' } as const;

/** The limits-shaped budget input the analyzers accept, built from a test-local limit value. */
const limitsBudget = (maxGraphOperations: number): GraphOperationBudgetV2 => normalizeGraphOperationBudget({ maxGraphOperations });

const semantics = (nodeType: string, overrides: Partial<ResolvedNodeSemanticsV2> = {}): ResolvedNodeSemanticsV2 => ({
  semanticId: nodeType, nodeType, versionRange: { clauses: [] }, operation: null, entry: 'NONE', parameterPaths: [], authentication: null,
  credentialPaths: [], destinationPaths: [], effects: [], endpoints: [], ports: [], overwritePaths: [], errorMode: 'STOP', retryMode: 'NONE', disabledMode: 'SKIP',
  provenance: { sourceUrl: 'fixture', sourceDigest: 'a'.repeat(64), reviewedAt: '2026-10-17', reviewer: 'test' }, ...overrides,
});

type EdgeSpec = Readonly<{ from: number; to: number; resolution?: 'RESOLVED' | 'UNRESOLVED' }>;
const graph = (count: number, edges: readonly EdgeSpec[]): SecurityWorkflowV2 => ({
  workflowFields: [],
  nodes: Array.from({ length: count }, (_, ordinal) => ({ ref: { ordinal, identityDigest: `node-${ordinal}` }, type: 'test', disabled: false, scoringEligibility: 'ELIGIBLE', parameters: [], credentials: [], settings: [] })),
  edges: edges.map((edge, ordinal) => ({
    ordinal, sourceNode: { ordinal: edge.from }, targetNode: { ordinal: edge.to }, sourceLabel: 'out', targetLabel: 'in',
    connectionType: 'main', sourcePort: 0, targetPort: 0,
    source: { pointer: `/edges/${ordinal}`, occurrencePath: [ordinal], astNodeId: 'a'.repeat(64), span: null },
    resolution: edge.resolution ?? 'RESOLVED',
  })),
  ambiguities: [],
} as unknown as SecurityWorkflowV2);

type SolverFixture = Readonly<{
  workflow: SecurityWorkflowV2;
  semantics: ReadonlyMap<string, ResolvedNodeSemanticsV2>;
  reachable: readonly number[];
  seeds?: readonly TaintFactV2[];
}>;

const sourceEndpoint = { path: '/body', channel: 'DATA', direction: 'SOURCE', taint: 'CONFIDENTIALITY' } as const;
const sinkEndpoint = { path: '/value', channel: 'DATA', direction: 'SINK', taint: 'CONFIDENTIALITY' } as const;
const sanitizerEndpoint = { path: '/value', channel: 'DATA', direction: 'SANITIZER', taint: 'CONFIDENTIALITY' } as const;

/** One node, one SOURCE endpoint: transferNodeV2 charges exactly three graph operations for it. */
const oneSource = (): SolverFixture => ({
  workflow: graph(1, []),
  semantics: new Map([['node-0', semantics('test', { entry: 'TRIGGER', endpoints: [sourceEndpoint] })]]),
  reachable: [0],
});

const seed = (field: string, port: number, item: number): TaintFactV2 => ({
  key: { node: 0, field, port, item },
  confidentiality: createConfidentialityState(['WEBHOOK_BODY']),
  integrity: createIntegrityState([]),
  trace: [],
});

/** A cycle, saturated facts and endpoints, an out-of-range target and an unresolved predecessor edge. */
const saturated = (): SolverFixture => ({
  workflow: graph(2, [{ from: 0, to: 1 }, { from: 1, to: 0 }, { from: 0, to: 99 }, { from: 1, to: 0, resolution: 'UNRESOLVED' }]),
  semantics: new Map([
    ['node-0', semantics('test', { entry: 'TRIGGER', overwritePaths: ['/value'], endpoints: [sourceEndpoint, sinkEndpoint, sanitizerEndpoint, { path: '/value', channel: 'DATA', direction: 'SINK', taint: 'INTEGRITY' }] })],
    ['node-1', semantics('test', { endpoints: [sinkEndpoint] })],
  ]),
  reachable: [0, 1],
  seeds: [seed('/value', 0, 0), seed('/body', 0, 1), seed('/other', 0, 0), seed('/value', 1, 0)],
});

const solverRun = (fixture: SolverFixture, graphBudget: GraphOperationBudgetV2): TaintWorklistResultV2 => runTaintWorklistV2({
  workflow: fixture.workflow,
  semantics: fixture.semantics,
  maxTaintStates: 1_000_000,
  ...(fixture.seeds === undefined ? {} : { seeds: fixture.seeds }),
  graph: { status: 'COMPLETE', reachable: [...fixture.reachable], usage: graphBudget },
} satisfies TaintWorklistInputV2);

const context: IdentityContextV2 = { semanticSha256: 'e'.repeat(64) };
const nodeSubject = (ordinal: number): SubjectV2 => {
  const source = {
    pointer: `/nodes/${ordinal}`, occurrencePath: [ordinal], astNodeId: '0123456789abcdef'[(ordinal + 1) % 16]!.repeat(64),
    span: { start: { line: 1, column: ordinal + 1, utf16Offset: ordinal, utf8ByteOffset: ordinal }, end: { line: 1, column: ordinal + 2, utf16Offset: ordinal + 1, utf8ByteOffset: ordinal + 1 } },
  };
  return { kind: 'NODE', node: { ordinal, source, identityDigest: createNodeIdentityDigest(ordinal, source) } };
};
const step = (kind: TaintTraceStepV2['kind'], nodeOrdinal: number, predecessor?: number): MaterializationStep => ({
  kind, node: nodeOrdinal, field: '/value', port: 0, item: 0,
  ...(predecessor === undefined ? {} : { predecessor: { node: predecessor, edge: predecessor, field: '/value', item: 0 } }),
});
const traceInput = (steps: readonly MaterializationStep[], overrides: Partial<MaterializeTraceInputV2> = {}): MaterializeTraceInputV2 => ({
  kind: 'CONFIDENTIALITY', steps, context,
  subjects: new Map(Array.from({ length: Math.max(1, ...steps.map((item) => item.node + 1)) }, (_, ordinal) => [ordinal, nodeSubject(ordinal)])),
  limits: { maxTraceStepsPerFinding: 100, maxEvidenceBytes: 100_000 }, ...overrides,
});

describe('v2 taint solver graph-budget boundary', () => {
  it('schedules exactly three graph operations on the one-source fixture and saturates at maximum', () => {
    // The fixture's schedule is fixed by the transfer contract: one endpoint scan, one fact scan and
    // one fact-size charge. Mutation caught: a dropped or added charge in transferNodeV2 changes
    // `used`; an exclusive boundary (exhausting at used === maximum) flips `exhausted`.
    const result = solverRun(oneSource(), limitsBudget(3));
    expect(result.status).toBe('COMPLETE');
    expect(result.graphUsage).toEqual({ maximum: 3, used: 3, omitted: 0, exhausted: false });
    expect(result.usage).toEqual({ maximum: 1_000_000, used: 5, omitted: 0, exhausted: false });
    expect(result.facts).toHaveLength(1);
    expect(result.traces).toHaveLength(1);
  });

  it('exhausts at maximum minus one and keeps the overcharge visible', () => {
    // Mutation caught: clamping `used` to `maximum` on the failing charge would report used 2 /
    // omitted 0; swallowing the failure would report a COMPLETE result with facts.
    const result = solverRun(oneSource(), limitsBudget(2));
    expect(result.status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(result.graphUsage).toEqual({ maximum: 2, used: 3, omitted: 1, exhausted: true });
    expect(result.facts).toEqual([]);
    expect(result.traces).toEqual([]);
    expect(result.omitted).toBe(1);
  });

  it('leaves one spare operation unspent when the budget is one above the schedule', () => {
    // Mutation caught: reporting `exhausted`/`omitted` from a stale counter rather than the final one.
    const result = solverRun(oneSource(), limitsBudget(4));
    expect(result.status).toBe('COMPLETE');
    expect(result.graphUsage).toEqual({ maximum: 4, used: 3, omitted: 0, exhausted: false });
  });

  it('reports zero scheduled operations when the input schedules none', () => {
    // Mutation caught: pre-charging the graph budget before any transfer runs (the counters would
    // read used > 0 here) or omitting `graphUsage` from a result that was handed a budget.
    const idle: SolverFixture = { workflow: graph(1, []), semantics: new Map([['node-0', semantics('test')]]), reachable: [0] };
    const result = solverRun(idle, limitsBudget(3));
    expect(result.status).toBe('COMPLETE');
    expect(result.graphUsage).toEqual({ maximum: 3, used: 0, omitted: 0, exhausted: false });
    expect(result.usage.used).toBe(0);
    expect(result.facts).toEqual([]);
  });

  it('exhausts a zero-capacity budget on the first scheduled operation', () => {
    // Mutation caught: treating maximum 0 as "unbounded" (the run would report COMPLETE and publish
    // the source fact).
    const result = solverRun(oneSource(), limitsBudget(0));
    expect(result.status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(result.graphUsage).toEqual({ maximum: 0, used: 1, omitted: 1, exhausted: true });
    expect(result.facts).toEqual([]);
  });
});

describe('v2 taint solver saturation', () => {
  it('terminates a saturated cyclic fixture at a fixed point with counters that add up', () => {
    // Mutation caught: losing the merge/fixed-point guard makes the 0 <-> 1 cycle grow without end
    // or changes the fact set; a dropped or extra charge changes the pinned `used` values.
    const result = solverRun(saturated(), limitsBudget(100_000));
    expect(result.status).toBe('COMPLETE');
    expect(result.facts).toHaveLength(9);
    expect(result.traces).toHaveLength(5);
    expect(result.graphUsage).toEqual({ maximum: 100_000, used: 101, omitted: 0, exhausted: false });
    expect(result.usage).toEqual({ maximum: 1_000_000, used: 58, omitted: 0, exhausted: false });
  });

  it('stops a saturated run at the graph budget without publishing partial facts', () => {
    // Mutation caught: publishing the facts transferred before exhaustion, or continuing to charge
    // after the counter is exhausted (used would climb past maximum + the failing charge).
    const result = solverRun(saturated(), limitsBudget(5));
    expect(result.status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(result.graphUsage).toEqual({ maximum: 5, used: 6, omitted: 1, exhausted: true });
    expect(result.facts).toEqual([]);
    expect(result.traces).toEqual([]);
    expect(result.omitted).toBeGreaterThanOrEqual(1);
  });

  it('terminates a cyclic trace with a malformed predecessor and stays bounded', () => {
    // Mutation caught: dropping the `activeStates` guard in predecessorPath makes the cycle recurse
    // without end (or the malformed predecessor resolve to an unrelated candidate); a charge that
    // skips the exhausted check would overshoot `maximum + 1` operations.
    const steps = [step('SOURCE', 0), step('SINK', 1, 0), step('SINK', 2, 1), step('SINK', 3, 99)];
    const generous = materializeTraceV2(traceInput(steps, { graphBudget: limitsBudget(10_000) }));
    expect(generous.status).toBe('COMPLETE');
    expect(generous.trace?.steps.length).toBe(2);
    expect(generous.graphUsage?.exhausted).toBe(false);
    expect(generous.graphUsage?.omitted).toBe(0);

    const tight = materializeTraceV2(traceInput(steps, { graphBudget: limitsBudget(3) }));
    expect(tight.status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(tight.trace).toBeNull();
    expect(tight.graphUsage?.exhausted).toBe(true);
    expect(tight.graphUsage?.omitted).toBe(Math.max(0, (tight.graphUsage?.used ?? 0) - (tight.graphUsage?.maximum ?? 0)));
    expect(tight.omitted).toBeGreaterThanOrEqual(1);
  });
});

describe('v2 taint solver no-bypass', () => {
  it('refuses a clean result from an already exhausted counter without resetting it', () => {
    // Mutation caught: a stage that rebuilds the counter from `maximum` (a silent reset) reports
    // used 0 / exhausted false and a COMPLETE result with facts.
    const exhausted = chargeGraphOperation(createGraphOperationBudget(0)).counter;
    expect(exhausted).toEqual({ maximum: 0, used: 1, omitted: 1, exhausted: true });
    const result = solverRun(oneSource(), exhausted);
    expect(result.status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(result.graphUsage).toEqual(exhausted);
    expect(result.facts).toEqual([]);
    expect(result.traces).toEqual([]);
    expect(result.omitted).toBe(1);
  });

  it('hands the exhausted counter to the later trace stage without resetting it or publishing a trace', () => {
    // The control proves the same input is otherwise complete, so only the exhausted counter is
    // refusing it. Mutation caught: a later stage that ignores `exhausted` (or resets `used`) would
    // publish a trace and report used 0.
    const worklist = solverRun(oneSource(), limitsBudget(0));
    const usage = worklist.graphUsage;
    expect(usage).toEqual({ maximum: 0, used: 1, omitted: 1, exhausted: true });
    if (usage === undefined) return;
    const control = materializeTraceV2(traceInput([step('SOURCE', 0)]));
    expect(control.status).toBe('COMPLETE');
    expect(control.trace).not.toBeNull();

    const refused = materializeTraceV2(traceInput([step('SOURCE', 0)], { graphBudget: usage }));
    expect(refused.status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(refused.trace).toBeNull();
    expect(refused.graphUsage).toEqual(usage);
    expect(refused.omitted).toBeGreaterThanOrEqual(1);
  });
});

describe('v2 graph-budget outcome split', () => {
  it('withholds the assessment when a required capability exhausts graph work', () => {
    // The counters record no unperformed units, so the GRAPH_WORK_LIMIT_EXCEEDED diagnostic is the
    // only carrier of the INDETERMINATE outcome. Mutation caught: a fixed DEGRADED/eligible
    // classification, or a composer that publishes the assessment for an INDETERMINATE status.
    const diagnostic = createDiagnostic('GRAPH_WORK_LIMIT_EXCEEDED', 'graph-semantics', true);
    const composed = composeScannerResultV2({
      ...composableView(),
      analysis: {
        status: 'COMPLETE',
        capabilities: [{ id: 'graph-semantics', version: '2.0.0', required: true, status: 'COMPLETED', seen: 1, analyzed: 1, skipped: 0, omitted: 0, diagnosticIds: [diagnostic.id] }],
        diagnostics: [diagnostic],
      },
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.result.analysis.capabilities[0]).toMatchObject({ id: 'graph-semantics', seen: 1, analyzed: 1, skipped: 0, omitted: 0 });
    expect(composed.result.analysis.diagnostics.map(({ code, aggregateEffect, assessmentEligible }) => ({ code, aggregateEffect, assessmentEligible })))
      .toEqual([{ code: 'GRAPH_WORK_LIMIT_EXCEEDED', aggregateEffect: 'INDETERMINATE', assessmentEligible: false }]);
    expect(composed.result.analysis.status).toBe('INDETERMINATE');
    expect(composed.result.assessment).toBeNull();
  });

  it('declares an optional graph loss as a degraded omission while keeping the assessment', () => {
    // Mutation caught: swallowing the diagnostic for an optional capability (the status would read
    // COMPLETE), dropping the declared omission from the counters (UNRECORDED_OMISSION), or
    // degrading all the way to a withheld assessment.
    const diagnostic = createDiagnostic('GRAPH_WORK_LIMIT_EXCEEDED', 'graph-semantics', false, undefined, { observed: 2, maximum: 1, omitted: 1 });
    const composed = composeScannerResultV2({
      ...composableView(),
      analysis: {
        status: 'COMPLETE',
        capabilities: [{ id: 'graph-semantics', version: '2.0.0', required: false, status: 'DEGRADED', seen: 2, analyzed: 1, skipped: 0, omitted: 1, diagnosticIds: [diagnostic.id] }],
        diagnostics: [diagnostic],
      },
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.result.analysis.diagnostics.map(({ code, aggregateEffect, assessmentEligible, omitted }) => ({ code, aggregateEffect, assessmentEligible, omitted })))
      .toEqual([{ code: 'GRAPH_WORK_LIMIT_EXCEEDED', aggregateEffect: 'DEGRADED', assessmentEligible: true, omitted: 1 }]);
    expect(composed.result.analysis.capabilities[0]).toMatchObject({ id: 'graph-semantics', status: 'DEGRADED', omitted: 1 });
    expect(composed.result.analysis.capabilities[0]?.diagnosticIds).toEqual([diagnostic.id]);
    expect(composed.result.analysis.status).toBe('DEGRADED');
    expect(composed.result.assessment).not.toBeNull();
  });
});

describe('v2 scan envelope: top-level graph usage versus capability counters', () => {
  const TWO_NODES = '{"nodes":[{"id":"start","name":"Start","type":"n8n-nodes-base.manualTrigger","typeVersion":1,"parameters":{}},{"id":"finish","name":"Finish","type":"n8n-nodes-base.noOp","typeVersion":1,"parameters":{}}],"connections":{"Start":{"main":[[{"node":"Finish","type":"main","index":0}]]}}}';

  const scan = (maxGraphOperations: number) => {
    const result = scanWorkflowV2({ bytes: encoder.encode(TWO_NODES), profile: PROFILE, limits: { maxGraphOperations } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    return result.result;
  };

  it('reports actual shared graph refusal through capability counters without inventing a usage row', () => {
    // The public usage vocabulary still omits graph-operation telemetry. That does not make the
    // shared graph debit dormant: zero budget refuses nonempty preflight and withholds assessment.
    // The same workflow at the shipped limit pays for complete zero-flow coverage.
    const zeroBudget = scan(0);
    const shippedBudget = scan(DEFAULT_SCANNER_LIMITS_V2.maxGraphOperations);
    expect(zeroBudget.limits.usage.find(({ id }) => id === 'maxGraphOperations')).toBeUndefined();
    expect(shippedBudget.limits.usage.find(({ id }) => id === 'maxGraphOperations')).toBeUndefined();
    expect(zeroBudget.analysis.status).toBe('INDETERMINATE');
    expect(zeroBudget.assessment).toBeNull();
    expect(zeroBudget.analysis.capabilities.find(({ id }) => id === 'structural-policies'))
      .toMatchObject({ required: true, status: 'DEGRADED', seen: 2, analyzed: 2, skipped: 0, omitted: 1 });
    expect(zeroBudget.analysis.diagnostics).toHaveLength(1);
    expect(zeroBudget.analysis.diagnostics[0]).toMatchObject({ code: 'GRAPH_ANALYSIS_DEGRADED',
      capabilityId: 'structural-policies', omitted: 1 });
    expect(zeroBudget.facts.filter((fact) => fact.kind.startsWith('dataflow.'))).toEqual([]);
    expect(zeroBudget.stats.omittedFindings).toBe(0);
    expect(shippedBudget.analysis.status).toBe('COMPLETE');
    expect(shippedBudget.assessment).not.toBeNull();
    expect(shippedBudget.analysis.capabilities.find(({ id }) => id === 'structural-policies'))
      .toMatchObject({ status: 'COMPLETED', seen: 2, analyzed: 2, skipped: 0, omitted: 0 });
    expect(shippedBudget.analysis.diagnostics).toEqual([]);
    const coverage = shippedBudget.facts.filter((fact) => fact.kind === 'dataflow.coverage.v1');
    expect(coverage).toHaveLength(1);
    expect(coverage[0].properties).toMatchObject({ coverageStatus: 'COMPLETE', fieldsExamined: 0, emittedFlows: 0 });
  });
});

/** A minimal result the composer accepts, so the split is proven against the real composer. */
function composableView(): ComposeScannerResultV2Input {
  const digest = (letter: string): string => letter.repeat(64);
  return {
    engine: { id: 'secureflow-scanner', version: '2.0.0', buildDigest: digest('a') },
    input: { rawSha256: digest('b'), semanticSha256: digest('c'), ambiguitySha256: digest('d'), ambiguityCount: 0, utf8Bytes: 1 },
    profile: { id: 'beta-default', version: '2.0.0' },
    ruleset: { id: 'rules', version: '2.0.0', digest: digest('e'), signatureStatus: 'VERIFIED' },
    semantics: { id: 'semantics', version: '2.0.0', digest: digest('f') },
    target: validateTargetContextV3({ schemaVersion: 'scanner-target-v3' }),
    limits: { schemaVersion: 'scanner-limits-v2', digest: digest('1'), usage: [] },
    analysis: { status: 'COMPLETE', capabilities: [], diagnostics: [] },
    workflow: { name: null, nodeCount: 0, rawNodeCount: 0, annotationNodeCount: 0, triggerCount: 0, actionCount: 0, integrationCount: 0, edgeCount: 0, resolvedEdgeCount: 0, payloadBytes: 0, complexity: 'LOW', isSubWorkflow: false },
    facts: [], traces: [], findings: [],
    assessment: { score: 0, grade: 'LOW', scoringPolicyVersion: 'secureflow-risk-v2@2.0.0', basisFindingIds: [], excludedReportOnlyFindingIds: [], excludedUncertainFindingIds: [], excludedNotApplicableFindingIds: [], unknownEvidenceCount: 0 },
  };
}
