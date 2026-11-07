/**
 * Shared pipeline contracts. Owned by the orchestrator (PLAN.md §5, §7).
 *
 * Every pipeline stage consumes and produces these shapes. Do not widen, narrow,
 * or add fields here as part of a delegated task — propose the change instead.
 */

import type { EntryRights } from './rights';
import type { EntrySecurity } from './security';

export type SourceKind = 'github' | 'n8n_official';

export type Complexity = 'simple' | 'medium' | 'complex';

/** A curated entry in `pipeline/sources.json`. Registry is hand-reviewed (ACQ-1). */
export type SourceDef = {
  key: string;
  kind: SourceKind;
  /** "owner/repo" for github sources; absent for the official API. */
  repo?: string;
  branch?: string;
  /** Globs, relative to the repo root. Empty `include` means "every .json". */
  include: string[];
  exclude: string[];
  /** What we expect the licence to be; acquisition records what it actually is. */
  expectedLicence: string | null;
  status: 'active' | 'excluded';
  /** Why this source is in the registry, or why it was excluded. */
  note: string;
  /** Withhold redistribution from this source whatever its LICENSE says; see `sources.json`. */
  redistribute?: false;
  reviewedAt: string;
};

export type EntrySource = {
  kind: SourceKind;
  repo?: string;
  owner?: string;
  stars?: number;
  path?: string;
  commit?: string;
  /** ISO commit date. Dedup uses it as the "more recent wins" tie-break. */
  committedAt?: string;
  /** Immutable deep link: blob/<sha>/<path> for github, n8n.io/workflows/<id> for official. */
  permalink: string;
  templateId?: number;
  author?: { name: string; username?: string; url?: string };
  fetchedAt: string;
};

export type EntryStructure = {
  /**
   * Nodes that do work. Sticky notes and no-op placeholders are excluded,
   * because every band, facet, and score derived from this number was
   * overstated while they counted. This is the number to display and rank on.
   */
  nodeCount: number;
  /** Every entry in `nodes`, annotations included. Provenance; label it if shown. */
  rawNodeCount: number;
  /** Nodes excluded from `nodeCount`: sticky notes and no-op placeholders. */
  annotationNodeCount: number;
  connectionCount: number;
  nodeTypes: string[];
  integrations: string[];
  trigger: string;
  /** True when only a parent workflow can start this one; it does nothing imported alone. */
  isSubWorkflow: boolean;
  complexity: Complexity;
  hasCode: boolean;
  hasAI: boolean;
  hasWebhook: boolean;
  /** True when derived from official search metadata because the JSON was unavailable. */
  partial?: boolean;
};

/** What kind of hardcoded value a "must replace before running" entry is. */
export type ReplaceableValueKind = 'url' | 'email' | 'phone' | 'chat_id' | 'sheet_id' | 'id';

/**
 * A single hardcoded value the importer must replace before the workflow will
 * work for them. Never carries the value itself — this reaches a public page.
 */
export type ReplaceableValue = {
  /** The node's display name (`node.name`), never its internal id. */
  node: string;
  /** Dot/bracket path to the value inside that node's `parameters`, e.g. `options.chatId`. */
  field: string;
  kind: ReplaceableValueKind;
};

export type ReadinessAiModel = {
  present: boolean;
  /** Model string found on an AI node's parameters, e.g. `gpt-4o-mini`. Null when no AI node is present, or one is present but does not pin a model in the file. */
  model: string | null;
};

export type ReadinessPinnedData = {
  present: boolean;
  /** Number of keys in `workflow.pinData`, i.e. how many nodes ship pinned sample data. */
  nodeCount: number;
};

/**
 * How a readiness report was produced.
 *
 * `derived` means every list below was computed from a workflow body.
 * `unscanned` means no workflow JSON was available for this entry, so the
 * lists are *unknown* rather than empty: an empty `credentials` list only ever
 * means "this workflow needs no credentials" when the report is `derived`.
 * The two states are published separately because a false-clean "requires
 * nothing to set up" claim is worse than an admitted gap.
 */
export type ReadinessAnalysis = 'derived' | 'unscanned';

/** Published with every `unscanned` readiness report, so the reason travels with the entry. */
export const READINESS_UNSCANNED_DISCLAIMER =
  'No workflow JSON was available for analysis, so credential and setup readiness for this entry is unknown, not confirmed absent. Review the upstream workflow before importing.';

/**
 * Phase 6.1 readiness report: what a reader needs to know before importing a
 * workflow, computed deterministically from the JSON, never model-written.
 * See `phase-6-content-depth.md` §2a for the row-by-row source of truth.
 */
