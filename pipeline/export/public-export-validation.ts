import { isV4, relationNames, type ExportProjection } from './export-version.js';
import { validatePublicPreflightRelations } from '../../contracts/public-preflight-data.js';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION, PUBLIC_RELATION_NAMES, PUBLIC_SCAN_FRESHNESS_VALUES, type PublicRelationName } from '@hub/contracts/public-data-model';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { PUBLIC_ROW_KEYS, publicNestedRowKeys } from './public-row-contract.js';

const HASH = /^[0-9a-f]{64}$/;
/** Dictionary-derived; see `public-row-contract.ts`. */
const ROW_KEYS: Record<PublicRelationName, readonly string[]> = PUBLIC_ROW_KEYS;

const KEY_FIELDS: Record<PublicRelationName, readonly string[]> = {
  releases: ['releaseId'], workflows: ['workflowId'], sources: ['sourceId'], findings: ['findingId'],
  integrations: ['id'], tags: ['id'], triggers: ['id'], credentials: ['id'], domains: ['id'], communityNodes: ['id'],
  workflowIntegrations: ['workflowId', 'integrationId'], workflowTags: ['workflowId', 'tagId'], workflowTriggers: ['workflowId', 'triggerId'],
  requirements: ['requirementId'], exclusions: ['exclusionId'], artifacts: ['artifactId'],
};

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(object).sort(compareCanonicalStrings).map((key) => [key, canonicalValue(object[key])]));
}

