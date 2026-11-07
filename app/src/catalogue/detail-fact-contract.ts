/**
 * Typed, synthetic documentation of the facts the workflow-detail surfaces may render.
 * `entry.*` keys are Entry paths; `detail.*` and `preview.*` are component-owned inputs.
 * This is a contract ledger, not a second data model and it never supplies values.
 */
export const DETAIL_FACT_FAMILIES = ['content', 'rights', 'provenance', 'security', 'structure', 'readiness', 'canvas', 'related'] as const;
export type DetailFactFamily = (typeof DETAIL_FACT_FAMILIES)[number];
export type DetailFactSource = 'acquired' | 'derived' | 'policy' | 'unknown';
export type DetailFactNullability = 'required' | 'optional' | 'nullable' | 'unavailable';
export type DetailFactAuthority = 'source' | 'deterministic' | 'policy' | 'non-authoritative-prose' | 'unknown';
export type DetailFactRightsExposure = 'public' | 'link_only' | 'not_public';
export type DetailFactFreshness = 'acquisition' | 'derivation' | 'scan' | 'release' | 'unknown';
export type DetailFactKey =
  | 'entry.title' | 'entry.summary' | 'entry.description' | 'entry.descriptionSource' | 'entry.descriptionContent' | 'entry.descriptionProvenance'
  | 'entry.rights.status' | 'entry.rights.licence' | 'entry.rights.licenceUrl' | 'entry.rights.reason' | 'detail.workflow-body' | 'detail.primary-action'
  | 'entry.source.kind' | 'entry.source.permalink' | 'entry.source.repo' | 'entry.source.author' | 'entry.source.fetchedAt' | 'entry.source.path' | 'entry.source.commit' | 'entry.source.stars'
  | 'entry.security.grade' | 'entry.security.score' | 'entry.security.counts' | 'entry.security.findings' | 'entry.security.profile' | 'entry.security.scannerVersion' | 'entry.security.analysisStatus'
  | 'entry.structure.nodeCount' | 'entry.structure.rawNodeCount' | 'entry.structure.annotationNodeCount' | 'entry.structure.connectionCount' | 'entry.structure.trigger' | 'entry.structure.complexity' | 'entry.structure.integrations' | 'entry.tags' | 'entry.structure.partial'
  | 'entry.readiness' | 'entry.readiness.credentials' | 'entry.readiness.replaceableValues' | 'entry.readiness.writeActions' | 'entry.readiness.aiModel' | 'entry.readiness.extraPackages' | 'entry.readiness.versionNotes' | 'entry.hostnames' | 'entry.readiness.pinnedData' | 'entry.readiness.isSubWorkflow' | 'entry.compatibility'
  | 'entry.chartRef' | 'preview.tier' | 'preview.svg' | 'preview.nodeList' | 'preview.unresolvedEdgeCount' | 'detail.canvas.action'
  | 'detail.related' | 'entry.dedup.alsoFoundIn';

export type DetailFactRow = Readonly<{
  key: DetailFactKey;
  family: DetailFactFamily;
  source: DetailFactSource;
  nullability: DetailFactNullability;
  authority: DetailFactAuthority;
  rightsExposure: DetailFactRightsExposure;
  freshness: DetailFactFreshness;
  label: string;
  fallback: string;
}>;

export const DETAIL_FACT_CONTRACT_PRINCIPLES = Object.freeze([
  'Provenance is never inferred from a URL, repository name, slug, author-like text, or model prose.',
  'Unknown is not false or zero; an absent report never means safe, empty, compatible, or ready.',
  'Rights exposure controls body and action surfaces: link-only records retain a source link, while excluded records have no body action.',
  'Model-written prose is non-authoritative; licences, authors, security verdicts, counts, and links render from explicit pipeline fields.',
] as const);

