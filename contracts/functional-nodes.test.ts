import { describe, expect, it } from 'vitest';
import {
  countFunctionalNodes,
  functionalNodes,
  isFunctionalNode,
  isSubWorkflow,
  isSubWorkflowTrigger,
} from './functional-nodes';

const node = (type: string) => ({ type });

describe('isFunctionalNode', () => {
  it('rejects the two annotation and placeholder types', () => {
    expect(isFunctionalNode('n8n-nodes-base.stickyNote')).toBe(false);
    expect(isFunctionalNode('n8n-nodes-base.noOp')).toBe(false);
  });

  it('accepts nodes that call a service, run code, or move data', () => {
    for (const type of [
      'n8n-nodes-base.httpRequest',
      'n8n-nodes-base.code',
      'n8n-nodes-base.webhook',
      'n8n-nodes-base.set',
      '@n8n/n8n-nodes-langchain.chainLlm',
    ]) {
      expect(isFunctionalNode(type)).toBe(true);
    }
  });

  it('matches on the final segment regardless of package namespace', () => {
    expect(isFunctionalNode('stickyNote')).toBe(false);
    expect(isFunctionalNode('some-community-package.stickyNote')).toBe(false);
    expect(isFunctionalNode('n8n-nodes-base.NOOP')).toBe(false);
  });

  it('does not exclude a node whose name merely contains an excluded word', () => {
    // `noOpenAi` ends in a different token; substring matching would drop a real node.
    expect(isFunctionalNode('n8n-nodes-base.noOpenAi')).toBe(true);
    expect(isFunctionalNode('n8n-nodes-base.stickyNoteBuilder')).toBe(true);
  });

  it('treats an unrecognized type as functional rather than guessing', () => {
    expect(isFunctionalNode('n8n-nodes-base.somethingBrandNew')).toBe(true);
    expect(isFunctionalNode('')).toBe(true);
  });
});

describe('countFunctionalNodes', () => {
  it('counts only nodes that do work', () => {
    const nodes = [
      node('n8n-nodes-base.webhook'),
      node('n8n-nodes-base.stickyNote'),
      node('n8n-nodes-base.stickyNote'),
      node('n8n-nodes-base.httpRequest'),
      node('n8n-nodes-base.noOp'),
    ];
    expect(nodes.length).toBe(5);
    expect(countFunctionalNodes(nodes)).toBe(2);
  });

  it('returns zero for a canvas holding nothing but comments', () => {
    expect(countFunctionalNodes([node('n8n-nodes-base.stickyNote')])).toBe(0);
  });

  it('returns zero for an empty workflow', () => {
    expect(countFunctionalNodes([])).toBe(0);
  });

  it('preserves input order and identity in functionalNodes', () => {
    const nodes = [
      { type: 'n8n-nodes-base.webhook', name: 'in' },
      { type: 'n8n-nodes-base.stickyNote', name: 'note' },
      { type: 'n8n-nodes-base.slack', name: 'out' },
    ];
    expect(functionalNodes(nodes).map((n) => n.name)).toEqual(['in', 'out']);
  });
});

describe('sub-workflow detection', () => {
  it('recognizes the execute-workflow trigger', () => {
    expect(isSubWorkflowTrigger('n8n-nodes-base.executeWorkflowTrigger')).toBe(true);
  });

  it('does not treat the executeWorkflow action node as a trigger', () => {
    // `executeWorkflow` calls a child; only `executeWorkflowTrigger` is the callee side.
    expect(isSubWorkflowTrigger('n8n-nodes-base.executeWorkflow')).toBe(false);
  });

  it('flags a workflow whose only trigger is a parent call', () => {
    expect(
      isSubWorkflow([node('n8n-nodes-base.executeWorkflowTrigger'), node('n8n-nodes-base.set')]),
    ).toBe(true);
  });

  it('does not flag a workflow that can also start on its own', () => {
    expect(
      isSubWorkflow([
        node('n8n-nodes-base.executeWorkflowTrigger'),
        node('n8n-nodes-base.webhook'),
      ]),
    ).toBe(false);
  });

  it('does not flag a workflow with no trigger at all', () => {
    expect(isSubWorkflow([node('n8n-nodes-base.set')])).toBe(false);
  });
});