function canonicalRow(relation: PublicRelationName, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Public export: ${relation} row is not an object`);
  const source = value as Record<string, unknown>;
  const expected = ROW_KEYS[relation];
  const actual = Object.keys(source).sort(compareCanonicalStrings);
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort(compareCanonicalStrings))) throw new Error(`Public export: ${relation} row keys do not match the canonical allowlist`);
  return Object.fromEntries(expected.map((key) => [key, canonicalValue(source[key])]));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCanonicalStrings);
  return JSON.stringify(actual) === JSON.stringify([...expected].sort(compareCanonicalStrings));
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) &&
    !value.split('/').some((segment) => segment === '.' || segment === '..');
}

function isValidBodyReference(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.kind === 'path') return hasExactKeys(body, ['kind', 'path', 'sha256']) && isSafeRelativePath(body.path) && isHash(body.sha256);
  if (body.kind === 'hash') return hasExactKeys(body, ['kind', 'sha256']) && isHash(body.sha256);
  return false;
}

const ANALYSIS_STATUS_VALUES = ['COMPLETE', 'DEGRADED', 'INDETERMINATE'] as const;

/**
 * The row's own scan provenance, exactly as the dictionary shapes it: the four fields, a freshness
 * from the model's own vocabulary, and the nullable strings/hashes present as values or explicit
 * nulls. A writer must never meet a half-shaped evidence object and invent the missing half.
 */
function isValidScanEvidence(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  const { scannerVersion, analysisStatus, scanFreshness, scanBodySha256 } = evidence;
  return hasExactKeys(evidence, publicNestedRowKeys('workflows', 'scanEvidence'))
    && (scannerVersion === null || typeof scannerVersion === 'string')
    && (analysisStatus === null || (ANALYSIS_STATUS_VALUES as readonly string[]).includes(analysisStatus as string))
    && typeof scanFreshness === 'string' && (PUBLIC_SCAN_FRESHNESS_VALUES as readonly string[]).includes(scanFreshness)
    && (scanBodySha256 === null || isHash(scanBodySha256));
}

function assertUniqueKeys(projection: ExportProjection, relation: PublicRelationName): void {
  const seen = new Set<string>();
  for (const value of projection[relation]) {
    const row = canonicalRow(relation, value);
    const key = JSON.stringify(KEY_FIELDS[relation].map((field) => row[field]));
    if (seen.has(key)) throw new Error(`Public export: duplicate ${relation} key ${key}`);
    seen.add(key);
  }
}

export function assertPublicProjection(projection: ExportProjection): true {
  if ((!isV4(projection) && projection.schemaVersion !== PUBLIC_DATA_MODEL_SCHEMA_VERSION) || projection.release.schemaVersion !== projection.schemaVersion) throw new Error('Public export: unsupported schema version');
  if (!HASH.test(projection.release.manifestSha256) || !HASH.test(projection.release.corpusSha256)) throw new Error('Public export: release hashes must be lowercase SHA-256');
  for (const relation of PUBLIC_RELATION_NAMES) {
    if (!Array.isArray(projection[relation])) throw new Error(`Public export: ${relation} relation is not an array`);
    assertUniqueKeys(projection, relation);
  }
  if (projection.releases.length !== 1) throw new Error('Public export: releases relation must contain exactly one canonical release');
  const workflows = new Set(projection.workflows.map((row) => row.workflowId));
  const sources = new Set(projection.sources.map((row) => row.sourceId));
  const integrations = new Set(projection.integrations.map((row) => row.id));
  const tags = new Set(projection.tags.map((row) => row.id));
  const triggers = new Set(projection.triggers.map((row) => row.id));
  const releases = new Set(projection.releases.map((row) => row.releaseId));
  if (JSON.stringify(canonicalRow('releases', projection.release)) !== JSON.stringify(canonicalRow('releases', projection.releases[0]))) throw new Error('Public export: release metadata parity mismatch');
  for (const row of projection.workflows) {
    if (!sources.has(row.sourceId)) throw new Error(`Public export: workflow ${row.workflowId} references missing source`);
    if (!['redistributable', 'link_only', 'excluded'].includes(row.rightsStatus)) throw new Error(`Public export: workflow ${row.workflowId} has unknown rights status`);
    if (row.rightsStatus !== 'redistributable' && row.body !== null) throw new Error(`Public export: non-redistributable workflow ${row.workflowId} has a body reference`);
    if (row.body !== null && !isValidBodyReference(row.body)) throw new Error(`Public export: workflow ${row.workflowId} has an invalid body reference`);
    if (!isValidScanEvidence(row.scanEvidence)) throw new Error(`Public export: workflow ${row.workflowId} has invalid scan evidence`);
  }
  for (const row of projection.findings) if (!workflows.has(row.workflowId)) throw new Error(`Public export: finding ${row.findingId} references missing workflow`);
  for (const row of projection.workflowIntegrations) if (!workflows.has(row.workflowId) || !integrations.has(row.integrationId)) throw new Error('Public export: invalid integration reference');
  for (const row of projection.workflowTags) if (!workflows.has(row.workflowId) || !tags.has(row.tagId)) throw new Error('Public export: invalid tag reference');
  for (const row of projection.workflowTriggers) if (!workflows.has(row.workflowId) || !triggers.has(row.triggerId)) throw new Error('Public export: invalid trigger reference');
  for (const row of projection.requirements) if (!workflows.has(row.workflowId)) throw new Error(`Public export: requirement ${row.requirementId} references missing workflow`);
  for (const row of projection.exclusions) if (row.status !== 'excluded' || (row.workflowId !== null && workflows.has(row.workflowId))) throw new Error(`Public export: exclusion ${row.exclusionId} leaks an emitted workflow`);
  for (const row of projection.artifacts) {
    if (!releases.has(row.releaseId) || row.releaseId !== projection.release.releaseId || !(relationNames(projection) as readonly string[]).includes(row.relation) || row.path.trim() === '' || !HASH.test(row.sha256)) throw new Error(`Public export: invalid artifact ${row.artifactId}`);
    if (!['ndjson', 'sqlite', 'xlsx', 'json'].includes(row.format) || !['redistributable', 'link_only', 'excluded'].includes(row.rightsStatus) || !Number.isSafeInteger(row.byteSize) || row.byteSize < 0) throw new Error(`Public export: invalid artifact ${row.artifactId}`);
  }
  const rights = projection.release.facetCounts.rights;
  if (projection.release.counts.redistributable !== rights.redistributable || projection.release.counts.linkOnly !== rights.linkOnly || projection.release.counts.excluded !== rights.excluded) throw new Error('Public export: rights counts disagree with facet counts');
  const redistributable = projection.workflows.filter((row) => row.rightsStatus === 'redistributable').length;
  const linkOnly = projection.workflows.filter((row) => row.rightsStatus === 'link_only').length;
  if (projection.release.counts.workflows !== projection.workflows.length || projection.release.counts.redistributable !== redistributable || projection.release.counts.linkOnly !== linkOnly || projection.release.counts.findings !== projection.findings.length) throw new Error('Public export: release counts disagree with canonical relations');
  if (isV4(projection)) {
    const inventoryDigests = new Set(projection.preflightCoverage.map((row) => row.inventorySha256));
    const workflowOf = new Map(projection.workflows.map((row) => [row.workflowId, row]));
    if (!validatePublicPreflightRelations(projection.preflightCoverage, projection.preflightEvidence)
      || inventoryDigests.size > 1
      || projection.preflightCoverage.length !== workflows.size
      || projection.preflightCoverage.some((row) => !workflows.has(row.workflowId) || !sources.has(row.sourceId)
        || workflowOf.get(row.workflowId)?.sourceId !== row.sourceId
        || (['CURRENT', 'NO_RESULT'].includes(workflowOf.get(row.workflowId)!.scanEvidence.scanFreshness)
          && (row.bodyStatus !== 'AVAILABLE' || row.sourceBodySha256 !== workflowOf.get(row.workflowId)!.scanEvidence.scanBodySha256)))) {
      throw new Error('Public export: invalid preflight relations or population');
    }
  }
  return true;
}