const ROWS = [
  { key: 'entry.title', family: 'content', source: 'acquired', nullability: 'required', authority: 'source', rightsExposure: 'public', freshness: 'acquisition', label: 'Title', fallback: 'No title is published; do not derive one from the id or slug.' },
  { key: 'entry.summary', family: 'content', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'derivation', label: 'Purpose summary', fallback: 'A title-derived summary is only a limited fallback, not additional purpose evidence.' },
  { key: 'entry.description', family: 'content', source: 'acquired', nullability: 'required', authority: 'source', rightsExposure: 'public', freshness: 'acquisition', label: 'Description', fallback: 'Upstream prose is shown only when its source is explicit; unverified prose is withheld.' },
  { key: 'entry.descriptionSource', family: 'content', source: 'policy', nullability: 'required', authority: 'policy', rightsExposure: 'public', freshness: 'release', label: 'Description provenance', fallback: 'Unknown or fallback prose is labeled and never upgraded to trusted content.' },
  { key: 'entry.descriptionContent', family: 'content', source: 'derived', nullability: 'optional', authority: 'non-authoritative-prose', rightsExposure: 'public', freshness: 'release', label: 'Structured explanation', fallback: 'No publishable structured prose; deterministic facts remain authoritative.' },
  { key: 'entry.descriptionProvenance', family: 'content', source: 'acquired', nullability: 'optional', authority: 'source', rightsExposure: 'public', freshness: 'release', label: 'Generation details', fallback: 'Provenance is unknown; do not infer a model, prompt, or source.' },
  { key: 'entry.rights.status', family: 'rights', source: 'policy', nullability: 'required', authority: 'policy', rightsExposure: 'public', freshness: 'release', label: 'Rights', fallback: 'Reject an unknown status; never default it to redistributable.' },
  { key: 'entry.rights.licence', family: 'rights', source: 'acquired', nullability: 'nullable', authority: 'source', rightsExposure: 'public', freshness: 'acquisition', label: 'Licence', fallback: 'Show Unlicensed/unknown when absent; never infer a licence from a repository or code.' },
  { key: 'entry.rights.licenceUrl', family: 'rights', source: 'acquired', nullability: 'nullable', authority: 'source', rightsExposure: 'public', freshness: 'acquisition', label: 'Licence link', fallback: 'No licence link is published when unavailable; do not construct one.' },
  { key: 'entry.rights.reason', family: 'rights', source: 'acquired', nullability: 'required', authority: 'source', rightsExposure: 'public', freshness: 'acquisition', label: 'Rights evidence', fallback: 'Show the recorded evidence reason without turning it into a legal conclusion.' },
  { key: 'detail.workflow-body', family: 'rights', source: 'derived', nullability: 'optional', authority: 'policy', rightsExposure: 'public', freshness: 'release', label: 'Workflow body availability', fallback: 'Redistributable may include a body; link-only withholds it; excluded has no body.' },
  { key: 'detail.primary-action', family: 'rights', source: 'policy', nullability: 'required', authority: 'policy', rightsExposure: 'public', freshness: 'release', label: 'Primary action', fallback: 'Redistributable means download; link-only means source link; excluded means no body action.' },
  { key: 'entry.source.kind', family: 'provenance', source: 'acquired', nullability: 'required', authority: 'source', rightsExposure: 'public', freshness: 'acquisition', label: 'Source type', fallback: 'Unknown source type; do not infer official or community status.' },
  { key: 'entry.source.permalink', family: 'provenance', source: 'acquired', nullability: 'required', authority: 'source', rightsExposure: 'public', freshness: 'acquisition', label: 'Source', fallback: 'No source link; do not fabricate a repository or official URL.' },
  { key: 'entry.source.repo', family: 'provenance', source: 'acquired', nullability: 'optional', authority: 'source', rightsExposure: 'public', freshness: 'acquisition', label: 'Repository', fallback: 'GitHub is not assumed when a repository name is absent.' },
  { key: 'entry.source.author', family: 'provenance', source: 'acquired', nullability: 'optional', authority: 'source', rightsExposure: 'public', freshness: 'acquisition', label: 'Author', fallback: 'Unknown author; never substitute the repository owner or infer authorship.' },
  { key: 'entry.source.fetchedAt', family: 'provenance', source: 'acquired', nullability: 'required', authority: 'source', rightsExposure: 'public', freshness: 'acquisition', label: 'Fetched', fallback: 'Unknown fetch date; never use the current date as a substitute.' },
  { key: 'entry.source.path', family: 'provenance', source: 'acquired', nullability: 'optional', authority: 'source', rightsExposure: 'not_public', freshness: 'acquisition', label: 'Path', fallback: 'Not published on the detail page; unknown if absent and never inferred from a URL or slug.' },
  { key: 'entry.source.commit', family: 'provenance', source: 'acquired', nullability: 'optional', authority: 'source', rightsExposure: 'not_public', freshness: 'acquisition', label: 'Commit', fallback: 'Not published on the detail page; unknown if absent and never inferred from a branch or URL.' },
  { key: 'entry.source.stars', family: 'provenance', source: 'acquired', nullability: 'optional', authority: 'source', rightsExposure: 'not_public', freshness: 'acquisition', label: 'Stars', fallback: 'Not published; unknown is not zero and no popularity claim is made.' },
  { key: 'entry.security.grade', family: 'security', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Security grade', fallback: 'Use UNKNOWN for indeterminate analysis; never render missing analysis as LOW or safe.' },
  { key: 'entry.security.score', family: 'security', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Security score', fallback: 'A zero or absent score is not proof of a clean result when analysis is unknown.' },
  { key: 'entry.security.counts', family: 'security', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Finding counts', fallback: 'Zero means no reported findings only when analysis is complete; otherwise disclose uncertainty.' },
  { key: 'entry.security.findings', family: 'security', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Findings', fallback: 'An empty list is not a safety guarantee when analysis is degraded or indeterminate.' },
  { key: 'entry.security.profile', family: 'security', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'release', label: 'Scanner profile', fallback: 'Show the recorded profile; never infer a stronger profile.' },
  { key: 'entry.security.scannerVersion', family: 'security', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'release', label: 'Scanner version', fallback: 'Unknown scanner identity; do not imply current validation.' },
  { key: 'entry.security.analysisStatus', family: 'security', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Analysis completeness', fallback: 'An absent status is legacy/unknown; never upgrade it to complete.' },
  { key: 'entry.structure.nodeCount', family: 'structure', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Active nodes', fallback: 'Unknown structure is not zero nodes.' },
  { key: 'entry.structure.rawNodeCount', family: 'structure', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Total nodes', fallback: 'Use unknown when raw structure is unavailable; do not collapse missing data to zero.' },
  { key: 'entry.structure.annotationNodeCount', family: 'structure', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Annotations', fallback: 'Do not infer annotation count from active nodes.' },
  { key: 'entry.structure.connectionCount', family: 'structure', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Connections', fallback: 'Unknown connections stay unknown; do not assume zero.' },
  { key: 'entry.structure.trigger', family: 'structure', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Trigger', fallback: 'Show Unknown when no trigger was established; do not infer one from prose.' },
  { key: 'entry.structure.complexity', family: 'structure', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'derivation', label: 'Complexity', fallback: 'Unknown complexity; do not infer it from a title or a partial graph.' },
  { key: 'entry.structure.integrations', family: 'structure', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'derivation', label: 'Integrations', fallback: 'Show only detected integrations; do not infer service use from prose.' },
  { key: 'entry.tags', family: 'structure', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'derivation', label: 'Tags', fallback: 'No tags; do not generate them from unverified prose.' },
  { key: 'entry.structure.partial', family: 'structure', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Structure completeness', fallback: 'Partial or unknown structure triggers a not-ready warning; absence never means complete.' },
  { key: 'entry.readiness', family: 'readiness', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Readiness report', fallback: 'No report means not ready based on published data; never default to an empty report.' },
  { key: 'entry.readiness.credentials', family: 'readiness', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Required credentials', fallback: 'Unknown credentials; publish names only and never expose values.' },
  { key: 'entry.readiness.replaceableValues', family: 'readiness', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Values to replace', fallback: 'Unknown setup values; never expose literal secret-like values.' },
  { key: 'entry.readiness.writeActions', family: 'readiness', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Write / mutating actions', fallback: 'Unknown actions; do not infer safety from an absent list.' },
  { key: 'entry.readiness.aiModel', family: 'readiness', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'AI / LLM model', fallback: 'No model claim when not pinned; do not infer one from a node name.' },
  { key: 'entry.readiness.extraPackages', family: 'readiness', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Extra node packages', fallback: 'Unknown community-node requirements; do not assume core support.' },
  { key: 'entry.readiness.versionNotes', family: 'readiness', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Version and legacy notes', fallback: 'Compatibility is unknown when evidence is absent; do not infer it from omission.' },
  { key: 'entry.hostnames', family: 'readiness', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'External hosts contacted', fallback: 'Unknown hosts remain unknown; do not infer domains from integration labels.' },
  { key: 'entry.readiness.pinnedData', family: 'readiness', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Pinned data', fallback: 'Unknown pinned-data state; an absent report is not no pinned data.' },
  { key: 'entry.readiness.isSubWorkflow', family: 'readiness', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'scan', label: 'Standalone importability', fallback: 'Unknown start behavior; do not claim that an entry runs alone.' },
  { key: 'entry.compatibility', family: 'readiness', source: 'policy', nullability: 'optional', authority: 'policy', rightsExposure: 'public', freshness: 'release', label: 'Compatibility notes', fallback: 'Unknown unless versioned evidence exists; this is not a completed execution test.' },
  { key: 'entry.chartRef', family: 'canvas', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'release', label: 'Interactive canvas data', fallback: 'Interactive canvas unavailable; retain the static/text surface and do not promise interaction.' },
  { key: 'preview.tier', family: 'canvas', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'release', label: 'Preview tier', fallback: 'Static preview unavailable; use the finite text fallback and never synthesize a graph.' },
  { key: 'preview.svg', family: 'canvas', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'release', label: 'Workflow overview', fallback: 'No SVG is published when preview validation fails.' },
  { key: 'preview.nodeList', family: 'canvas', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'release', label: 'Workflow node list', fallback: 'No node list when the preview is invalid; do not infer nodes from metrics.' },
  { key: 'preview.unresolvedEdgeCount', family: 'canvas', source: 'derived', nullability: 'required', authority: 'deterministic', rightsExposure: 'public', freshness: 'release', label: 'Unresolved connections', fallback: 'Unknown resolution remains disclosed; never hide unresolved connections.' },
  { key: 'detail.canvas.action', family: 'canvas', source: 'policy', nullability: 'required', authority: 'policy', rightsExposure: 'public', freshness: 'release', label: 'Explore interactive canvas', fallback: 'Show the action only when bounded chart data can load; otherwise explain the static fallback.' },
  { key: 'detail.related', family: 'related', source: 'derived', nullability: 'optional', authority: 'deterministic', rightsExposure: 'public', freshness: 'release', label: 'Related workflows', fallback: 'Show deterministic eligible links; an empty/error state says none are available and never invents alternatives.' },
  { key: 'entry.dedup.alsoFoundIn', family: 'related', source: 'acquired', nullability: 'optional', authority: 'source', rightsExposure: 'public', freshness: 'acquisition', label: 'Same workflow also appears in', fallback: 'No duplicate links are shown; do not infer duplicates from a matching title.' },
] as const satisfies readonly DetailFactRow[];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const DETAIL_FACT_CONTRACT: readonly DetailFactRow[] = deepFreeze(ROWS);
