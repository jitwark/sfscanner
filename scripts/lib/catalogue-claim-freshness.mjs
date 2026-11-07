function isFunctional(node) {
  return node?.isAnnotation !== true && !String(node?.type ?? '').toLowerCase().includes('stickynote');
}

export function classifyChart(chart) {
  if (!chart) return 'quarantine';
  const nodes = Array.isArray(chart?.nodes) ? chart.nodes : [];
  const edges = Array.isArray(chart?.edges) ? chart.edges : [];
  const functional = nodes.filter(isFunctional);
  // Resolve to the node's POSITION, not its id. Sanitization collapses every
  // node id in some charts to a single token — `''`, `'REDACTED'`, and
  // `'[CENSORED]'` all occur in the packaged corpus. Comparing ids then made
  // every edge in a fully connected graph look like a self-loop, and 18 of
  // 13,221 workflows were withheld as unrenderable when they render fine.
  // A position cannot collide.
  const functionalRefs = new Map();
  functional.forEach((node, position) => {
    for (const ref of [node?.id, node?.name]) {
      if (typeof ref === 'string' && ref.length > 0 && !functionalRefs.has(ref)) {
        functionalRefs.set(ref, position);
      }
    }
  });
  const connected = edges.some((edge) => {
    const from = functionalRefs.get(edge?.from);
    const to = functionalRefs.get(edge?.to);
    return from !== undefined && to !== undefined && from !== to;
  });
  return functional.length >= 2 && !connected ? 'quarantine' : 'publishable';
}

export function auditCatalogueClaimFreshness(entries, chartsById, quarantineReport = undefined, projectionIds = []) {
  const violations = [];
  const publicCandidates = new Set();
  for (const entry of entries) {
    if (classifyChart(chartsById.get(entry.id)) === 'quarantine') {
      publicCandidates.add(entry.id);
      violations.push(`${entry.id}: stale/incomplete catalogue claim remains public`);
    }
  }
  const quarantinedIds = new Set(publicCandidates);
  if (quarantineReport) {
    const listed = quarantineReport.entries ?? [];
    const ids = listed.map((entry) => entry.id);
    for (const id of ids) quarantinedIds.add(id);
    if (ids.some((id) => typeof id !== 'string' || id.length === 0)) violations.push('quarantine report contains an invalid ID');
    if (new Set(ids).size !== ids.length) violations.push('quarantine report contains duplicate IDs');
    if (quarantineReport.totalInput !== entries.length + ids.length) violations.push('quarantine report total does not reconcile');
    if (quarantineReport.published !== entries.length || quarantineReport.quarantined !== ids.length) violations.push('quarantine report counts do not reconcile');
    if (listed.some((entry) => !Array.isArray(entry.reasons) || entry.reasons.length === 0)) violations.push('quarantine report has an entry without a reason');
    if (ids.some((id) => entries.some((entry) => entry.id === id))) violations.push('quarantined ID remains in catalogue');
  } else if (publicCandidates.size > 0) {
    violations.push('quarantined claims have no quarantine report');
  }
  if (projectionIds.some((id) => quarantinedIds.has(id))) violations.push('quarantined claim appears in a derived public projection');
  return { violations, quarantinedCount: publicCandidates.size };
}