export type EntryReadiness = {
  /**
   * `derived` when a workflow body produced this report, `unscanned` when none
   * was available. Optional in the type only so a pre-regeneration artifact
   * still parses; every shipped entry carries it, and the corpus freshness gate
   * requires it. Absent is never read as `derived`.
   */
  analysis?: ReadinessAnalysis;
  /** Human product names (e.g. "Google Sheets"), deduped and sorted, from every functional node's `credentials` keys. */
  credentials: string[];
  /** Hardcoded values a reader must replace before running the workflow. */
  replaceableValues: ReplaceableValue[];
  /** Human descriptions of write/send actions performed (e.g. "sends Telegram messages"), deduped and sorted. */
  writeActions: string[];
  aiModel: ReadinessAiModel;
  /** Node type packages outside `n8n-nodes-base.*` and `@n8n/*`, sorted. Empty means every node ships with n8n. */
  extraPackages: string[];
  /** Legacy signals: `$node[...]` expressions, the legacy Function node, notable `typeVersion` values. */
  versionNotes: string[];
  pinnedData: ReadinessPinnedData;
  /** True when only a parent workflow can start this one; it does nothing imported alone. */
  isSubWorkflow: boolean;
};

export type N8nCompatibility = {
  targetVersion: string;
  checkedAt: string;
  source: string;
  status: 'likely-compatible' | 'review-required' | 'unknown';
  reasons: string[];
  blockers: string[];
};

/** A host we know the workflow calls, reached through a templated URL. */
export type DynamicHost = { host: string };

/**
 * Hostnames a workflow actually contacts.
 *
 * `integrations` is derived from node types, so an `httpRequest` to
 * `api.stripe.com` reads only as "HTTP Request" and the Stripe dependency is
 * invisible. Literal and dynamic are never conflated, and a URL whose host is
 * itself templated is counted as undeterminable rather than guessed. Only the
 * hostname is ever stored: paths and query strings carry secrets.
 */
export type HostnameExtraction = {
  literal: string[];
  dynamic: DynamicHost[];
  undeterminable: number;
};

export type {
  EntrySecurity,
  Grade,
  PublicFinding,
  Severity,
} from './security';

export type ChartNode = { id: string; name: string; type: string; x: number; y: number; isAnnotation?: boolean };
export type ChartEdge = { from: string; to: string; kind: string };

/** Chart payload, stored out-of-line in data/charts/. `unresolvedEdgeCount`: connections naming a node the file does not contain. */
export type WorkflowChart = { nodes: ChartNode[]; edges: ChartEdge[]; unresolvedEdgeCount?: number };

/**
 * Where an entry's chart lives. Charts measured 5-8 KB each on real workflows, so
 * inlining them would put 15k entries at ~135 MB of shard. The detail page fetches
 * one chart with a byte-range request; the library never loads any.
 */
export type ChartRef = { shard: number; offset: number; length: number };

/**
 * What a pipeline stage carries between derivation and packaging: the entry plus
 * its chart, still together. Packaging (ENR-7) writes the chart to a chart shard,
 * fills `entry.chartRef`, and drops the payload.
 */
export type EntryWithChart = { entry: Entry; chart: WorkflowChart };

export type EntryDedup = {
  fingerprint: string;
  structuralHash: string;
  canonical: boolean;
  duplicateOf?: string;
  /** Permalinks of the other places this workflow was found. */
  alsoFoundIn: string[];
};

export type EntryDownload = {
  pack: number; line: number; offset: number; length: number;
  sha256?: string; // AUDIT-DL-001: packed record hash, no trailing newline. Optional; authoritative when present.
};

/** Public provenance for the human-facing description, never inferred by the UI. */
export type DescriptionProvenance = {
  /** `unknown` is used when legacy metadata cannot be proven; it is not publishable as generated content. */
  source: 'gemini' | 'upstream' | 'fallback' | 'unknown';
  model?: string;
  promptVersion?: string;
  promptHash?: string; schemaVersion?: string; workflowHash?: string; generatedAt?: string;
};

/** Structured, model-written explanation. Deterministic readiness/security facts stay outside this object. */
export type GeneratedDescription = {
  headline: string;
  summary: string;
  outcome: string;
  beforeAfter: { before: string; after: string };
  exampleScenario: string;
  howItWorks: string[];
  limitations: string[];
  audience: string;
};

export type Entry = {
  id: string;
  slug: string;
  /** True when the static export contains a dedicated `/w/<slug>/` page. */
  isPrerendered?: boolean;
  title: string;
  summary: string;
  description: string;
  descriptionSource: 'upstream' | 'generated' | 'fallback';
  descriptionProvenance?: DescriptionProvenance;
  descriptionContent?: GeneratedDescription;
  source: EntrySource;
  rights: EntryRights;
  structure: EntryStructure;
  /**
   * What a reader needs to know before importing. Deterministic, never
   * model-written. Optional only because link-only entries acquired from
   * metadata alone have no workflow JSON to analyse — when that is the reason,
   * it is absent rather than defaulted to an empty report, which would read as
   * "nothing to set up".
   */
  readiness?: EntryReadiness;
  /** Deterministic static compatibility assessment; never an execution guarantee. */
  compatibility?: N8nCompatibility;
  /** Hostnames the workflow actually calls, which node types alone do not reveal. */
  hostnames?: HostnameExtraction;
  security: EntrySecurity;
  tags: string[];
  chartRef?: ChartRef;
  dedup: EntryDedup;
  download?: EntryDownload;
};

