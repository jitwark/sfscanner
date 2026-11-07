import type {
  Candidate,
  ChartEdge,
  ChartNode,
  Complexity,
  Entry,
  EntryDedup,
  EntryDownload,
  EntryRights,
  EntrySecurity,
  EntrySource,
  EntryStructure,
  EntryWithChart,
  Grade,
  PublicFinding,
  RightsStatus,
  SourceKind,
  WorkflowChart,
} from '@hub/contracts';

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? T[P]
    : T[P] extends readonly (infer U)[]
    ? T[P]
    : T[P] extends object
    ? DeepPartial<T[P]>
    : T[P];
};

export function makeSource(overrides?: DeepPartial<EntrySource>): EntrySource {
  const baseAuthor = {
    name: 'Alice',
    username: 'alice',
    url: 'https://github.com/alice',
  };
  const author =
    overrides && 'author' in overrides
      ? overrides.author
        ? { ...baseAuthor, ...overrides.author }
        : undefined
      : baseAuthor;

  const kind: SourceKind = overrides?.kind ?? 'github';
  const repo = overrides?.repo ?? (kind === 'github' ? 'owner/repo' : undefined);
  const path = overrides?.path ?? (kind === 'github' ? 'workflows/test.json' : undefined);
  const commit =
    overrides?.commit ??
    (kind === 'github' ? '1234567890123456789012345678901234567890' : undefined);
  const permalink =
    overrides?.permalink ??
    (kind === 'github'
      ? 'https://github.com/owner/repo/blob/1234567890123456789012345678901234567890/workflows/test.json'
      : 'https://n8n.io/workflows/100');

  const source: EntrySource = {
    kind,
    permalink,
    fetchedAt: overrides?.fetchedAt ?? '2026-01-01T00:00:00.000Z',
  };

  if (repo !== undefined) source.repo = repo;
  if (overrides?.owner !== undefined) source.owner = overrides.owner;
  else if (kind === 'github') source.owner = 'owner';
  if (overrides?.stars !== undefined) source.stars = overrides.stars;
  else if (kind === 'github') source.stars = 10;
  if (path !== undefined) source.path = path;
  if (commit !== undefined) source.commit = commit;
  if (overrides?.committedAt !== undefined) source.committedAt = overrides.committedAt;
  else if (kind === 'github') source.committedAt = '2025-01-01T00:00:00Z';
  if (overrides?.templateId !== undefined) source.templateId = overrides.templateId;
  if (author !== undefined) source.author = author;

  return source;
}

export function makeRights(overrides?: DeepPartial<EntryRights>): EntryRights {
  const status: RightsStatus = overrides?.status ?? 'redistributable';
  const defaultLicence = status === 'redistributable' ? 'MIT' : null;
  const defaultLicenceUrl =
    status === 'redistributable' ? 'https://spdx.org/licenses/MIT.html' : null;
  const defaultReason =
    status === 'redistributable'
      ? 'repo licence MIT - permitted for redistribution'
      : 'official n8n template - linked, not redistributed';

  return {
    status,
    licence:
      overrides && 'licence' in overrides
        ? (overrides.licence ?? null)
        : defaultLicence,
    licenceUrl:
      overrides && 'licenceUrl' in overrides
        ? (overrides.licenceUrl ?? null)
        : defaultLicenceUrl,
    reason: overrides?.reason ?? defaultReason,
  };
}

export function makeStructure(overrides?: DeepPartial<EntryStructure>): EntryStructure {
  const structure: EntryStructure = {
    nodeCount: overrides?.nodeCount ?? 2,
    rawNodeCount: overrides?.rawNodeCount ?? overrides?.nodeCount ?? 2,
    annotationNodeCount: overrides?.annotationNodeCount ?? 0,
    connectionCount: overrides?.connectionCount ?? 1,
    nodeTypes: overrides?.nodeTypes
      ? [...overrides.nodeTypes]
      : ['n8n-nodes-base.webhook', 'n8n-nodes-base.slack'],
    integrations: overrides?.integrations
      ? [...overrides.integrations]
      : ['webhook', 'slack'],
    trigger: overrides?.trigger ?? 'Webhook',
    isSubWorkflow: overrides?.isSubWorkflow ?? false,
    complexity: (overrides?.complexity as Complexity) ?? 'simple',
    hasCode: overrides?.hasCode ?? false,
    hasAI: overrides?.hasAI ?? false,
    hasWebhook: overrides?.hasWebhook ?? true,
  };
  if (overrides?.partial !== undefined) {
    structure.partial = overrides.partial;
  }
  return structure;
}

