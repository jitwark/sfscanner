import { describe, expect, it } from 'vitest';
import { toNativeWorkflow } from './adapter-workflow';
import type { AnalyzerContextV2 } from './scheduler';
import type { SourceValueV2 } from '../source/source-types';

const ref = (pointer: string) => ({ pointer, occurrencePath: [], astNodeId: pointer, span: null });
const object = (members: Record<string, SourceValueV2>): SourceValueV2 => ({
  kind: 'OBJECT', ref: ref('/'), members: Object.entries(members).map(([name, value]) => ({ nameLexeme: `"${name}"`, name, occurrence: 0, ref: ref(`/${name}`), value })),
});
const array = (items: SourceValueV2[]): SourceValueV2 => ({ kind: 'ARRAY', ref: ref('/'), items });
const string = (value: string): SourceValueV2 => ({ kind: 'STRING', lexeme: JSON.stringify(value), value, ref: ref('/') });

describe('native workflow adapter', () => {
  it('preserves exported name-keyed connections and exposes edge resolutions', () => {
    const root = object({
      nodes: array([
        object({ name: string('Trigger'), type: string('n8n-nodes-base.noOp') }),
        object({ name: string('Target'), type: string('n8n-nodes-base.noOp') }),
      ]),
      connections: object({ Trigger: object({ main: array([array([object({ node: string('Target') })])]) }) }),
    });
    const context = {
      source: { root, rawSha256: 'a'.repeat(64), utf8Bytes: 10 },
      workflow: { nodes: [
        { type: 'n8n-nodes-base.noOp', parameters: [], ref: { ordinal: 0, name: 'Trigger', explicitId: 'id-trigger', source: ref('/nodes/0') } },
        { type: 'n8n-nodes-base.noOp', parameters: [], ref: { ordinal: 1, name: 'Target', explicitId: 'id-target', source: ref('/nodes/1') } },
      ] },
      limits: { maxEdges: 10 },
    } as unknown as AnalyzerContextV2;
    const native = toNativeWorkflow(context);
    expect(native.connections).toEqual({ Trigger: { main: [[{ node: 'Target' }]] } });
    expect(native.graph.resolutions).toEqual([{ state: 'EXACT', from: 'u:10:id-trigger', to: 'u:9:id-target', channel: 'main', inputOrdinal: 0 }]);
    expect(native.graph.analysisEdges).toHaveLength(1);
  });
});
