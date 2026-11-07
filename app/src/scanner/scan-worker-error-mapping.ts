import type { WorkflowTooComplexCause } from '@hub/scanner-core/workflow';

/**
 * `parseWorkflowJson` (packages/scanner-core/src/workflow.ts) collapses every
 * distinct complexity rejection — too many nodes, too many edges, connection
 * nesting too deep, parameter structure too large, or document nesting beyond
 * the parser safety ceiling, or duplicate-key pointer output beyond its
 * aggregate limit — into a single
 * `WORKFLOW_TOO_COMPLEX` code, but carries a typed `cause` field
 * (`WorkflowTooComplexCause`) naming which budget was hit. This maps that
 * typed cause to the distinct reason the UI gives accurate, actionable copy
 * for.
 *
 * `WorkflowTooComplexCause` is a closed union with exactly one member per
 * rejection site in scanner-core, so the switch below is exhaustive: the
 * `default` branch is a compile-time check (an unhandled union member fails
 * to assign to `never`), not a runtime guess. If it is ever reached anyway
 * (only possible via a type-unsafe call), it throws instead of silently
 * mislabeling the cause — silently defaulting to any specific reason would
 * just reintroduce AUDIT-SCAN-003 under a different name.
 */
export type TooComplexReason =
  | 'TOO_MANY_NODES'
  | 'TOO_MANY_EDGES'
  | 'CONNECTIONS_TOO_DEEP'
  | 'PARAMETERS_TOO_COMPLEX'
  | 'DOCUMENT_TOO_DEEP'
  | 'DUPLICATE_LOCATIONS_TOO_COMPLEX';

/** Extra, redaction-safe data about a rejection. Counts only — never content. */
export type ScanErrorDetails = {
  observedNodeCount?: number;
};

export function mapTooComplexReason(cause: WorkflowTooComplexCause): TooComplexReason {
  switch (cause) {
    case 'NODE_LIMIT':
      return 'TOO_MANY_NODES';
    case 'EDGE_LIMIT':
      return 'TOO_MANY_EDGES';
    case 'CONNECTION_DEPTH_LIMIT':
      return 'CONNECTIONS_TOO_DEEP';
    case 'PARAMETER_COMPLEXITY_LIMIT':
      return 'PARAMETERS_TOO_COMPLEX';
    case 'DOCUMENT_DEPTH_LIMIT':
      return 'DOCUMENT_TOO_DEEP';
    case 'DUPLICATE_KEY_LOCATION_LIMIT':
      return 'DUPLICATE_LOCATIONS_TOO_COMPLEX';
    default: {
      const exhaustive: never = cause;
      throw new Error(`Unmapped too-complex cause: ${String(exhaustive)}`);
    }
  }
}

/**
 * Best-effort, redaction-safe re-count of top-level nodes for messaging only
 * (a length, never content). Used when a workflow was rejected for having too
 * many nodes, so the UI can name the real observed count alongside the limit.
 * Returns undefined rather than throwing so a shape mismatch never blocks the
 * error response — the count is a nicety, not load-bearing.
 */
export function tryCountRawNodes(json: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const nodes = (parsed as Record<string, unknown>).nodes;
      if (Array.isArray(nodes)) return nodes.length;
    }
  } catch {
    // Not valid JSON by this second, simpler parse — no count available.
  }
  return undefined;
}
