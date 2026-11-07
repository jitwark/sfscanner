import { chargeGraphOperation, createGraphOperationBudget } from '../graph-v2/budget';
import { describe, expect, it } from 'vitest';
import type { SafeFactV2, SubjectV2 } from '../../capabilities/scheduler';
import { createFactId, createTraceId, type IdentityContextV2 } from '../../result-v2/identities';
import { canonicalBytesV1 } from '../../result-v2/canonical-bytes';
import type { TaintTraceStepV2 } from './transfer';
import { createNodeIdentityDigest } from '../../workflow-v2/node-edge-identity';
import { materializeTraceV2, type MaterializeTraceInputV2 } from './traces';

const context: IdentityContextV2 = { semanticSha256: 'e'.repeat(64) };
const digest = (ordinal: number) => '0123456789abcdef'[ordinal % 16]!.repeat(64);
const position = (offset: number) => ({ line: 1, column: offset + 1, utf16Offset: offset, utf8ByteOffset: offset });
const source = (ordinal: number, span: boolean | 'invalid' = true) => ({
  pointer: `/nodes/${ordinal}`, occurrencePath: [ordinal], astNodeId: digest(ordinal + 1),
  span: span === false ? null : { start: position(ordinal), end: position(span === 'invalid' ? ordinal : ordinal + 1) },
});
const node = (ordinal: number, span: boolean | 'invalid' = true): SubjectV2 => {
  const nodeSource = source(ordinal, span);
  return { kind: 'NODE', node: { ordinal, source: nodeSource, identityDigest: createNodeIdentityDigest(ordinal, nodeSource) } };
};
const subjects = (count: number, span: boolean | 'invalid' = true) => new Map(Array.from({ length: count }, (_, ordinal) => [ordinal, node(ordinal, span)]));
const step = (kind: TaintTraceStepV2['kind'], nodeOrdinal: number, field = '/value', port = 0, item = 0): TaintTraceStepV2 => ({ kind, node: nodeOrdinal, field, port, item });
const input = (steps: readonly TaintTraceStepV2[], overrides: Partial<MaterializeTraceInputV2> = {}): MaterializeTraceInputV2 => ({
  kind: 'CONFIDENTIALITY', steps, context, subjects: subjects(Math.max(1, ...steps.map((item) => item.node + 1))),
  limits: { maxTraceStepsPerFinding: 100, maxEvidenceBytes: 100_000 }, ...overrides,
});
const fact = (subject: SubjectV2, properties: SafeFactV2['properties'] = {
  flowKind: 'TAINT_SINK', sink: 'COMMAND', propertyPathComplete: true, humanGatePresent: false,
  humanGateDominates: false, taintLabels: ['WEBHOOK_BODY'],
}): SafeFactV2 => {
  const value = { kind: 'dataflow.summary.v2', subject, properties } as const;
  return { ...value, factId: createFactId(value, context) };
};