export function makeSecurity(overrides?: DeepPartial<EntrySecurity>): EntrySecurity {
  const baseCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  return {
    grade: (overrides?.grade as Grade) ?? 'LOW',
    score: overrides?.score ?? 100,
    counts: overrides?.counts ? { ...baseCounts, ...overrides.counts } : baseCounts,
    findings: overrides?.findings ? ([...overrides.findings] as PublicFinding[]) : [],
    hardenedExtra: overrides?.hardenedExtra ?? 0,
    scannerVersion: overrides?.scannerVersion ?? '1.0.0',
    profile: overrides?.profile ?? 'beta-default',
    schemaVersion: overrides?.schemaVersion ?? 'scanner-result-v1',
    // Absent means no verdict is published — the state that makes a row
    // historical or unscanned, so it must stay absent unless asked for.
    ...(overrides?.analysisStatus === undefined ? {} : { analysisStatus: overrides.analysisStatus }),
    // Why a no-body stamp was written. Also absent unless asked for: a row without
    // one has no recorded reason, which is a different state from "source gone".
    ...(overrides?.stampReason === undefined ? {} : { stampReason: overrides.stampReason }),
  };
}

export function makeEntry(overrides?: DeepPartial<Entry>): Entry {
  const id = overrides?.id ?? 'test-entry-1';
  const baseDedup: EntryDedup = {
    fingerprint: `fp-${id}`,
    structuralHash: `sh-${id}`,
    canonical: true,
    alsoFoundIn: [],
  };

  const entry: Entry = {
    id,
    slug: overrides?.slug ?? id,
    title: overrides?.title ?? `Workflow ${id}`,
    summary: overrides?.summary ?? `Summary for ${id}`,
    description: overrides?.description ?? `Description for ${id}`,
    descriptionSource: overrides?.descriptionSource ?? 'upstream',
    source: makeSource(overrides?.source),
    rights: makeRights(overrides?.rights),
    structure: makeStructure(overrides?.structure),
    security: makeSecurity(overrides?.security),
    tags: overrides?.tags ? [...overrides.tags] : ['automation'],
    dedup: overrides?.dedup
      ? {
          ...baseDedup,
          ...overrides.dedup,
          alsoFoundIn: overrides.dedup.alsoFoundIn
            ? [...overrides.dedup.alsoFoundIn]
            : baseDedup.alsoFoundIn,
        }
      : baseDedup,
  };

  if (overrides?.chartRef) {
    entry.chartRef = {
      shard: overrides.chartRef.shard ?? 0,
      offset: overrides.chartRef.offset ?? 0,
      length: overrides.chartRef.length ?? 0,
    };
  }
  if (overrides?.download) {
    entry.download = {
      pack: overrides.download.pack ?? 0,
      line: overrides.download.line ?? 0,
      offset: overrides.download.offset ?? 0,
      length: overrides.download.length ?? 0,
    };
  }
  if (overrides?.descriptionContent) {
    entry.descriptionContent = overrides.descriptionContent;
  }

  return entry;
}

export function makeCandidate(overrides?: DeepPartial<Candidate>): Candidate {
  const id = overrides?.id ?? 'test-candidate-1';
  const candidate: Candidate = {
    id,
    source: makeSource(overrides?.source),
    rights: makeRights(overrides?.rights),
    title: overrides?.title ?? `Workflow ${id}`,
    json:
      overrides?.json !== undefined
        ? overrides.json
        : {
            nodes: [{ id: '1', name: 'Start', type: 'n8n-nodes-base.start' }],
            connections: {},
          },
    bytes: overrides?.bytes ?? 500,
  };

  if (overrides && 'upstreamDescription' in overrides) {
    candidate.upstreamDescription = overrides.upstreamDescription;
  }
  if (overrides && 'blobSha' in overrides) {
    candidate.blobSha = overrides.blobSha;
  }

  return candidate;
}

export function makeChart(overrides?: DeepPartial<WorkflowChart>): WorkflowChart {
  return {
    nodes: overrides?.nodes
      ? (overrides.nodes as ChartNode[])
      : [{ id: '1', name: 'Start', type: 'n8n-nodes-base.start', x: 0, y: 0 }],
    edges: overrides?.edges ? (overrides.edges as ChartEdge[]) : [],
  };
}

export function makeEntryWithChart(
  entryOverrides?: DeepPartial<Entry>,
  chartOverrides?: DeepPartial<WorkflowChart>,
): EntryWithChart {
  return {
    entry: makeEntry(entryOverrides),
    chart: makeChart(chartOverrides),
  };
}
