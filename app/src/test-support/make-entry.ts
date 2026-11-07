import type {
  Complexity,
  Entry,
  EntryDedup,
  EntryRights,
  EntrySecurity,
  EntrySource,
  EntryStructure,
  Grade,
  PublicFinding,
  RightsStatus,
  SourceKind,
} from '@hub/contracts';

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends readonly unknown[] ? T[P] : T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export function makeSource(overrides: DeepPartial<EntrySource> = {}): EntrySource {
  const kind: SourceKind = overrides.kind ?? 'github';
  const fullCommit = '1234567890123456789012345678901234567890';
  const source: EntrySource = {
    kind,
    permalink:
      overrides.permalink ??
      (kind === 'github'
        ? `https://github.com/owner/repo/blob/${fullCommit}/workflows/test.json`
        : 'https://n8n.io/workflows/100'),
    fetchedAt: overrides.fetchedAt ?? '2026-01-01T00:00:00.000Z',
  };
  const repo = overrides.repo ?? (kind === 'github' ? 'owner/repo' : undefined);
  const path = overrides.path ?? (kind === 'github' ? 'workflows/test.json' : undefined);
  const commit = overrides.commit ?? (kind === 'github' ? fullCommit : undefined);
  if (repo !== undefined) source.repo = repo;
  if (overrides.owner !== undefined) source.owner = overrides.owner;
  else if (kind === 'github') source.owner = 'owner';
  if (overrides.stars !== undefined) source.stars = overrides.stars;
  else if (kind === 'github') source.stars = 10;
  if (path !== undefined) source.path = path;
  if (commit !== undefined) source.commit = commit;
  if (overrides.committedAt !== undefined) source.committedAt = overrides.committedAt;
  else if (kind === 'github') source.committedAt = '2025-01-01T00:00:00Z';
  if (overrides.templateId !== undefined) source.templateId = overrides.templateId;
  if (overrides.author !== undefined) source.author = overrides.author;
  else source.author = { name: 'Alice', username: 'alice', url: 'https://github.com/alice' };
  return source;
}

export function makeRights(overrides: DeepPartial<EntryRights> = {}): EntryRights {
  const status: RightsStatus = overrides.status ?? 'redistributable';
  return {
    status,
    licence: overrides.licence !== undefined ? overrides.licence : status === 'redistributable' ? 'MIT' : null,
    licenceUrl:
      overrides.licenceUrl !== undefined
        ? overrides.licenceUrl
        : status === 'redistributable'
          ? 'https://spdx.org/licenses/MIT.html'
          : null,
    reason:
      overrides.reason ??
      (status === 'redistributable'
        ? 'repo licence MIT - permitted for redistribution'
        : 'official n8n template - linked, not redistributed'),
  };
}

export function makeStructure(overrides: DeepPartial<EntryStructure> = {}): EntryStructure {
  return {
    nodeCount: overrides.nodeCount ?? 2,
    rawNodeCount: overrides.rawNodeCount ?? overrides.nodeCount ?? 2,
    annotationNodeCount: overrides.annotationNodeCount ?? 0,
    connectionCount: overrides.connectionCount ?? 1,
    nodeTypes: overrides.nodeTypes ? [...overrides.nodeTypes] : ['n8n-nodes-base.webhook', 'n8n-nodes-base.slack'],
    integrations: overrides.integrations ? [...overrides.integrations] : ['webhook', 'slack'],
    trigger: overrides.trigger ?? 'Webhook',
    isSubWorkflow: overrides.isSubWorkflow ?? false,
    complexity: (overrides.complexity ?? 'simple') as Complexity,
    hasCode: overrides.hasCode ?? false,
    hasAI: overrides.hasAI ?? false,
    hasWebhook: overrides.hasWebhook ?? true,
    ...(overrides.partial === undefined ? {} : { partial: overrides.partial }),
  };
}

export function makeSecurity(overrides: DeepPartial<EntrySecurity> = {}): EntrySecurity {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0, ...overrides.counts };
  return {
    grade: (overrides.grade ?? 'LOW') as Grade,
    score: overrides.score ?? 100,
    counts,
    findings: overrides.findings ? ([...overrides.findings] as PublicFinding[]) : [],
    hardenedExtra: overrides.hardenedExtra ?? 0,
    scannerVersion: overrides.scannerVersion ?? '1.0.0',
    profile: overrides.profile ?? 'beta-default',
    schemaVersion: overrides.schemaVersion ?? 'scanner-result-v1',
  };
}

export function makeEntry(overrides: DeepPartial<Entry> = {}): Entry {
  const id = overrides.id ?? 'test-entry-1';
  const baseDedup: EntryDedup = {
    fingerprint: `fp-${id}`,
    structuralHash: `sh-${id}`,
    canonical: true,
    alsoFoundIn: [],
  };
  return {
    id,
    slug: overrides.slug ?? id,
    title: overrides.title ?? `Workflow ${id}`,
    summary: overrides.summary ?? `Summary for ${id}`,
    description: overrides.description ?? `Description for ${id}`,
    descriptionSource: overrides.descriptionSource ?? 'upstream',
    source: makeSource(overrides.source),
    rights: makeRights(overrides.rights),
    structure: makeStructure(overrides.structure),
    security: makeSecurity(overrides.security),
    tags: overrides.tags ? [...overrides.tags] : ['automation'],
    dedup: overrides.dedup
      ? { ...baseDedup, ...overrides.dedup, alsoFoundIn: overrides.dedup.alsoFoundIn ? [...overrides.dedup.alsoFoundIn] : [] }
      : baseDedup,
    ...(overrides.chartRef ? { chartRef: { shard: overrides.chartRef.shard ?? 0, offset: overrides.chartRef.offset ?? 0, length: overrides.chartRef.length ?? 0 } } : {}),
    ...(overrides.download ? { download: { pack: overrides.download.pack ?? 0, line: overrides.download.line ?? 0, offset: overrides.download.offset ?? 0, length: overrides.download.length ?? 0, ...(overrides.download.sha256 === undefined ? {} : { sha256: overrides.download.sha256 }) } } : {}),
  };
}
