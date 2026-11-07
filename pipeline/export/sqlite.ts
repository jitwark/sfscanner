import { insertSqlitePreflight, readSqlitePreflight } from './sqlite-preflight.js';
import { canonicalJson, dictionaryRows, isV4, type ExportProjection } from './export-version.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PUBLIC_RELATION_NAMES, type PublicWorkflowRow } from '@hub/contracts/public-data-model';
import { writeAtomicFileWithWriter } from './atomic-file.js';
import { assertPublicProjection } from './public-export-validation.js';

const SQLITE_SCHEMA_VERSION = 2;

type WorkflowColumn = readonly [field: string, column: string, ddl: string, value: (row: PublicWorkflowRow) => string | number | null];

/**
 * The workflows table's physical columns, keyed by the logical dictionary field each stores, in
 * dictionary field order. `body`, `grade`, `score` and `scanEvidence` are one logical field each
 * and store one column per leaf. This single list defines the table, the insert and the read-back
 * SELECT, so a logical field cannot be added to one and forgotten in another. The `scan_` prefix
 * keeps a row's own engine identity apart from the release's `releases.scanner_version`.
 */
const WORKFLOW_COLUMNS: readonly WorkflowColumn[] = [
  ['workflowId', 'workflow_id', 'TEXT PRIMARY KEY', (row) => row.workflowId],
  ['title', 'title', 'TEXT NOT NULL', (row) => row.title],
  ['description', 'description', 'TEXT', (row) => row.description],
  ['descriptionAuthority', 'description_authority', 'TEXT NOT NULL', (row) => row.descriptionAuthority],
  ['sourceId', 'source_id', 'TEXT NOT NULL REFERENCES sources(source_id)', (row) => row.sourceId],
  ['rightsStatus', 'rights_status', 'TEXT NOT NULL', (row) => row.rightsStatus],
  ['body', 'body_kind', 'TEXT', (row) => row.body?.kind ?? null],
  ['body', 'body_path', 'TEXT', (row) => bodyPath(row)],
  ['body', 'body_sha256', 'TEXT', (row) => row.body?.sha256 ?? null],
  ['grade', 'grade_status', 'TEXT NOT NULL', (row) => row.grade.status],
  ['grade', 'grade', 'TEXT', (row) => factValue(row.grade)],
  ['score', 'score_status', 'TEXT NOT NULL', (row) => row.score.status],
  ['score', 'score', 'REAL', (row) => factValue(row.score)],
  ['completeness', 'completeness', 'TEXT NOT NULL', (row) => row.completeness],
  ['complexity', 'complexity', 'TEXT NOT NULL', (row) => row.complexity],
  ['nodeCount', 'node_count', 'INTEGER NOT NULL', (row) => row.nodeCount],
  ['connectionCount', 'connection_count', 'INTEGER NOT NULL', (row) => row.connectionCount],
  ['readinessStatus', 'readiness_status', 'TEXT NOT NULL', (row) => row.readinessStatus],
  ['scanEvidence.scannerVersion', 'scan_scanner_version', 'TEXT', (row) => row.scanEvidence.scannerVersion],
  ['scanEvidence.analysisStatus', 'scan_analysis_status', 'TEXT', (row) => row.scanEvidence.analysisStatus],
  ['scanEvidence.scanFreshness', 'scan_freshness', 'TEXT NOT NULL', (row) => row.scanEvidence.scanFreshness],
  ['scanEvidence.scanBodySha256', 'scan_body_sha256', 'TEXT', (row) => row.scanEvidence.scanBodySha256],
];

