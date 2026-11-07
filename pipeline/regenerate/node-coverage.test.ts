import { describe, expect, it } from 'vitest';
import { buildNodeCoverage, projectNodeSample } from './node-coverage.js';
import { projectFormalNodeSample } from './formal-node-coverage.js';

const sample = (entryId: string, nodes: Array<{ type: string; typeVersion: unknown }>) =>
  projectNodeSample(entryId, new TextEncoder().encode(JSON.stringify({ nodes, connections: {} })));

describe('v2 node coverage', () => {
  it('keeps legacy sample/public coverage bytes independent of private reviewed-scoped coverage', () => {
    const bytes = new TextEncoder().encode('{"nodes":[{"type":"n8n-nodes-base.gmail","typeVersion":2.2,"parameters":{"operation":"sendAndWait"}}],"connections":{}}');
    const legacy = projectNodeSample('a', bytes);
    const before = JSON.stringify(buildNodeCoverage([legacy]));
    expect(projectFormalNodeSample('a', bytes).reviewedExecutableInstances).toBe(0);
    expect(JSON.stringify(buildNodeCoverage([legacy]))).toBe(before);
    expect(Object.keys(legacy)).toEqual(['entryId', 'nodes']);
    expect(Object.keys(buildNodeCoverage([legacy]))).not.toContain('formalCoverage');
  });
  it('counts workflows and instances per type/version and resolves the catalogue', () => {
    const coverage = buildNodeCoverage([
      sample('a', [
        { type: 'n8n-nodes-base.gmail', typeVersion: 2.1 },
        { type: 'n8n-nodes-base.gmail', typeVersion: 2.1 },
        { type: 'n8n-nodes-base.telegram', typeVersion: 2 },
      ]),
      sample('b', [{ type: 'n8n-nodes-base.gmail', typeVersion: '2.2' }, { type: 'n8n-nodes-base.gmail', typeVersion: 9 }]),
    ]);

    expect(coverage.versions).toContainEqual({ nodeType: 'n8n-nodes-base.gmail', version: '2.1.0', workflows: 1, instances: 2, semantics: 'MODELLED' });
    expect(coverage.versions).toContainEqual({ nodeType: 'n8n-nodes-base.telegram', version: '2.0.0', workflows: 1, instances: 1, semantics: 'UNMODELLED' });
    expect(coverage.versions).toContainEqual({ nodeType: 'n8n-nodes-base.gmail', version: '2.2.0', workflows: 1, instances: 1, semantics: 'MODELLED' });
    expect(coverage.modelledTypes).toBe(0);
    expect(coverage.partlyModelledTypes).toBe(1);
    expect(coverage.unmodelledTypes).toBe(1);
    expect(coverage.observedNodeInstances).toBe(5);
    expect(coverage.unknownTypes.map((type) => type.nodeType)).not.toContain('n8n-nodes-base.gmail');
  });

  it('lists a type with no modelled version as unknown rather than omitting it', () => {
    const coverage = buildNodeCoverage([sample('a', [{ type: 'n8n-nodes-base.discord', typeVersion: 2 }])]);
    expect(coverage.unmodelledTypes).toBe(1);
    expect(coverage.unknownTypes).toEqual([{ nodeType: 'n8n-nodes-base.discord', workflows: 1, instances: 1, versions: ['2.0.0'] }]);
  });
});
