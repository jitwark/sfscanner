import crypto from 'node:crypto';
import { assertKnownRightsStatus, type Entry } from '@hub/contracts';
import {
  PUBLIC_DATA_MODEL_SCHEMA_VERSION,
  type PublicArtifactRow,
  type PublicDataProjection,
  type PublicFindingRow,
  type PublicNamedValueRow,
  type PublicReleaseMetadata,
  type PublicRequirementRow,
  type PublicWorkflowRow,
  type PublicWorkflowScanEvidence,
} from '@hub/contracts/public-data-model';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { isWithheldEndpointLabel } from '../sanitize/publication.js';
import { scanEvidence, type ScanProvenanceOptions } from './scan-provenance.js';
import { sourceRow } from './source-projection.js';

const HASH = /^[0-9a-f]{64}$/;

export type PublicProjectionOptions = ScanProvenanceOptions & {
  release: PublicReleaseMetadata;
  excludedIds?: readonly string[];
  bodySha256ByWorkflowId?: Readonly<Record<string, string | undefined>>;
  /**
   * This release publishes no workflow body for any row: every `body` reference is null, including
   * rows whose source licence is `redistributable`. The rights field still reports the licence.
   */
  linkOnly?: boolean;
};

function stableId(prefix: string, value: string): string {
  return `${prefix}-${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCanonicalStrings);
}

function namedRows(prefix: string, values: readonly string[]): PublicNamedValueRow[] {
  return sortedUnique(values).map((label) => ({ id: stableId(prefix, label), label }));
}

function validateRelease(release: PublicReleaseMetadata): void {
  if (release.schemaVersion !== PUBLIC_DATA_MODEL_SCHEMA_VERSION) throw new Error('Public projection: unsupported schema version');
  if (!HASH.test(release.manifestSha256) || !HASH.test(release.corpusSha256)) throw new Error('Public projection: release hashes must be lowercase SHA-256');
  const rights = release.facetCounts.rights;
  if (release.counts.redistributable !== rights.redistributable || release.counts.linkOnly !== rights.linkOnly || release.counts.excluded !== rights.excluded) {
    throw new Error(`Public projection: rights counts disagree (redistributable ${release.counts.redistributable} vs facet ${rights.redistributable}; linkOnly ${release.counts.linkOnly} vs facet ${rights.linkOnly}; excluded ${release.counts.excluded} vs facet ${rights.excluded})`);
  }
}

function sourceIdentity(entry: Entry): string {
  return `${entry.source.kind}\0${entry.source.repo ?? entry.source.permalink}`;
}

function bodyReference(entry: Entry, options: PublicProjectionOptions): PublicWorkflowRow['body'] {
  if (options.linkOnly === true) return null;
  if (entry.rights.status !== 'redistributable' || !entry.download) return null;
  const sha256 = options.bodySha256ByWorkflowId?.[entry.id];
  if (!sha256 || !HASH.test(sha256)) throw new Error(`Public projection: missing body SHA-256 for redistributable workflow "${entry.id}"`);
  return { kind: 'path', path: `packs/pack-${entry.download.pack}.jsonl`, sha256 };
}

/**
 * Plan 6.6: a row with no authorized body publishes a `readiness` object whose
 * own content says the analysis never ran, so exporting that as `known` is the
 * false clean the clause forbids. This field's own vocabulary has no `unscanned`
 * member — adding one is a schema change — so the honest value here is `unknown`,
 * which is also what a consumer reads for a row with no readiness report at all.
 * The row's scan state itself is stated by `scanEvidence.scanFreshness`.
 */
function readinessStatus(entry: Entry): PublicWorkflowRow['readinessStatus'] {
  if (entry.rights.status === 'link_only') return 'not-applicable';
  if (!entry.readiness || entry.readiness.analysis === 'unscanned') return 'unknown';
  return 'known';
}

/**
 * The row's assessment, fail-closed in one place. `UNKNOWN` is not a grade: `PublicFact`'s known
 * branch exists to say "this is a real LOW..CRITICAL verdict", so a row that retains `UNKNOWN`, or
 * whose status is `INDETERMINATE`, or whose scan is not current or explicitly historical, publishes
 * `unknown`/null rather than a known value carrying the string `UNKNOWN`.
 */
function assessment(entry: Entry, evidence: PublicWorkflowScanEvidence): Pick<PublicWorkflowRow, 'grade' | 'score'> {
  const grade = entry.security.grade;
  const scored = (evidence.scanFreshness === 'CURRENT' || evidence.scanFreshness === 'HISTORICAL')
    && evidence.analysisStatus !== 'INDETERMINATE';
  if (!scored || grade === 'UNKNOWN') {
    return { grade: { status: 'unknown', value: null }, score: { status: 'unknown', value: null } };
  }
  return { grade: { status: 'known', value: grade }, score: { status: 'known', value: entry.security.score } };
}

function workflowRow(entry: Entry, sourceId: string, options: PublicProjectionOptions): PublicWorkflowRow {
  const evidence = scanEvidence(entry, options);
  const { grade, score } = assessment(entry, evidence);
  return {
    workflowId: entry.id,
    title: entry.title,
    description: entry.description,
    descriptionAuthority: entry.descriptionSource === 'upstream' ? 'source' : 'non-authoritative-prose',
    sourceId,
    rightsStatus: entry.rights.status,
    body: bodyReference(entry, options),
    grade,
    score,
    completeness: entry.structure.partial === true ? 'partial' : 'complete',
    complexity: entry.structure.complexity,
    nodeCount: entry.structure.nodeCount,
    connectionCount: entry.structure.connectionCount,
    readinessStatus: readinessStatus(entry),
    scanEvidence: evidence,
  };
}

function requirementRows(entry: Entry): PublicRequirementRow[] {
  const rows: PublicRequirementRow[] = [];
  // Plan 6.6: an entry with no authorized body keeps the requirements derived
  // before that body went missing, and nothing in the published data establishes
  // them now, so they are labelled `unknown` rather than `required`. `unknown` is
  // this model's own word for an unestablished status, so the per-row label needs
  // no new field and no schema change.
  const status: PublicRequirementRow['status'] = !entry.readiness || entry.readiness.analysis === 'unscanned' ? 'unknown' : 'required';
  const add = (kind: PublicRequirementRow['kind'], label: string, rowStatus: PublicRequirementRow['status'] = status) => {
    rows.push({ requirementId: stableId(`requirement-${kind}`, `${entry.id}\0${label}${kind === 'replaceable-value' || kind === 'version' ? '\0' + rows.filter((row) => row.kind === kind).length : ''}`), workflowId: entry.id, kind, label, status: rowStatus });
  };
  for (const credential of entry.readiness?.credentials ?? []) add('credential', credential);
  for (const domain of entry.hostnames?.literal ?? []) add('domain', domain);
  for (const node of entry.readiness?.extraPackages ?? []) add('community-node', node);
  for (const _value of entry.readiness?.replaceableValues ?? []) add('replaceable-value', 'Replaceable workflow value');
  for (const _note of entry.readiness?.versionNotes ?? []) add('version', 'Workflow version note', 'unknown');
  return rows;
}

function findingRows(entry: Entry): PublicFindingRow[] {
  // The same policy commonly fires more than once per workflow (one
  // N8N_CODE_NODE finding per Code node, for instance — 15,169 occurrences
  // across the committed corpus), and two nodes can even share a name, so
  // neither (workflowId, policyId) nor (workflowId, policyId, node) is
  // unique. The array index is: it is stable across reruns over an
  // unchanged corpus, which is all the determinism this needs.
  return entry.security.findings.map((finding, index) => ({
    findingId: stableId('finding', `${entry.id}\0${index}\0${finding.id}`),
    workflowId: entry.id,
    policyId: finding.id,
    severity: finding.severity,
    category: 'unknown',
    effect: finding.why,
    confidence: 'unknown',
    title: finding.title,
    remediation: finding.fix,
  }));
}

function assertComputedCounts(rows: readonly PublicWorkflowRow[], findings: readonly PublicFindingRow[], release: PublicReleaseMetadata): void {
  const actual = {
    workflows: rows.length,
    redistributable: rows.filter((row) => row.rightsStatus === 'redistributable').length,
    linkOnly: rows.filter((row) => row.rightsStatus === 'link_only').length,
    findings: findings.length,
  };
  if (actual.workflows !== release.counts.workflows || actual.redistributable !== release.counts.redistributable || actual.linkOnly !== release.counts.linkOnly || actual.findings !== release.counts.findings) {
    throw new Error(`Public projection: release counts disagree with rows (workflows ${release.counts.workflows}/${actual.workflows}, redistributable ${release.counts.redistributable}/${actual.redistributable}, linkOnly ${release.counts.linkOnly}/${actual.linkOnly}, findings ${release.counts.findings}/${actual.findings})`);
  }
}

export function buildPublicProjection(entries: readonly Entry[], options: PublicProjectionOptions): PublicDataProjection {
  validateRelease(options.release);
  const excluded = new Set(options.excludedIds ?? []);
  const included = entries.filter((entry) => {
    assertKnownRightsStatus(entry.rights.status, entry.id);
    return !excluded.has(entry.id) && entry.rights.status !== 'excluded';
  });
  if (new Set(included.map((entry) => entry.id)).size !== included.length) throw new Error('Public projection: duplicate workflow id');

  const sourceIds = new Map<string, string>();
  for (const entry of included) {
    const identity = sourceIdentity(entry);
    if (!sourceIds.has(identity)) sourceIds.set(identity, stableId('source', identity));
  }
  const workflows = included.map((entry) => workflowRow(entry, sourceIds.get(sourceIdentity(entry))!, options)).sort((a, b) => compareCanonicalStrings(a.workflowId, b.workflowId));
  const findings = included.flatMap(findingRows).sort((a, b) => compareCanonicalStrings(`${a.workflowId}\0${a.policyId}`, `${b.workflowId}\0${b.policyId}`));
  assertComputedCounts(workflows, findings, options.release);

  const sourceEntries = new Map<string, Entry[]>();
  for (const entry of included) {
    const identity = sourceIdentity(entry);
    const group = sourceEntries.get(identity);
    if (group) group.push(entry); else sourceEntries.set(identity, [entry]);
  }
  const sources = [...sourceEntries.entries()].map(([identity, entries]) => sourceRow(entries, sourceIds.get(identity)!)).sort((a, b) => compareCanonicalStrings(a.sourceId, b.sourceId));
  const integrations = namedRows('integration', included.flatMap((entry) => entry.structure.integrations));
  const tags = namedRows('tag', included.flatMap((entry) => entry.tags));
  const triggers = namedRows('trigger', included.map((entry) => entry.structure.trigger));
  const integrationIds = new Map(integrations.map((row) => [row.label, row.id]));
  const tagIds = new Map(tags.map((row) => [row.label, row.id]));
  const triggerIds = new Map(triggers.map((row) => [row.label, row.id]));
  const workflowIntegrations = included.flatMap((entry) => sortedUnique(entry.structure.integrations).map((label) => ({ workflowId: entry.id, integrationId: integrationIds.get(label)! }))).sort((a, b) => compareCanonicalStrings(`${a.workflowId}\0${a.integrationId}`, `${b.workflowId}\0${b.integrationId}`));
  const workflowTags = included.flatMap((entry) => sortedUnique(entry.tags).map((label) => ({ workflowId: entry.id, tagId: tagIds.get(label)! }))).sort((a, b) => compareCanonicalStrings(`${a.workflowId}\0${a.tagId}`, `${b.workflowId}\0${b.tagId}`));
  const workflowTriggers = included.map((entry) => ({ workflowId: entry.id, triggerId: triggerIds.get(entry.structure.trigger)! })).sort((a, b) => compareCanonicalStrings(`${a.workflowId}\0${a.triggerId}`, `${b.workflowId}\0${b.triggerId}`));
  const credentials = namedRows('credential', included.flatMap((entry) => entry.readiness?.credentials ?? []));
  // A withheld endpoint keeps its requirement row but is not a domain: the
  // public relation omits the placeholder rather than inventing a hostname.
  const domains = namedRows(
    'domain',
    included.flatMap((entry) => (entry.hostnames?.literal ?? []).filter((host) => !isWithheldEndpointLabel(host))),
  ).map((row) => ({ id: row.id, hostname: row.label }));
  const communityNodes = namedRows('community-node', included.flatMap((entry) => entry.readiness?.extraPackages ?? [])).map((row) => ({ id: row.id, packageName: row.label }));
  const requirements = included.flatMap(requirementRows).sort((a, b) => compareCanonicalStrings(a.requirementId, b.requirementId));
  const artifacts: PublicArtifactRow[] = [];

  return {
    schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
    release: options.release,
    releases: [options.release],
    workflows,
    sources,
    findings,
    integrations,
    tags,
    triggers,
    workflowIntegrations,
    workflowTags,
    workflowTriggers,
    credentials,
    domains,
    communityNodes,
    requirements,
    exclusions: [],
    artifacts,
  };
}