const WORKFLOW_SELECT = WORKFLOW_COLUMNS.map(([, column]) => column).join(', ');
const WORKFLOW_DDL = `CREATE TABLE workflows (${WORKFLOW_COLUMNS.map(([, column, ddl]) => `${column} ${ddl}`).join(', ')}, CHECK (body_path IS NULL OR rights_status = 'redistributable'), CHECK ((body_kind IS NULL AND body_path IS NULL AND body_sha256 IS NULL) OR (body_kind = 'path' AND body_path IS NOT NULL AND body_sha256 IS NOT NULL) OR (body_kind = 'hash' AND body_path IS NULL AND body_sha256 IS NOT NULL)));`;

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA user_version = ${SQLITE_SCHEMA_VERSION};
CREATE TABLE releases (release_id TEXT PRIMARY KEY, schema_version TEXT NOT NULL, generated_at TEXT NOT NULL, tool_version TEXT NOT NULL, scanner_version TEXT NOT NULL, policy_version TEXT NOT NULL, search_index_version TEXT NOT NULL, build_revision TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, corpus_sha256 TEXT NOT NULL, counts_json TEXT NOT NULL, facet_counts_json TEXT NOT NULL);
CREATE TABLE data_dictionary (relation_name TEXT NOT NULL, field_name TEXT NOT NULL, type TEXT NOT NULL, nullable INTEGER NOT NULL CHECK (nullable IN (0, 1)), authority TEXT NOT NULL, rights_class TEXT NOT NULL, privacy_rule TEXT NOT NULL, derivation TEXT NOT NULL, PRIMARY KEY (relation_name, field_name));
CREATE TABLE sources (source_id TEXT PRIMARY KEY, kind TEXT NOT NULL, public_url TEXT NOT NULL, repository_url TEXT, licence TEXT, licence_url TEXT);
${WORKFLOW_DDL}
CREATE TABLE findings (finding_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id), policy_id TEXT NOT NULL, severity TEXT NOT NULL, category TEXT NOT NULL, effect TEXT NOT NULL, confidence TEXT NOT NULL, title TEXT NOT NULL, remediation TEXT NOT NULL);
CREATE TABLE integrations (id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE); CREATE TABLE tags (id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE); CREATE TABLE triggers (id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE); CREATE TABLE credentials (id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE); CREATE TABLE domains (id TEXT PRIMARY KEY, hostname TEXT NOT NULL UNIQUE); CREATE TABLE community_nodes (id TEXT PRIMARY KEY, package_name TEXT NOT NULL UNIQUE);
CREATE TABLE workflow_integrations (workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id), integration_id TEXT NOT NULL REFERENCES integrations(id), PRIMARY KEY(workflow_id, integration_id)); CREATE TABLE workflow_tags (workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id), tag_id TEXT NOT NULL REFERENCES tags(id), PRIMARY KEY(workflow_id, tag_id)); CREATE TABLE workflow_triggers (workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id), trigger_id TEXT NOT NULL REFERENCES triggers(id), PRIMARY KEY(workflow_id, trigger_id));
CREATE TABLE requirements (requirement_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id), kind TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE exclusions (exclusion_id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(workflow_id), status TEXT NOT NULL, reason_code TEXT NOT NULL, public_reference TEXT);
CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES releases(release_id), relation TEXT NOT NULL, format TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, rights_status TEXT NOT NULL);
CREATE INDEX workflows_source_idx ON workflows(source_id); CREATE INDEX sources_kind_idx ON sources(kind); CREATE INDEX workflows_grade_idx ON workflows(grade); CREATE INDEX workflows_completeness_idx ON workflows(completeness); CREATE INDEX workflows_complexity_idx ON workflows(complexity);
CREATE VIRTUAL TABLE workflow_search USING fts5(workflow_id UNINDEXED, title, description, tags, integrations, triggers);
`;

export type SqliteReleaseInfo = { path: string; byteSize: number; sha256: string; logicalSha256: string };

function hash(value: Uint8Array | string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function factValue<T>(fact: { status: string; value: T | null }): T | null { return fact.status === 'known' ? fact.value : null; }
function bodyPath(row: PublicWorkflowRow): string | null { return row.body?.kind === 'path' ? row.body.path : null; }
type SqliteRow = Record<string, string | number | null>;
type LogicalRelations = Record<(typeof PUBLIC_RELATION_NAMES)[number], readonly unknown[]> & Partial<Record<'preflightCoverage' | 'preflightEvidence', readonly unknown[]>>;
function logicalPayload(input: ExportProjection | LogicalRelations): string {
  const relations = 'preflightCoverage' in input ? [...PUBLIC_RELATION_NAMES, 'preflightCoverage', 'preflightEvidence'] : PUBLIC_RELATION_NAMES;
  return relations.map((relation) => `${relation}\n${('preflightCoverage' in input ? canonicalJson((input as Record<string, unknown>)[relation]) : JSON.stringify((input as Record<string, unknown>)[relation]))}`).join('\n');
}
function select(db: DatabaseSync, sql: string): SqliteRow[] { return db.prepare(sql).all() as unknown as SqliteRow[]; }
function jsonValue(value: string | number | null): unknown { return JSON.parse(String(value)); }

function readLogicalRelations(db: DatabaseSync): LogicalRelations {
  const releases = select(db, 'SELECT release_id, schema_version, generated_at, tool_version, scanner_version, policy_version, search_index_version, build_revision, manifest_sha256, corpus_sha256, counts_json, facet_counts_json FROM releases ORDER BY release_id').map((row) => ({
    releaseId: row.release_id, schemaVersion: row.schema_version, generatedAt: row.generated_at, toolVersion: row.tool_version,
    scannerVersion: row.scanner_version, policyVersion: row.policy_version, searchIndexVersion: row.search_index_version,
    buildRevision: row.build_revision, manifestSha256: row.manifest_sha256, corpusSha256: row.corpus_sha256,
    counts: jsonValue(row.counts_json), facetCounts: jsonValue(row.facet_counts_json),
  }));
  const workflows = select(db, `SELECT ${WORKFLOW_SELECT} FROM workflows ORDER BY workflow_id`).map((row) => ({
    workflowId: row.workflow_id, title: row.title, description: row.description, descriptionAuthority: row.description_authority,
    sourceId: row.source_id, rightsStatus: row.rights_status,
    body: row.body_kind === null ? null : row.body_kind === 'path'
      ? { kind: 'path', path: row.body_path, sha256: row.body_sha256 }
      : { kind: 'hash', sha256: row.body_sha256 },
    grade: { status: row.grade_status, value: row.grade_status === 'known' ? row.grade : null },
    score: { status: row.score_status, value: row.score_status === 'known' ? row.score : null },
    completeness: row.completeness, complexity: row.complexity, nodeCount: row.node_count,
    connectionCount: row.connection_count, readinessStatus: row.readiness_status,
    // The row's own scan provenance reads back from its own columns; the release's
    // `scanner_version` is never consulted for it.
    scanEvidence: {
      scannerVersion: row.scan_scanner_version,
      analysisStatus: row.scan_analysis_status,
      scanFreshness: row.scan_freshness,
      scanBodySha256: row.scan_body_sha256,
    },
  }));
  const sources = select(db, 'SELECT source_id, kind, public_url, repository_url, licence, licence_url FROM sources ORDER BY source_id').map((row) => ({ sourceId: row.source_id, kind: row.kind, publicUrl: row.public_url, repositoryUrl: row.repository_url, licence: row.licence, licenceUrl: row.licence_url }));
  const findings = select(db, 'SELECT finding_id, workflow_id, policy_id, severity, category, effect, confidence, title, remediation FROM findings ORDER BY workflow_id, policy_id').map((row) => ({ findingId: row.finding_id, workflowId: row.workflow_id, policyId: row.policy_id, severity: row.severity, category: row.category, effect: row.effect, confidence: row.confidence, title: row.title, remediation: row.remediation }));
  // `namedRows` (public-projection.ts) sorts each of these relations by
  // *label*, not by the hashed id — the id exists only to key joins, and
  // hashing a label scatters its order. Reading back `ORDER BY id` therefore
  // agreed with the projection only by accident, at fixture scale (at most
  // one row per relation). `ORDER BY label` is the read-back order that
  // actually matches what `buildPublicProjection` emits.
  const named = (table: string) => select(db, `SELECT id, label FROM ${table} ORDER BY label`).map((row) => ({ id: row.id, label: row.label }));
  const joins = (table: string, right: string) => select(db, `SELECT workflow_id, ${right} FROM ${table} ORDER BY workflow_id, ${right}`).map((row) => ({ workflowId: row.workflow_id, [right.replace('_id', 'Id')]: row[right] }));
  const domains = select(db, 'SELECT id, hostname FROM domains ORDER BY hostname').map((row) => ({ id: row.id, hostname: row.hostname }));
  const communityNodes = select(db, 'SELECT id, package_name FROM community_nodes ORDER BY package_name').map((row) => ({ id: row.id, packageName: row.package_name }));
  const requirements = select(db, 'SELECT requirement_id, workflow_id, kind, label, status FROM requirements ORDER BY requirement_id').map((row) => ({ requirementId: row.requirement_id, workflowId: row.workflow_id, kind: row.kind, label: row.label, status: row.status }));
  const exclusions = select(db, 'SELECT exclusion_id, workflow_id, status, reason_code, public_reference FROM exclusions ORDER BY exclusion_id').map((row) => ({ exclusionId: row.exclusion_id, workflowId: row.workflow_id, status: row.status, reasonCode: row.reason_code, publicReference: row.public_reference }));
  const artifacts = select(db, 'SELECT artifact_id, release_id, relation, format, path, sha256, byte_size, rights_status FROM artifacts ORDER BY artifact_id').map((row) => ({ artifactId: row.artifact_id, releaseId: row.release_id, relation: row.relation, format: row.format, path: row.path, sha256: row.sha256, byteSize: row.byte_size, rightsStatus: row.rights_status }));
  return { ...readSqlitePreflight(db), releases, workflows, sources, findings, integrations: named('integrations'), tags: named('tags'), triggers: named('triggers'), workflowIntegrations: joins('workflow_integrations', 'integration_id'), workflowTags: joins('workflow_tags', 'tag_id'), workflowTriggers: joins('workflow_triggers', 'trigger_id'), credentials: named('credentials'), domains, communityNodes, requirements, exclusions, artifacts };
}

function sqliteLogicalSha256(db: DatabaseSync): string { return hash(logicalPayload(readLogicalRelations(db))); }

/**
 * One pass over the join rows into per-workflow label lists, in the joins' own
 * canonical order. Filtering the whole join array once per workflow was the
 * FTS build's quadratic cost; sorting here would silently change FTS bytes.
 */
function indexJoinLabels<T extends { workflowId: string }>(
  joins: readonly T[],
  rightKey: keyof T & string,
  labels: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const byWorkflow = new Map<string, string[]>();
  for (const join of joins) {
    const label = labels.get(String(join[rightKey]));
    if (label === undefined) continue;
    const existing = byWorkflow.get(join.workflowId);
    if (existing) existing.push(label);
    else byWorkflow.set(join.workflowId, [label]);
  }
  return byWorkflow;
}

function insertProjection(db: DatabaseSync, projection: ExportProjection): void {
  db.exec(SCHEMA); db.exec('BEGIN IMMEDIATE');
  try {
    const release = db.prepare('INSERT INTO releases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const row of projection.releases) release.run(row.releaseId, row.schemaVersion, row.generatedAt, row.toolVersion, row.scannerVersion, row.policyVersion, row.searchIndexVersion, row.buildRevision, row.manifestSha256, row.corpusSha256, JSON.stringify(row.counts), JSON.stringify(row.facetCounts));
    const dictionary = db.prepare('INSERT INTO data_dictionary VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const row of dictionaryRows(projection)) dictionary.run(row.relation, row.field, row.type, row.nullable ? 1 : 0, row.authority, row.rightsClass, row.privacyRule, row.derivation);
    const source = db.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of projection.sources) source.run(row.sourceId, row.kind, row.publicUrl, row.repositoryUrl, row.licence, row.licenceUrl);
    const workflow = db.prepare(`INSERT INTO workflows VALUES (${WORKFLOW_COLUMNS.map(() => '?').join(', ')})`);
    for (const row of projection.workflows) workflow.run(...WORKFLOW_COLUMNS.map(([, , , value]) => value(row)));
    const finding = db.prepare('INSERT INTO findings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const row of projection.findings) finding.run(row.findingId, row.workflowId, row.policyId, row.severity, row.category, row.effect, row.confidence, row.title, row.remediation);
    for (const [table, rows] of [['integrations', projection.integrations], ['tags', projection.tags], ['triggers', projection.triggers], ['credentials', projection.credentials]] as const) { const statement = db.prepare(`INSERT INTO ${table} VALUES (?, ?)`); for (const row of rows) statement.run(row.id, row.label); }
    const domain = db.prepare('INSERT INTO domains VALUES (?, ?)'); for (const row of projection.domains) domain.run(row.id, row.hostname);
    const node = db.prepare('INSERT INTO community_nodes VALUES (?, ?)'); for (const row of projection.communityNodes) node.run(row.id, row.packageName);
    const wi = db.prepare('INSERT INTO workflow_integrations VALUES (?, ?)'); for (const row of projection.workflowIntegrations) wi.run(row.workflowId, row.integrationId);
    const wt = db.prepare('INSERT INTO workflow_tags VALUES (?, ?)'); for (const row of projection.workflowTags) wt.run(row.workflowId, row.tagId);
    const wtr = db.prepare('INSERT INTO workflow_triggers VALUES (?, ?)'); for (const row of projection.workflowTriggers) wtr.run(row.workflowId, row.triggerId);
    const requirement = db.prepare('INSERT INTO requirements VALUES (?, ?, ?, ?, ?)'); for (const row of projection.requirements) requirement.run(row.requirementId, row.workflowId, row.kind, row.label, row.status);
    const exclusion = db.prepare('INSERT INTO exclusions VALUES (?, ?, ?, ?, ?)'); for (const row of projection.exclusions) exclusion.run(row.exclusionId, row.workflowId, row.status, row.reasonCode, row.publicReference);
    const artifact = db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)'); for (const row of projection.artifacts) artifact.run(row.artifactId, row.releaseId, row.relation, row.format, row.path, row.sha256, row.byteSize, row.rightsStatus);
    const labels = new Map(projection.tags.map((row) => [row.id, row.label])); const integrations = new Map(projection.integrations.map((row) => [row.id, row.label])); const triggers = new Map(projection.triggers.map((row) => [row.id, row.label]));
    const tagsByWorkflow = indexJoinLabels(projection.workflowTags, 'tagId', labels);
    const integrationsByWorkflow = indexJoinLabels(projection.workflowIntegrations, 'integrationId', integrations);
    const triggersByWorkflow = indexJoinLabels(projection.workflowTriggers, 'triggerId', triggers);
    const search = db.prepare('INSERT INTO workflow_search VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of projection.workflows) search.run(row.workflowId, row.title, row.description ?? '', (tagsByWorkflow.get(row.workflowId) ?? []).join(' '), (integrationsByWorkflow.get(row.workflowId) ?? []).join(' '), (triggersByWorkflow.get(row.workflowId) ?? []).join(' '));
    insertSqlitePreflight(db, projection);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function writeSqliteRelease(projection: ExportProjection, outputPath: string): SqliteReleaseInfo {
  assertPublicProjection(projection);
  writeAtomicFileWithWriter(outputPath, (temporaryPath) => {
    const db = new DatabaseSync(temporaryPath);
    try { insertProjection(db, projection); } finally { db.close(); }
    verifySqliteRelease(projection, temporaryPath);
  });
  const bytes = fs.readFileSync(outputPath);
  const db = new DatabaseSync(outputPath);
  let logicalSha256: string;
  try { logicalSha256 = sqliteLogicalSha256(db); } finally { db.close(); }
  return { path: outputPath, byteSize: bytes.byteLength, sha256: hash(bytes), logicalSha256 };
}

function count(db: DatabaseSync, table: string): number { return Number((db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count); }
function workflows(db: DatabaseSync): string[] { return db.prepare('SELECT workflow_id FROM workflows ORDER BY workflow_id').all().map((row) => (row as { workflow_id: string }).workflow_id); }
function searchWorkflows(db: DatabaseSync): string[] { return db.prepare('SELECT workflow_id FROM workflow_search ORDER BY workflow_id').all().map((row) => (row as { workflow_id: string }).workflow_id); }

export function verifySqliteRelease(projection: ExportProjection, databasePath: string): true {
  assertPublicProjection(projection);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const userVersion = (db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined)?.user_version;
    if (userVersion !== (isV4(projection) ? 3 : SQLITE_SCHEMA_VERSION)) throw new Error(`SQLite: schema version mismatch: expected ${SQLITE_SCHEMA_VERSION}, got ${String(userVersion)}`);
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integrity.integrity_check !== 'ok') throw new Error(`SQLite: integrity check failed: ${integrity.integrity_check}`);
    if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('SQLite: foreign key check failed');
    if ((db.prepare('SELECT release_id FROM releases').get() as { release_id: string } | undefined)?.release_id !== projection.release.releaseId) throw new Error('SQLite: release identity mismatch');
    const tableCounts: Record<string, number> = { releases: projection.releases.length, data_dictionary: dictionaryRows(projection).length, workflows: projection.workflows.length, sources: projection.sources.length, findings: projection.findings.length, integrations: projection.integrations.length, tags: projection.tags.length, triggers: projection.triggers.length, workflow_integrations: projection.workflowIntegrations.length, workflow_tags: projection.workflowTags.length, workflow_triggers: projection.workflowTriggers.length, credentials: projection.credentials.length, domains: projection.domains.length, community_nodes: projection.communityNodes.length, requirements: projection.requirements.length, exclusions: projection.exclusions.length, artifacts: projection.artifacts.length };
    if (isV4(projection)) { tableCounts.preflight_coverage = projection.preflightCoverage.length; tableCounts.preflight_evidence = projection.preflightEvidence.length; }
    for (const [table, expected] of Object.entries(tableCounts)) if (count(db, table) !== expected) throw new Error(`SQLite: ${table} parity mismatch`);
    // The dictionary lives under its own physical names (`relation_name`, `field_name`); map them
    // back explicitly and compare the whole list, so a stored dictionary cannot document other
    // fields or rules than the ones this release published.
    const dictionary = select(db, 'SELECT relation_name, field_name, type, nullable, authority, rights_class, privacy_rule, derivation FROM data_dictionary ORDER BY rowid').map((row) => ({
      relation: row.relation_name, field: row.field_name, type: row.type, nullable: row.nullable === 1,
      authority: row.authority, rightsClass: row.rights_class, privacyRule: row.privacy_rule, derivation: row.derivation,
    }));
    if (JSON.stringify(dictionary) !== JSON.stringify(dictionaryRows(projection))) throw new Error('SQLite: data dictionary read-back mismatch');
    const expectedIds = projection.workflows.map((row) => row.workflowId).sort(); if (JSON.stringify(workflows(db)) !== JSON.stringify(expectedIds)) throw new Error('SQLite: workflow key parity mismatch');
    if (JSON.stringify(searchWorkflows(db)) !== JSON.stringify(expectedIds)) throw new Error('SQLite: FTS workflow key parity mismatch');
    const invalidBodies = db.prepare("SELECT workflow_id FROM workflows WHERE rights_status != 'redistributable' AND body_sha256 IS NOT NULL").all(); if (invalidBodies.length) throw new Error('SQLite: non-redistributable body present');
    if (sqliteLogicalSha256(db) !== hash(logicalPayload(projection))) throw new Error('SQLite: logical content mismatch');
    return true;
  } finally { db.close(); }
}
