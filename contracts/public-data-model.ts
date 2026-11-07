import { PUBLIC_PREFLIGHT_RELATION_NAMES } from './public-preflight-vocabulary';
import type { PublicPreflightCoverageRow, PublicPreflightEvidenceRow } from './public-preflight-data';

/** Versioned allowlist for public release exports: v2 added scan evidence, v3 adds NO_RESULT. */
export const PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3 = 'public-data-model-v3' as const;
export const PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4 = 'public-data-model-v4' as const;
export const PUBLIC_DATA_MODEL_SCHEMA_VERSION = PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3;

/** Predecessor identities, still readable by the versioned reader. */
export const PUBLIC_DATA_MODEL_SCHEMA_VERSION_V2 = 'public-data-model-v2' as const;
export const PUBLIC_DATA_MODEL_SCHEMA_VERSION_V1 = 'public-data-model-v1' as const;

/** Relation order is part of the deterministic release format contract. */
export const PUBLIC_RELATION_NAMES = [
  'releases',
  'workflows',
  'sources',
  'findings',
  'integrations',
  'tags',
  'triggers',
  'workflowIntegrations',
  'workflowTags',
  'workflowTriggers',
  'credentials',
  'domains',
  'communityNodes',
  'requirements',
  'exclusions',
  'artifacts',
] as const;

export type PublicRelationName = (typeof PUBLIC_RELATION_NAMES)[number];
export const PUBLIC_RELATION_NAMES_V4 = [...PUBLIC_RELATION_NAMES, ...PUBLIC_PREFLIGHT_RELATION_NAMES] as const;
export type PublicRelationNameV4 = (typeof PUBLIC_RELATION_NAMES_V4)[number];
export type PublicSha256 = string;
export type PublicIsoDate = string;
export type PublicRightsStatus = 'redistributable' | 'link_only' | 'excluded';
export type PublicAuthority = 'deterministic' | 'source' | 'non-authoritative-prose';
export type PublicGrade = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
export type PublicComplexity = 'simple' | 'medium' | 'complex' | 'unknown';
export type PublicCompleteness = 'complete' | 'partial' | 'unknown';
export type PublicSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

/** Keeps unknown and not-applicable distinct from a known false/zero value. */
export type PublicFact<T> =
  | { status: 'known'; value: T }
  | { status: 'unknown' | 'not-applicable'; value: null };

/** Row freshness from the row's own evidence; rights answer a different question. */
export const PUBLIC_SCAN_FRESHNESS_VALUES = ['CURRENT', 'NO_RESULT', 'HISTORICAL', 'UNSCANNED', 'SOURCE_UNAVAILABLE'] as const;
export type PublicScanFreshness = (typeof PUBLIC_SCAN_FRESHNESS_VALUES)[number];

/** Row scan provenance: producing engine, status, freshness and the digest of bytes actually read. */
export type PublicWorkflowScanEvidence = {
  scannerVersion: string | null;
  analysisStatus: 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE' | null;
  scanFreshness: PublicScanFreshness;
  scanBodySha256: string | null;
};

/** A body is never inline public JSON; it is either a permitted artifact reference or absent. */
export type PublicBodyReference =
  | { kind: 'path'; path: string; sha256: PublicSha256 }
  | { kind: 'hash'; sha256: PublicSha256 };

export type PublicReleaseCounts = {
  workflows: number;
  redistributable: number;
  linkOnly: number;
  excluded: number;
  findings: number;
};

export type PublicReleaseMetadata = {
  releaseId: string;
  schemaVersion: typeof PUBLIC_DATA_MODEL_SCHEMA_VERSION;
  generatedAt: PublicIsoDate;
  toolVersion: string;
  scannerVersion: string;
  policyVersion: string;
  searchIndexVersion: string;
  buildRevision: string;
  manifestSha256: PublicSha256;
  corpusSha256: PublicSha256;
  counts: PublicReleaseCounts;
  facetCounts: { rights: Pick<PublicReleaseCounts, 'redistributable' | 'linkOnly' | 'excluded'> };
};

export type PublicReleaseRow = PublicReleaseMetadata;

/** Public source allowlist: links and licence facts only, never acquisition internals. */
export type PublicSourceRow = {
  sourceId: string;
  kind: 'official' | 'community';
  publicUrl: string;
  repositoryUrl: string | null;
  licence: string | null;
  licenceUrl: string | null;
};

export type PublicWorkflowRow = {
  workflowId: string;
  title: string;
  description: string | null;
  descriptionAuthority: Extract<PublicAuthority, 'source' | 'non-authoritative-prose'> | 'unknown';
  sourceId: string;
  rightsStatus: PublicRightsStatus;
  body: PublicBodyReference | null;
  grade: PublicFact<Exclude<PublicGrade, 'UNKNOWN'>>;
  score: PublicFact<number>;
  completeness: PublicCompleteness;
  complexity: PublicComplexity;
  nodeCount: number;
  connectionCount: number;
  readinessStatus: 'known' | 'unknown' | 'not-applicable';
  scanEvidence: PublicWorkflowScanEvidence;
};

