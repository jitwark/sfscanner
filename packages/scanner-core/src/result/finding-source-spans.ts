import type { CanonicalScanFinding } from '../policy/policy';
import type { NormalizedWorkflowNode } from '../workflow';

export type SourceSpanAttachment = {
  findings: CanonicalScanFinding[];
  unresolvedCount: number;
};

/**
 * Sole authority for v1 finding-to-source span attachment; the browser engine and the pipeline
 * CLI both call it and neither may restate it.
 *
 * Ambiguity is id-level duplication: a node id carried by more than one normalized node names no
 * single source, so the finding stays without a span and the caller raises
 * `SOURCE_SPAN_UNAVAILABLE` from `unresolvedCount`. That is the same condition the parser records
 * as `DUPLICATE_NODE_ID`, derived here from the node list so both surfaces derive it identically.
 */
export function attachFindingSourceSpans(
  findings: CanonicalScanFinding[],
  nodes: ReadonlyArray<NormalizedWorkflowNode>,
): SourceSpanAttachment {
  const nodesById = new Map<string, NormalizedWorkflowNode[]>();
  for (const node of nodes) {
    nodesById.set(node.id, [...(nodesById.get(node.id) ?? []), node]);
  }

  let unresolvedCount = 0;
  const attached = findings.map((finding) => {
    const nodeId = finding.location.nodeId;
    if (nodeId === undefined) return finding;

    const matches = nodesById.get(nodeId);
    const sourceSpan = matches && matches.length === 1 ? matches[0].sourceSpan : undefined;
    if (!sourceSpan) {
      unresolvedCount += 1;
      return finding;
    }
    return { ...finding, location: { ...finding.location, sourceSpan } };
  });

  return { findings: attached, unresolvedCount };
}
