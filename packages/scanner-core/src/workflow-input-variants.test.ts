import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from './workflow';

const currentNode = {
  id: 'manual-trigger',
  name: 'Manual Trigger',
  type: 'n8n-nodes-base.manualTrigger',
  typeVersion: 1,
  parameters: {},
};

const acceptedExports = [
  ['current Download export with metadata', {
    name: 'Current export',
    nodes: [{ ...currentNode, position: [0, 0] }],
    connections: {},
    active: false,
    settings: { executionOrder: 'v1' },
    versionId: 'version-1',
    meta: { instanceId: 'instance-1' },
    tags: [],
  }],
  ['minimal legacy export', {
    nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {}, position: [0, 0] }],
    connections: {},
  }],
  ['multi-node export with pin data and connections', {
    nodes: [
      { ...currentNode, position: [0, 0] },
      { name: 'Finish', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {}, position: [240, 0] },
    ],
    connections: { 'Manual Trigger': { main: [[{ node: 'Finish', type: 'main', index: 0 }]] } },
    pinData: { Finish: [{ json: { ok: true } }] },
    staticData: null,
  }],
] as const;

describe('parseWorkflowJson n8n input variants', () => {
  it.each(acceptedExports)('accepts a %s', (_label, exportShape) => {
    const result = parseWorkflowJson(JSON.stringify(exportShape));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.nodeCount).toBe(exportShape.nodes.length);
  });

  it.each([
    ['credential-only export', { credentials: { postgres: {} } }],
    ['multi-workflow project export', { workflows: acceptedExports.map(([, value]) => value) }],
    ['root array export', [acceptedExports[0][1]]],
    ['workflow with non-object connections', { nodes: [currentNode], connections: [] }],
    ['workflow with an incomplete node', { nodes: [{ name: 'Missing type' }], connections: {} }],
  ])('rejects a %s at the parser boundary', (_label, exportShape) => {
    const result = parseWorkflowJson(JSON.stringify(exportShape));

    expect(result).toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
  });
});
