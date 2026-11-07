import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { PUBLIC_ROW_KEYS_V4 } from './public-row-contract.js';
import { canonicalJson, isV4, type ExportProjection } from './export-version.js';

const RELATIONS = ['preflightCoverage', 'preflightEvidence'] as const;
const table = (relation: typeof RELATIONS[number]) => relation === 'preflightCoverage' ? 'preflight_coverage' : 'preflight_evidence';
const column = (key: string) => key.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase());
const json = (key: string) => key === 'omissionCodes' || key === 'omissionCounts';
const ddl = (relation: typeof RELATIONS[number], key: string) => {
  const name = column(key);
  const primary = key === (relation === 'preflightCoverage' ? 'coverageId' : 'evidenceId');
  const nullable = ['sourceBodySha256', 'nodeName', 'nodeType', 'typeVersion', 'credentialReference', 'subworkflowResolution', 'environmentNamespace'].includes(key);
  const type = key === 'nodeIndex' || key === 'observationOrdinal' ? 'INTEGER' : 'TEXT';
  const ref = key === 'workflowId' ? ' REFERENCES workflows(workflow_id)' : key === 'sourceId' ? ' REFERENCES sources(source_id)'
    : key === 'coverageId' && relation === 'preflightEvidence' ? ' REFERENCES preflight_coverage(coverage_id)' : '';
  return `"${name}" ${type}${primary ? ' PRIMARY KEY' : nullable ? '' : ' NOT NULL'}${ref}${json(key) ? ` CHECK(json_valid("${name}") AND json_type("${name}") = 'array')` : ''}`;
};

export function insertSqlitePreflight(db: DatabaseSync, projection: ExportProjection): void {
  if (!isV4(projection)) return;
  db.exec('PRAGMA user_version = 3');
  for (const relation of RELATIONS) {
    const keys = PUBLIC_ROW_KEYS_V4[relation];
    db.exec(`CREATE TABLE ${table(relation)} (${keys.map((key) => ddl(relation, key)).join(', ')})`);
    const statement = db.prepare(`INSERT INTO ${table(relation)} VALUES (${keys.map(() => '?').join(', ')})`);
    for (const row of projection[relation]) {
      const record = row as unknown as Record<string, unknown>;
      statement.run(...keys.map((key): SQLInputValue => json(key) ? canonicalJson(record[key]) : record[key] as SQLInputValue));
    }
  }
}

export function readSqlitePreflight(db: DatabaseSync): Record<string, readonly unknown[]> {
  if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version !== 3) return {};
  return Object.fromEntries(RELATIONS.map((relation) => {
    const keys = PUBLIC_ROW_KEYS_V4[relation];
    const rows = db.prepare(`SELECT * FROM ${table(relation)} ORDER BY rowid`).all();
    return [relation, rows.map((row) => Object.fromEntries(keys.map((key) => {
      const value = row[column(key)];
      if (json(key)) {
        const parsed: unknown = JSON.parse(String(value));
        if (canonicalJson(parsed) !== value) throw new Error('SQLite: noncanonical preflight JSON array');
        return [key, parsed];
      }
      return [key, value];
    })))];
  }));
}
