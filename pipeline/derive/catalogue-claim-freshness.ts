import type { EntrySecurity, EntryWithChart, WorkflowChart } from '@hub/contracts';

export type ClaimFreshness = {
  status: 'publishable' | 'quarantine';
  reasons: string[];
};

export type DerivationIdentity = {
  workflowHash: string;
  graphHash: string;
  scannerVersion: string;
  profile: EntrySecurity['profile'];
};

/**
 * A graph is incomplete when it drops a connection or leaves two or more work
 * nodes with no resolvable data path. This is intentionally conservative: a
 * claim may be quarantined, but an old reassuring grade cannot be repaired by
 * inference.
 */
export function classifyCatalogueClaim(chart: WorkflowChart): ClaimFreshness {
  const functional = chart.nodes.filter((node) => node.isAnnotation !== true && !node.type.toLowerCase().includes('stickynote'));
  // Resolve to the node's POSITION, not its id. Sanitization collapses every
  // node id in some charts to a single token — `''`, `'REDACTED'` and
  // `'[CENSORED]'` all occur in the packaged corpus. Comparing ids then made
  // every edge in a fully connected graph look like a self-loop, and 18 of
  // 13,221 workflows were quarantined as unrenderable when they render fine.
  // A position cannot collide.
  const functionalRefs = new Map<string, number>();
  functional.forEach((node, position) => {
    for (const ref of [node.id, node.name]) {
      if (ref && !functionalRefs.has(ref)) functionalRefs.set(ref, position);
    }
  });
  const connected = chart.edges.some((edge) => {
    const from = functionalRefs.get(edge.from);
    const to = functionalRefs.get(edge.to);
    return from !== undefined && to !== undefined && from !== to;
  });
  const incomplete = functional.length >= 2 && !connected;
  if (!incomplete) return { status: 'publishable', reasons: [] };

  // `GRAPH_INCOMPLETE` stays first and stays stable: it is the machine-readable
  // code, and `data/quarantine-report.json` is a published artifact. The prose
  // that follows is for the person reading it, who otherwise has to go and
  // re-derive what "incomplete" meant for this particular workflow.
  const phantom = chart.edges.filter(
    (edge) => functionalRefs.get(edge.from) === undefined || functionalRefs.get(edge.to) === undefined,
  ).length;
  const detail = chart.edges.length === 0
    ? `the packaged workflow declares ${functional.length} functional nodes and no connections at all`
    : phantom > 0
      ? `${phantom} of ${chart.edges.length} connections reference a node absent from the workflow`
      : `${functional.length} functional nodes, ${chart.edges.length} connections, none joining two distinct nodes`;
  return { status: 'quarantine', reasons: ['GRAPH_INCOMPLETE', detail] };
}

export function isDerivationIdentityCurrent(recorded: DerivationIdentity | undefined, expected: DerivationIdentity): boolean {
  return recorded !== undefined
    && recorded.workflowHash === expected.workflowHash
    && recorded.graphHash === expected.graphHash
    && recorded.scannerVersion === expected.scannerVersion
    && recorded.profile === expected.profile;
}

export function partitionCatalogueClaims(items: EntryWithChart[]): {
  published: EntryWithChart[];
  quarantined: Array<{ entry: EntryWithChart['entry']; reasons: string[] }>;
} {
  const published: EntryWithChart[] = [];
  const quarantined: Array<{ entry: EntryWithChart['entry']; reasons: string[] }> = [];
  for (const item of items) {
    const result = classifyCatalogueClaim(item.chart);
    if (result.status === 'publishable') published.push(item);
    else quarantined.push({ entry: item.entry, reasons: result.reasons });
  }
  return { published, quarantined };
}
