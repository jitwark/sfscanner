export const SEARCH_FIELDS = ['id', 'title', 'summary', 'tags', 'integrations', 'triggers', 'capabilities', 'content'] as const;
export const SEARCH_STORE_FIELDS = [
  'id', 'slug', 'title', 'summary', 'tags', 'integrations', 'triggers', 'capabilities',
  'grade', 'rights', 'complexity', 'nodeCount', 'sourceRepo',
  'descriptionSource', 'isIndexable', 'isPrerendered',
] as const;

export const SEARCH_BOOSTS = {
  title: 4,
  tags: 3,
  integrations: 2,
  triggers: 1.5,
  capabilities: 1.5,
  content: 1.25,
  summary: 1,
} as const;

export const SEARCH_OPTIONS = {
  prefix: true,
  fuzzy: 0.2,
  combineWith: 'OR' as const,
  boost: SEARCH_BOOSTS,
};

/**
 * The ranking multiplier applied to every result, and the ordering the index
 * shards are built from.
 *
 * It lives in contracts because two places must agree on it: the worker ranks
 * with it, and the packager sorts by it to decide which entries land in the
 * content-indexed tier. If those two disagree, the tier that gets the richest
 * index is not the tier that ranks highest, and nobody would notice.
 */
export function qualityScore(doc: {
  qualityScore?: number;
  rights?: string;
  grade?: string;
  nodeCount?: number;
  summary?: string;
}): number {
  if (typeof doc.qualityScore === 'number') return doc.qualityScore;
  let score = 1.0;
  // No rights-based availability boost. It used to add +0.15 for
  // `rights === 'redistributable'`, but audit F-001 RULING-2 moved the last 288
  // such rows to link-only, so the condition can no longer be true for any
  // published entry and a branch that cannot fire is worse than none: it reads
  // as an active ranking policy. Removing it is byte-neutral for every artifact.
  const grade = doc.grade?.toUpperCase();
  if (grade === 'CRITICAL') score -= 0.15;
  else if (grade === 'HIGH') score -= 0.05;
  else if (grade === 'LOW') score += 0.05;
  if (typeof doc.nodeCount === 'number' && doc.nodeCount > 0) {
    score += Math.min(0.15, Math.log10(doc.nodeCount) * 0.05);
  }
  if (doc.summary && doc.summary.length > 20 && !doc.summary.startsWith('Workflow containing')) {
    score += 0.1;
  }
  return Math.max(0.6, Math.min(1.4, Math.round(score * 100) / 100));
}
