import { describe, expect, it } from 'vitest';
import { analyzeAgenticCapabilityV2 } from './agentic-capability';
import { analyzeInfluenceV2, type InfluenceInputV2 } from './influence';

const base = (): InfluenceInputV2 => ({
  sources: [
    { id: 'model', kind: 'MODEL', node: 1, port: 1, field: '/output' },
    { id: 'context', kind: 'RETRIEVAL', node: 1, port: 2, field: '/context' },
    { id: 'tool-result', kind: 'TOOL_RESULT', node: 2, port: 3, field: '/result' },
  ],
  targets: [{ id: 'command', node: 3, port: 4, tool: 'runner', effect: 'EXECUTE_COMMAND', argumentPaths: ['/command'] }],
  flows: [
    { ordinal: 1, fromNode: 1, fromPort: 1, toNode: 3, toPort: 4 },
    { ordinal: 2, fromNode: 1, fromPort: 2, toNode: 3, toPort: 4 },
    { ordinal: 3, fromNode: 2, fromPort: 3, toNode: 3, toPort: 4 },
  ],
});

describe('agentic influence and capability', () => {
  it('tracks independent model, retrieval, and tool-result integrity on non-zero ports', () => {
    const result = analyzeInfluenceV2(base());
    expect(result.status).toBe('COMPLETE');
    expect(result.influences.map((item) => item.sourceKind)).toEqual(['MODEL', 'RETRIEVAL', 'TOOL_RESULT']);
    expect(result.influences.every((item) => item.targetPort === 4)).toBe(true);
    expect(result.independentSources).toEqual(['MODEL', 'RETRIEVAL', 'TOOL_RESULT']);
    expect(result.influences[0]?.trace.map((step) => step.kind)).toEqual(['SOURCE', 'SINK']);
  });

  it('keeps branch and merge evidence deterministic and kills an overwritten branch only', () => {
    const input = base();
    const result = analyzeInfluenceV2({ ...input, overwrites: [{ node: 3, port: 4, field: '/context' }] });
    expect(result.influences.map((item) => item.sourceId)).toEqual(['model', 'tool-result']);
    expect(result).toEqual(analyzeInfluenceV2(structuredClone({ ...input, overwrites: [{ node: 3, port: 4, field: '/context' }] })));
  });

  it('does not require confidentiality taint to prove model influence', () => {
    const result = analyzeInfluenceV2({ ...base(), facts: [] });
    expect(result.influences).toHaveLength(3);
  });

  it('returns unknown for unsupported or omitted required evidence, never clean', () => {
    expect(analyzeInfluenceV2({ sources: base().sources, targets: base().targets, flows: [{ ...base().flows![0]!, resolution: 'AMBIGUOUS' }] })).toMatchObject({ status: 'UNKNOWN', influences: [] });
    expect(analyzeInfluenceV2({ sources: base().sources, targets: undefined, flows: [] })).toMatchObject({ status: 'UNKNOWN' });
  });

  it('rejects partial output at the exact budget boundary', () => {
    const result = analyzeInfluenceV2({ ...base(), maxOperations: 0 });
    expect(result).toMatchObject({ status: 'LIMIT_EXCEEDED', omitted: 1, influences: [] });
  });

  it('emits report-only unknown capability evidence with no assessment path', () => {
    const result = analyzeAgenticCapabilityV2({ influence: { ...base(), targets: undefined }, ruleEffect: 'REPORT_ONLY' });
    expect(result).toMatchObject({ status: 'UNKNOWN', aggregateEffect: 'DEGRADED', reportOnly: true, assessment: null, assessmentEligible: false });
  });

  it('reports an actual effect and argument when approval is bypassed', () => {
    const result = analyzeAgenticCapabilityV2({
      influence: base(),
      approval: { target: base().targets![0]!, paths: [{ pathId: 'main', target: base().targets![0]!, events: [] }] },
    });
    expect(result).toMatchObject({ status: 'UNAPPROVED', findings: [{ targetId: 'command', effect: 'EXECUTE_COMMAND', argumentPaths: ['/command'] }] });
    expect(result.assessment).toBeNull();
  });
  it('preserves every independent integrity source and treats empty facts as clean evidence', () => {
    const facts = [{ key: { node: 1, port: 1, field: '/out', item: 0 }, integrity: { labels: ['MODEL_OUTPUT', 'TOOL_RESULT', 'INBOUND_MESSAGE'], unknown: false }, confidentiality: { labels: [], unknown: false }, trace: [] }] as InfluenceInputV2['facts'];
    const result = analyzeInfluenceV2({ facts, targets: base().targets, flows: base().flows });
    expect(result.influences.map((item) => item.sourceKind)).toEqual(['MODEL', 'TOOL_RESULT', 'EXTERNAL']);
    expect(analyzeInfluenceV2({ facts: [], targets: [], flows: [] })).toMatchObject({ status: 'COMPLETE', clean: true });
  });

  it('stops an overwritten intermediate node rather than traversing past it', () => {
    const input: InfluenceInputV2 = { sources: [{ id: 'model', kind: 'MODEL', node: 1, port: 1, field: '/out' }], targets: [{ id: 'command', node: 3, port: 4, tool: 'runner', effect: 'EXECUTE_COMMAND' }], flows: [{ fromNode: 1, fromPort: 1, toNode: 2, toPort: 4 }, { fromNode: 2, fromPort: 4, toNode: 3, toPort: 4 }], overwrites: [{ node: 2, port: 4, field: '/out' }] };
    expect(analyzeInfluenceV2(input).influences).toEqual([]);
  });

  it('keeps approval coverage per target and allows an unspecified argument schema', () => {
    const input: InfluenceInputV2 = { sources: [{ id: 'a-source', kind: 'MODEL', node: 1, port: 1, field: '/a' }, { id: 'b-source', kind: 'TOOL_RESULT', node: 1, port: 2, field: '/b' }], targets: [{ id: 'a', node: 2, port: 3, tool: 'mailer', effect: 'SEND_MESSAGE', argumentPaths: ['/to'] }, { id: 'b', node: 2, port: 4, tool: 'runner', effect: 'EXECUTE_COMMAND', argumentPaths: ['/cmd'] }], flows: [{ fromNode: 1, fromPort: 1, toNode: 2, toPort: 3 }, { fromNode: 1, fromPort: 2, toNode: 2, toPort: 4 }] };
    const result = analyzeAgenticCapabilityV2({ influence: input, approval: { paths: [{ pathId: 'a', target: { targetId: 'a', tool: 'mailer', effect: 'SEND_MESSAGE' }, events: [{ kind: 'APPROVAL', targetId: 'a', tool: 'mailer', effect: 'SEND_MESSAGE' }] }, { pathId: 'b', target: { targetId: 'b', tool: 'runner', effect: 'EXECUTE_COMMAND' }, events: [] }] } });
    expect(result).toMatchObject({ status: 'UNAPPROVED', findings: [{ targetId: 'b' }] });
  });
  it('does not vacuously match an empty influence argument set', () => {
    const influence: InfluenceInputV2 = { sources: [{ id: 'source', kind: 'MODEL', node: 1, port: 1, field: '/out' }], targets: [{ id: 'target', node: 2, port: 2, tool: 'mailer', effect: 'SEND_MESSAGE', argumentPaths: [] }], flows: [{ fromNode: 1, fromPort: 1, toNode: 2, toPort: 2 }] };
    const result = analyzeAgenticCapabilityV2({ influence, approval: { target: { tool: 'mailer', effect: 'SEND_MESSAGE', argumentPaths: ['/to'] }, paths: [{ pathId: 'p', target: { tool: 'mailer', effect: 'SEND_MESSAGE', argumentPaths: ['/to'] }, events: [{ kind: 'APPROVAL', tool: 'mailer', effect: 'SEND_MESSAGE', argumentPaths: ['/to'] }] }] } });
    expect(result).toMatchObject({ status: 'UNAPPROVED', findings: [{ targetId: 'target' }] });
  });
});
