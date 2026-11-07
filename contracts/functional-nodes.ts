/**
 * Which nodes count as work the workflow actually performs.
 *
 * n8n stores canvas annotations as real entries in `nodes`. A `stickyNote` is
 * a coloured comment box; a `noOp` is a routing placeholder. Neither calls a
 * service, runs code, or moves data, but both inflate metrics derived from
 * `nodes.length`.
 */

/** Lowercased final type segments that are annotation or placeholder nodes. */
const NON_FUNCTIONAL_TYPES: ReadonlySet<string> = new Set(['stickynote', 'noop']);

/** Lowercased final type segments that mean a parent workflow starts this one. */
const SUB_WORKFLOW_TRIGGER_TYPES: ReadonlySet<string> = new Set([
  'executeworkflowtrigger',
]);

/** The segment after the last dot, lowercased. */
function compactType(type: string): string {
  const segments = type.split('.');
  return (segments[segments.length - 1] ?? type).toLowerCase();
}

/** True when the node does work, rather than annotating or padding the canvas. */
export function isFunctionalNode(type: string): boolean {
  return !NON_FUNCTIONAL_TYPES.has(compactType(type));
}

/** True for a trigger that only fires when a parent workflow calls it. */
export function isSubWorkflowTrigger(type: string): boolean {
  return SUB_WORKFLOW_TRIGGER_TYPES.has(compactType(type));
}

/** A workflow is a sub-workflow when every trigger is a parent-call trigger. */
export function isSubWorkflow(nodes: ReadonlyArray<{ type: string }>): boolean {
  const triggers = nodes.filter((node) => isTriggerLikeType(node.type));
  return triggers.length > 0 && triggers.every((node) => isSubWorkflowTrigger(node.type));
}

function isTriggerLikeType(type: string): boolean {
  const compact = compactType(type);
  return compact.includes('trigger') || compact.includes('webhook')
    || compact.includes('cron') || compact.includes('schedule');
}

/** Nodes that do work, in input order. */
export function functionalNodes<T extends { type: string }>(nodes: ReadonlyArray<T>): T[] {
  return nodes.filter((node) => isFunctionalNode(node.type));
}

/** How many nodes do work. This is the number every metric and band should use. */
export function countFunctionalNodes(nodes: ReadonlyArray<{ type: string }>): number {
  return functionalNodes(nodes).length;
}