/** A v1 row as shipped: every v2 field, minus the row's own scan evidence. */
export type PublicWorkflowRowV1 = Omit<PublicWorkflowRow, 'scanEvidence'>;

/** Findings contain stable policy facts and remediation, never evidence or secret values. */
export type PublicFindingRow = {
  findingId: string;
  workflowId: string;
  policyId: string;
  severity: PublicSeverity;
  category: string;
  effect: string;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  title: string;
  remediation: string;
};

export type PublicNamedValueRow = { id: string; label: string };
export type PublicIntegrationRow = PublicNamedValueRow;
export type PublicTagRow = PublicNamedValueRow;
export type PublicTriggerRow = PublicNamedValueRow;
export type PublicCredentialRow = PublicNamedValueRow;
export type PublicDomainRow = { id: string; hostname: string };
export type PublicCommunityNodeRow = { id: string; packageName: string };

export type PublicWorkflowIntegrationRow = { workflowId: string; integrationId: string };
export type PublicWorkflowTagRow = { workflowId: string; tagId: string };
export type PublicWorkflowTriggerRow = { workflowId: string; triggerId: string };

export type PublicRequirementRow = {
  requirementId: string;
  workflowId: string;
  kind: 'credential' | 'domain' | 'community-node' | 'replaceable-value' | 'version';
  label: string;
  status: 'required' | 'optional' | 'unknown';
};

export type PublicExclusionRow = {
  exclusionId: string;
  workflowId: string | null;
  status: 'excluded';
  reasonCode: string;
  publicReference: string | null;
};

export type PublicArtifactRow = {
  artifactId: string;
  releaseId: string;
  relation: PublicRelationName;
  format: 'ndjson' | 'sqlite' | 'xlsx' | 'json';
  path: string;
  sha256: PublicSha256;
  byteSize: number;
  rightsStatus: PublicRightsStatus;
};

/** Complete format-independent projection; writers consume this allowlisted shape only. */
export type PublicDataProjection = {
  schemaVersion: typeof PUBLIC_DATA_MODEL_SCHEMA_VERSION;
  release: PublicReleaseMetadata;
  releases: readonly PublicReleaseRow[];
  workflows: readonly PublicWorkflowRow[];
  sources: readonly PublicSourceRow[];
  findings: readonly PublicFindingRow[];
  integrations: readonly PublicIntegrationRow[];
  tags: readonly PublicTagRow[];
  triggers: readonly PublicTriggerRow[];
  workflowIntegrations: readonly PublicWorkflowIntegrationRow[];
  workflowTags: readonly PublicWorkflowTagRow[];
  workflowTriggers: readonly PublicWorkflowTriggerRow[];
  credentials: readonly PublicCredentialRow[];
  domains: readonly PublicDomainRow[];
  communityNodes: readonly PublicCommunityNodeRow[];
  requirements: readonly PublicRequirementRow[];
  exclusions: readonly PublicExclusionRow[];
  artifacts: readonly PublicArtifactRow[];
};

export type PublicReleaseMetadataV4 = Omit<PublicReleaseMetadata, 'schemaVersion'> & {
  schemaVersion: typeof PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4;
};
export type PublicReleaseRowV4 = PublicReleaseMetadataV4;
export type PublicArtifactRowV4 = Omit<PublicArtifactRow, 'relation'> & { relation: PublicRelationNameV4 };
export type PublicDataProjectionV4 = Omit<
  PublicDataProjection,
  'schemaVersion' | 'release' | 'releases' | 'artifacts'
> & {
  schemaVersion: typeof PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4;
  release: PublicReleaseMetadataV4;
  releases: readonly PublicReleaseRowV4[];
  artifacts: readonly PublicArtifactRowV4[];
  preflightCoverage: readonly PublicPreflightCoverageRow[];
  preflightEvidence: readonly PublicPreflightEvidenceRow[];
};

export type PublicWorkflowRowsReading =
  | { schemaVersion: typeof PUBLIC_DATA_MODEL_SCHEMA_VERSION_V1; workflows: readonly PublicWorkflowRowV1[] }
  | { schemaVersion: typeof PUBLIC_DATA_MODEL_SCHEMA_VERSION_V2 | typeof PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3; workflows: readonly PublicWorkflowRow[] }
  | { schemaVersion: typeof PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4; workflows: readonly PublicWorkflowRow[] };
export { readPublicWorkflowRows } from './public-workflow-row-reader';
