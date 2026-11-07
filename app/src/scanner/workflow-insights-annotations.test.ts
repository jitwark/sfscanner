import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { analyzeWorkflowInsights, assessWorkflowRisk } from './workflow-insights';

/**
 * Annotations inflated published numbers through two independent channels, so
 * these cases pin both. Closing only the node-count channel still leaves the
 * complexity band wrong via `integrationCount`, and the report still renders a
 * service called "Sticky Note".
 *
 * Measured with `npx tsx pipeline/measure/node-count-impact.ts --canonical-only`
 * over 12,104 canonical workflows: 17.3% shift complexity band, 7.2% change
 * published security grade, and 87.6% had an inflated integration count.
 */

function parseWorkflow(workflow: unknown) {
  const parsed = parseWorkflowJson(JSON.stringify(workflow));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
}

const node = (id: string, type: string) => ({ id, name: id, type, parameters: {} });

/** Two real nodes, plus enough comments to look busy. */
const annotated = {
  name: 'Documented sync',
  nodes: [
    node('webhook-1', 'n8n-nodes-base.webhook'),
    node('http-1', 'n8n-nodes-base.httpRequest'),
    node('note-1', 'n8n-nodes-base.stickyNote'),
    node('note-2', 'n8n-nodes-base.stickyNote'),
    node('note-3', 'n8n-nodes-base.stickyNote'),
    node('note-4', 'n8n-nodes-base.stickyNote'),
    node('placeholder-1', 'n8n-nodes-base.noOp'),
  ],
  connections: {},
};

describe('annotations do not inflate workflow metrics', () => {
  it('counts only functional nodes, and keeps the raw count as provenance', () => {
    const insights = analyzeWorkflowInsights(parseWorkflow(annotated));

    expect(insights.workflow.nodeCount).toBe(2);
    expect(insights.workflow.rawNodeCount).toBe(7);
    expect(insights.workflow.annotationNodeCount).toBe(5);
  });

  it('does not report Sticky Note or No Op as integrations', () => {
    const insights = analyzeWorkflowInsights(parseWorkflow(annotated));
    const services = insights.integrations.map((integration) => integration.service);

    expect(services).not.toContain('Sticky Note');
    expect(services).not.toContain('No Op');
    expect(services.sort()).toEqual(['HTTP Request', 'Webhook']);
  });

  it('bands complexity on functional nodes, not on comment count', () => {
    // Seven raw nodes crosses the >= 6 MEDIUM threshold; two functional does not.
    expect(analyzeWorkflowInsights(parseWorkflow(annotated)).workflow.complexity).toBe('LOW');
  });

  it('closes the integration channel, not only the node-count channel', () => {
    // Four distinct annotation types would reach the >= 4 integration threshold
    // on their own, even with the node count corrected.
    const insights = analyzeWorkflowInsights(
      parseWorkflow({
        name: 'Comment heavy',
        nodes: [
          node('set-1', 'n8n-nodes-base.set'),
          node('note-1', 'n8n-nodes-base.stickyNote'),
          node('note-2', 'stickyNote'),
          node('op-1', 'n8n-nodes-base.noOp'),
          node('op-2', 'noOp'),
        ],
        connections: {},
      }),
    );

    expect(insights.workflow.integrationCount).toBe(1);
    expect(insights.workflow.complexity).toBe('LOW');
  });

  it('removes the complexity weight those annotations were adding to the risk score', () => {
    const workflow = parseWorkflow(annotated);
    const insights = analyzeWorkflowInsights(workflow);
    const risk = assessWorkflowRisk(workflow, [], insights);

    // complexityWeight: HIGH 20, MEDIUM 10, LOW 0. With no findings, a correct
    // LOW band leaves nothing behind. This workflow used to score 10 on comments.
    expect(risk.score).toBe(0);
    expect(risk.grade).toBe('LOW');
  });

  it('still counts a genuinely complex workflow as complex', () => {
    const insights = analyzeWorkflowInsights(
      parseWorkflow({
        name: 'Real work',
        nodes: Array.from({ length: 16 }, (_, index) =>
          node(`http-${index}`, 'n8n-nodes-base.httpRequest'),
        ),
        connections: {},
      }),
    );

    expect(insights.workflow.nodeCount).toBe(16);
    expect(insights.workflow.complexity).toBe('HIGH');
  });

  it('flags a workflow that only a parent workflow can start', () => {
    const insights = analyzeWorkflowInsights(
      parseWorkflow({
        name: 'Child routine',
        nodes: [
          node('trigger-1', 'n8n-nodes-base.executeWorkflowTrigger'),
          node('set-1', 'n8n-nodes-base.set'),
        ],
        connections: {},
      }),
    );

    expect(insights.workflow.isSubWorkflow).toBe(true);
  });

  it('does not flag a workflow that also has its own trigger', () => {
    const insights = analyzeWorkflowInsights(
      parseWorkflow({
        name: 'Callable and independent',
        nodes: [
          node('trigger-1', 'n8n-nodes-base.executeWorkflowTrigger'),
          node('hook-1', 'n8n-nodes-base.webhook'),
        ],
        connections: {},
      }),
    );

    expect(insights.workflow.isSubWorkflow).toBe(false);
  });
});