export {
  TAG_GROUPS,
  discoveryFields,
  normalizeDiscoveryFilterValue,
  normalizeDiscoverySlug,
  normalizeTaxonomyFilterValue,
  normalizeTaxonomyValue,
  toNormalizedTag,
  toSearchDisplayItem,
  type FacetCounts,
  type FacetData,
  type NormalizedTag,
  type SearchDisplayItem,
  type TagGroup,
  type TaxonomyGroup,
} from './discovery';
export { SEARCH_BOOSTS, SEARCH_FIELDS, SEARCH_OPTIONS, SEARCH_STORE_FIELDS, qualityScore } from './search-config';
export {
  SEMANTIC_DIMENSIONS,
  buildSemanticVector,
  cosineSimilarity,
  isSemanticVector,
  normalizeSemanticVector,
  type SemanticDocument,
  type SemanticIndex,
  type SemanticSearchText,
} from './semantic-search';
export { SEARCH_ALIASES, aliasesFor } from './search-aliases';
export { SCANNER_RESULT_SCHEMA_VERSION, parseScannerResultSchemaVersion, type ScannerResultIdentity, type ScannerResultSchemaVersion } from './scanner-result';
/**
 * A workflow the pipeline has acquired but not yet turned into an Entry.
 * `json` is the parsed workflow; it is dropped before an Entry is emitted for
 * link-only sources and packed separately for redistributable ones.
 */
export type Candidate = {
  id: string;
  source: EntrySource;
  rights: EntryRights;
  title: string;
  /** Description supplied by the upstream source, if any. */
  upstreamDescription?: string;
  json: unknown;
  bytes: number;
  blobSha?: string;
};

export type RejectReason =
  | 'too_large'
  | 'invalid_json'
  | 'not_a_workflow'
  | 'empty_nodes'
  | 'sanitize_failed'
  | 'scan_failed'
  | 'fetch_failed' | 'rights_evidence_missing';

export type Reject = {
  sourceKey: string;
  path: string;
  reason: RejectReason;
  detail?: string;
};

/** Stage names, in pipeline order. Used by the resume ledger (ACQ-8). */
export const STAGES = ['acquire', 'rights', 'sanitize', 'scan', 'dedup', 'enrich'] as const;
export type Stage = (typeof STAGES)[number];

export type StageRecord = {
  entryId: string;
  stage: Stage;
  ok: boolean;
  code?: string;
  /** Hashes of the stage input and validated stage output; either mismatch forces a re-run. */
  inputHash: string; outputHash: string;
};

export { RIGHTS_STATUSES, isKnownRightsStatus, assertKnownRightsStatus, type RightsStatus, type EntryRights } from './rights';
export { createExclusionRegistry, appendExclusion, EMPTY_EXCLUSION_REGISTRY, type ExclusionRecord, type ExclusionRegistry } from './exclusion-registry';
export { LIMITS, REDISTRIBUTABLE_LICENCES } from './limits';
export { DEFAULT_SCANNER_LIMITS, SCANNER_LIMITS_SCHEMA_VERSION, serializeScannerLimits, toWorkflowParseOptions, validateScannerLimits, type ScannerLimitsV1, type ScannerLimitsValidationResult } from './scanner-limits';
export { DEFAULT_SCANNER_LIMITS_V2, ADMITTED_LIMIT_STATES, MEASURED_LIMIT_IDS, SCANNER_LIMITS_V2_SCHEMA_VERSION, toWorkflowParseOptionsV2, validateScannerLimitsV2, type AdmittedLimitStateV2, type ScannerLimitNameV2, type ScannerLimitsV2, type ScannerLimitsV2ValidationResult } from './scanner-limits-v2';
export type { CorpusAnalytics, CountedLabel, GradeComplexityCell, NodeCountBin, NodeCoverage, NodeCoverageUnknownType, NodeCoverageVersionRow, PolicyRow, ScanCoverage, V2AnalyticsEvidence, V2AnalyticsIdentity } from './corpus-analytics';
export { isIndexable, isSearchable, indexableEntries, rankedIndexableEntries, rankedSearchableEntries, type IndexableEntry } from './indexability';
export { PRERENDER_DETAIL_LIMIT_DEFAULT, resolvePrerenderLimit } from './prerender-limit';
export { compactCoordinates, type CompactablePoint, type CompactCoordinatesOptions } from './compact-coordinates';
export {
  classifyCategory,
  computeGraphLayout,
  type GraphLayout,
  type LayoutEdge,
  type LayoutNode,
  type NodeCategory,
} from './graph-layout';
export { SVG_PREVIEW_SCHEMA_VERSION, parseSvgPreviewArtifact,
  type SvgPreview, type SvgPreviewArtifact, type SvgPreviewListItem, type SvgPreviewTier,
} from './svg-preview';