describe('materializeTraceV2', () => {
  it('selects a stable shortest predecessor path at a branch', () => {
    const steps = [
      { ...step('SOURCE', 0), predecessor: undefined },
      { ...step('PROPAGATION', 1), predecessor: { node: 0, edge: 9, field: '/value', item: 0 } },
      { ...step('PROPAGATION', 1), predecessor: { node: 0, edge: 2, field: '/value', item: 0 } },
      { ...step('SINK', 2), predecessor: { node: 1, edge: 3, field: '/value', item: 0 } },
    ] as const;
    const result = materializeTraceV2(input(steps as unknown as readonly TaintTraceStepV2[]));
    expect(result.status).toBe('COMPLETE');
    expect(result.trace?.steps.map((item) => [item.ordinal, item.kind, item.subject.kind])).toEqual([
      [0, 'SOURCE', 'NODE'], [1, 'PROPAGATION', 'NODE'], [2, 'SINK', 'NODE'],
    ]);
  });

  it('materializes sanitizer and sink events with admitted fact references', () => {
    const nodeSubject = node(0);
    const evidence = fact(nodeSubject);
    const result = materializeTraceV2(input([
      step('SOURCE', 0), step('PROPAGATION', 0), step('SANITIZER', 0), step('SINK', 0),
    ], { facts: [evidence] }));
    expect(result.status).toBe('COMPLETE');
    expect(result.trace?.steps.map((item) => item.kind)).toEqual(['SOURCE', 'PROPAGATION', 'SANITIZER', 'SINK']);
    expect(result.trace?.steps.every((item) => item.factRefs).valueOf()).toBe(true);
    expect(result.trace?.steps.at(-1)?.factRefs).toEqual([evidence.factId]);
  });

  it('returns UNKNOWN without a trace when source spans are missing or unverified', () => {
    const result = materializeTraceV2(input([step('SOURCE', 0)], { subjects: subjects(1, false) }));
    expect(result).toEqual({ status: 'UNKNOWN', trace: null, omitted: 1 });
    const invalid = materializeTraceV2(input([step('SOURCE', 0)], { subjects: subjects(1, 'invalid') }));
    expect(invalid).toEqual({ status: 'UNKNOWN', trace: null, omitted: 1 });
  });

  it.each([
    [2, 'COMPLETE'], [3, 'COMPLETE'], [4, 'LIMIT_EXCEEDED'],
  ] as const)('enforces maxTraceStepsPerFinding inclusively at %s steps', (count, status) => {
    const result = materializeTraceV2(input(Array.from({ length: count }, (_, ordinal) => step(ordinal === 0 ? 'SOURCE' : ordinal === count - 1 ? 'SINK' : 'PROPAGATION', ordinal)), {
      subjects: subjects(count), limits: { maxTraceStepsPerFinding: 3, maxEvidenceBytes: 100_000 },
    }));
    expect(result.status).toBe(status);
    if (status === 'LIMIT_EXCEEDED') expect(result).toMatchObject({ trace: null, omitted: count });
  });

  it('enforces evidence bytes at max minus one, max, and max plus one', () => {
    const steps = [step('SOURCE', 0), step('SINK', 1)];
    const complete = materializeTraceV2(input(steps));
    expect(complete.trace).not.toBeNull();
    if (!complete.trace) return;
    const bytes = canonicalBytesV1(complete.trace).byteLength;
    expect(materializeTraceV2(input(steps, { limits: { maxTraceStepsPerFinding: 100, maxEvidenceBytes: bytes - 1 } })).status).toBe('LIMIT_EXCEEDED');
    expect(materializeTraceV2(input(steps, { limits: { maxTraceStepsPerFinding: 100, maxEvidenceBytes: bytes } })).status).toBe('COMPLETE');
    expect(materializeTraceV2(input(steps, { limits: { maxTraceStepsPerFinding: 100, maxEvidenceBytes: bytes + 1 } })).status).toBe('COMPLETE');
  });
  it('charges referenced admitted fact bytes exactly once', () => {
    const steps = [step('SOURCE', 0), step('SINK', 1)];
    const facts = [fact(node(0)), fact(node(1))];
    const complete = materializeTraceV2(input(steps, { facts }));
    expect(complete.trace).not.toBeNull();
    if (!complete.trace) return;
    const bytes = canonicalBytesV1(complete.trace).byteLength + facts.reduce((total, value) => total + canonicalBytesV1(value).byteLength, 0);
    expect(materializeTraceV2(input(steps, { facts, limits: { maxTraceStepsPerFinding: 100, maxEvidenceBytes: bytes - 1 } })).status).toBe('LIMIT_EXCEEDED');
    expect(materializeTraceV2(input(steps, { facts, limits: { maxTraceStepsPerFinding: 100, maxEvidenceBytes: bytes } })).status).toBe('COMPLETE');
  });

  it('keeps trace identity stable and output frozen', () => {
    const result = materializeTraceV2(input([step('SOURCE', 0), step('SINK', 1)]));
    expect(result.trace?.traceId).toBe(result.trace && createTraceId(result.trace, context));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.trace)).toBe(true);
    expect(Object.isFrozen(result.trace?.steps)).toBe(true);
  });

  it('returns UNKNOWN for missing subjects and does not fabricate identities', () => {
    const result = materializeTraceV2(input([step('SOURCE', 0)], { subjects: undefined }));
    expect(result.status).toBe('UNKNOWN');
    expect(result.trace).toBeNull();
    expect(JSON.stringify(result)).not.toContain('value');
  });

  it('rejects mismatched node identities and reversed verified spans', () => {
    const original = node(0);
    if (original.kind !== 'NODE' || original.node.source.span === null) return;
    const mismatched = { kind: 'NODE' as const, node: { ...original.node, identityDigest: 'f'.repeat(64) } };
    expect(materializeTraceV2(input([step('SOURCE', 0)], { subjects: new Map([[0, mismatched]]) })).status).toBe('UNKNOWN');
    const reversed = {
      kind: 'NODE' as const,
      node: {
        ...original.node,
        source: {
          ...original.node.source,
          span: {
            start: { ...original.node.source.span.start, line: 2 },
            end: { ...original.node.source.span.end, line: 1 },
          },
        },
      },
    };
    expect(materializeTraceV2(input([step('SOURCE', 0)], { subjects: new Map([[0, reversed]]) })).status).toBe('UNKNOWN');
  });

  it('does not require fact references on intermediate propagation or sanitizer steps', () => {
    const steps = [step('SOURCE', 0), step('PROPAGATION', 1), step('SANITIZER', 1), step('SINK', 2)];
    const result = materializeTraceV2(input(steps, { facts: [fact(node(0)), fact(node(2))] }));
    expect(result.status).toBe('COMPLETE');
    expect(result.trace?.steps.slice(1, 3).every((item) => item.factRefs.length === 0)).toBe(true);
  });

  it('emits no partial trace when the step budget is exhausted', () => {
    const result = materializeTraceV2(input([step('SOURCE', 0), step('PROPAGATION', 1), step('SINK', 2)], {
      limits: { maxTraceStepsPerFinding: 2, maxEvidenceBytes: 100_000 },
    }));
    expect(result).toEqual({ status: 'LIMIT_EXCEEDED', trace: null, omitted: 3 });
  });
  it('reports graph work exhaustion while exploring predecessor branches', () => {
    const steps = [
      step('SOURCE', 0),
      { ...step('PROPAGATION', 1), predecessor: { node: 0, edge: 0, field: '/value', item: 0 } },
      { ...step('PROPAGATION', 1), predecessor: { node: 0, edge: 1, field: '/value', item: 0 } },
      { ...step('PROPAGATION', 2), predecessor: { node: 1, edge: 2, field: '/value', item: 0 } },
      { ...step('PROPAGATION', 2), predecessor: { node: 1, edge: 3, field: '/value', item: 0 } },
      { ...step('SINK', 3), predecessor: { node: 2, edge: 4, field: '/value', item: 0 } },
    ] as const;
    const traceInput = Object.assign(input(steps as unknown as readonly TaintTraceStepV2[], {
      limits: { maxTraceStepsPerFinding: 100, maxEvidenceBytes: 100_000 },
    }), { graphBudget: { maxGraphOperations: 26 } });
    const result = materializeTraceV2(traceInput);
    expect(result.status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(result.graphUsage).toMatchObject({ maximum: 26, used: 28, exhausted: true });
    expect(result.trace).toBeNull();
  });
  it('reports an already exhausted graph budget', () => {
    const graphBudget = chargeGraphOperation(createGraphOperationBudget(0)).counter;
    const result = materializeTraceV2(input([step('SOURCE', 0)], { graphBudget }));
    expect(result.status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(result.graphUsage).toEqual(graphBudget);
  });
});
