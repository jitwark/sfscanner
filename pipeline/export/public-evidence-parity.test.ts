import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { PUBLIC_RELATION_NAMES, type PublicDataProjection } from '@hub/contracts/public-data-model';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { ADMITTED_V2_SCAN_IDENTITY } from '../scan/v2-corpus-adapter.js';
import { releaseForEntries } from '../__fixtures__/scan-provenance-cases.js';
import { publicDataDictionaryRows } from './public-data-dictionary.js';
import { writeExcelRelease, type ExcelReleaseInfo } from './excel.js';
import { writeNdjsonRelease, type NdjsonReleaseManifest } from './ndjson.js';
import { writeSqliteRelease, type SqliteReleaseInfo } from './sqlite.js';
import { canonicalJson, physicalName, readNdjsonRows, readSheetRows, WORKFLOW_COLUMNS } from './public-evidence-parity.js';
import { buildPublicProjection } from './public-projection.js';
import { PUBLIC_ROW_KEYS } from './public-row-contract.js';
import { readZip } from './xlsx-zip.js';

const SCAN_HASH = 'e'.repeat(64);
const SCANNED_ID = 'formula';
const FORMULA_TITLE = '=SUM(A1:A2)';
const FORMULA_DESCRIPTION = '+1\n-2\n@cmd "quoted" café 終端';

/**
 * One row per state the writers must carry — `COMPLETE`, `DEGRADED` and `INDETERMINATE` admitted
 * scans, a legacy retained verdict with two findings and a known zero, an unscanned row and an
 * owner-ruled one — the first with text hostile to a spreadsheet, and several empty relations.
 */
const ENTRIES = [
  makeEntry({ id: SCANNED_ID, title: FORMULA_TITLE, description: FORMULA_DESCRIPTION, download: { pack: 0, line: 1, offset: 0, length: 10 } }),
  makeEntry({ id: 'degraded' }),
  makeEntry({ id: 'indeterminate' }),
  makeEntry({
    id: 'multi', rights: { status: 'link_only', licence: null, licenceUrl: null },
    security: {
      score: 0,
      findings: [
        { id: 'policy.secret', title: 'Secret', severity: 'HIGH', why: 'unsafe value', fix: 'replace it' },
        { id: 'policy.network', title: 'Network', severity: 'LOW', why: 'shared egress', fix: 'bound it' },
      ],
    },
  }),
  makeEntry({ id: 'unscanned', security: { scannerVersion: 'unscanned' } }),
  makeEntry({ id: 'ruled', security: { stampReason: 'source_unavailable' } }),
];

const receipt = (entryId: string, analysisStatus: 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE') => ({
  entryId,
  identity: ADMITTED_V2_SCAN_IDENTITY,
  outcome: 'RESULT' as const,
  analysisStatus,
  bodySha256: SCAN_HASH,
  resultDigest: 'd'.repeat(64),
});
const RECEIPTS = {
  [SCANNED_ID]: receipt(SCANNED_ID, 'COMPLETE'),
  degraded: receipt('degraded', 'DEGRADED'),
  indeterminate: receipt('indeterminate', 'INDETERMINATE'),
};

function projection(entries: readonly Entry[] = ENTRIES): PublicDataProjection {
  return buildPublicProjection(entries, {
    release: releaseForEntries(entries),
    admittedIdentity: ADMITTED_V2_SCAN_IDENTITY,
    bodySha256ByWorkflowId: { [SCANNED_ID]: 'c'.repeat(64) },
    scanReceiptsByWorkflowId: RECEIPTS,
  });
}

let workdir: string;
let data: PublicDataProjection;
let db: DatabaseSync;
let xlsx: ExcelReleaseInfo;
let sqlite: SqliteReleaseInfo;
let ndjson: NdjsonReleaseManifest;

beforeAll(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-parity-'));
  data = projection();
  xlsx = writeExcelRelease(data, path.join(workdir, 'release.xlsx'));
  sqlite = writeSqliteRelease(data, path.join(workdir, 'release.sqlite'));
  ndjson = writeNdjsonRelease(data, path.join(workdir, 'ndjson'));
  db = new DatabaseSync(sqlite.path, { readOnly: true });
});
afterAll(() => { db.close(); fs.rmSync(workdir, { recursive: true, force: true }); });

function ndjsonRows(relation: string): Record<string, unknown>[] {
  return readNdjsonRows(path.join(workdir, 'ndjson'), relation);
}

function sqliteRows(relation: string): Record<string, unknown>[] {
  return db.prepare(`SELECT * FROM ${physicalName(relation)}`).all() as unknown as Record<string, unknown>[];
}

/** One worksheet's decoded cells, read from the workbook this fixture wrote. */
function sheetRows(name: string): string[][] {
  return readSheetRows(fs.readFileSync(xlsx.path), name);
}

/** A reader over the Workflows sheet: its own header row names the columns. */
function workflowSheetRow(workflowId: string): (header: string) => string {
  const [header = [], ...rows] = sheetRows('Workflows');
  const row = rows.find((candidate) => candidate[header.indexOf('workflowId')] === workflowId);
  if (!row) throw new Error(`parity fixture: no Workflows sheet row for ${workflowId}`);
  return (name) => row[header.indexOf(name)] ?? '';
}

describe('public evidence parity across the written artifacts', () => {
  it('reopens every NDJSON relation with the contract key order and the projected rows', () => {
    for (const relation of PUBLIC_RELATION_NAMES) {
      const rows = ndjsonRows(relation);
      expect(rows.length, relation).toBe(data[relation].length);
      expect(ndjson.files.find((file) => file.relation === relation)?.rowCount, relation).toBe(rows.length);
      for (const row of rows) expect(Object.keys(row), relation).toEqual([...PUBLIC_ROW_KEYS[relation]]);
      expect(rows.map(canonicalJson).sort(), relation).toEqual((data[relation] as readonly Record<string, unknown>[]).map(canonicalJson).sort());
      if (data[relation].length === 0) expect(rows, relation).toEqual([]);
    }
  });

  it('reopens the SQLite artifact with a real database reader and matches the projected rows', () => {
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    for (const relation of PUBLIC_RELATION_NAMES) {
      if (relation === 'workflows' || relation === 'releases') continue;
      const expected = (data[relation] as readonly Record<string, unknown>[])
        .map((row) => canonicalJson(Object.fromEntries(Object.entries(row).map(([key, value]) => [physicalName(key), value]))));
      expect(tables, relation).toContain(physicalName(relation));
      expect(sqliteRows(relation).map(canonicalJson).sort(), relation).toEqual(expected.sort());
    }
    // The workflows columns are the row's nested leaves, pinned to the database's own list so a rename fails.
    const columns = (db.prepare('PRAGMA table_info(workflows)').all() as { name: string }[]).map((row) => row.name);
    expect(columns).toEqual(WORKFLOW_COLUMNS.map(([column]) => column));
    const projected = data.workflows.map((row) => canonicalJson(Object.fromEntries(WORKFLOW_COLUMNS.map(([column, value]) => [column, value(row)])))).sort();
    expect(sqliteRows('workflows').map(canonicalJson).sort()).toEqual(projected);
    const stored = db.prepare('SELECT * FROM releases').get() as Record<string, unknown>;
    const release = data.release as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(release)) if (typeof value !== 'object') expect(stored[physicalName(key)], key).toBe(value);
    expect(stored.counts_json).toBe(JSON.stringify(release.counts));
    expect(stored.facet_counts_json).toBe(JSON.stringify(release.facetCounts));
  });

  it('reopens the workbook and keeps the counts, the literal text and the null/zero distinction', () => {
    const rowsBySheet: Record<string, readonly unknown[]> = { Workflows: data.workflows, Findings: data.findings, Provenance: data.sources, Requirements: data.requirements, Integrations: data.integrations, Tags: data.tags, Triggers: data.triggers };
    for (const [sheet, relationRows] of Object.entries(rowsBySheet)) expect(xlsx.sheetRowCounts[sheet], sheet).toBe(relationRows.length + 1);
    for (const [name, bytes] of readZip(fs.readFileSync(xlsx.path))) {
      if (name.startsWith('xl/worksheets/')) expect(bytes.toString('utf8'), name).not.toMatch(/<f[ >]/);
    }
    const scanned = workflowSheetRow(SCANNED_ID);
    expect(scanned('title')).toBe(`'${FORMULA_TITLE}`);
    expect(scanned('description')).toBe(`'${FORMULA_DESCRIPTION}`);
    expect(scanned('scanEvidenceScanFreshness')).toBe('CURRENT');
    const degraded = workflowSheetRow('degraded');
    expect([degraded('grade'), degraded('score')]).toEqual(['LOW', '100']);
    for (const unknown of ['indeterminate', 'unscanned', 'ruled']) {
      expect([workflowSheetRow(unknown)('grade'), workflowSheetRow(unknown)('score')], unknown).toEqual(['', '']);
    }
    const scored = workflowSheetRow('multi');
    expect([scored('grade'), scored('score')]).toEqual(['LOW', '0']);
  });

  it('carries every scan state the packet names through every format', () => {
    const rows = ndjsonRows('workflows').map((row) => [String(row.workflowId), row.scanEvidence as Record<string, unknown>] as const);
    expect(Object.fromEntries(rows.map(([id, evidence]) => [id, [evidence.scanFreshness, evidence.analysisStatus]]))).toEqual({
      [SCANNED_ID]: ['CURRENT', 'COMPLETE'], degraded: ['CURRENT', 'DEGRADED'], indeterminate: ['CURRENT', 'INDETERMINATE'],
      multi: ['HISTORICAL', null], unscanned: ['UNSCANNED', null], ruled: ['SOURCE_UNAVAILABLE', null],
    });
    expect(Object.fromEntries(rows.map(([id, evidence]) => [id, evidence.scanFreshness])))
      .toEqual(Object.fromEntries(sqliteRows('workflows').map((row) => [row.workflow_id, row.scan_freshness])));
  });

  it('publishes one data dictionary through the workbook and the database', () => {
    const shape = (row: { type: unknown; nullable: unknown; authority: unknown; rightsClass: unknown; privacyRule: unknown; derivation: unknown }) => canonicalJson({ type: row.type, nullable: row.nullable, authority: row.authority, rightsClass: row.rightsClass, privacyRule: row.privacyRule, derivation: row.derivation });
    const expected = Object.fromEntries(publicDataDictionaryRows().map((row) => [`${row.relation}\0${row.field}`, shape(row)]));
    const [header = [], ...rows] = sheetRows('Data Dictionary');
    const fromWorkbook = Object.fromEntries(rows.map((row) => {
      const cell = (name: string) => row[header.indexOf(name)] ?? '';
      return [`${cell('relation')}\0${cell('field')}`, shape({ type: cell('type'), nullable: cell('nullable') === '1', authority: cell('authority'), rightsClass: cell('rightsClass'), privacyRule: cell('privacyRule'), derivation: cell('derivation') })];
    }));
    const fromDatabase = Object.fromEntries(sqliteRows('data_dictionary').map((row) => [`${row.relation_name}\0${row.field_name}`, shape({ type: row.type, nullable: row.nullable === 1, authority: row.authority, rightsClass: row.rights_class, privacyRule: row.privacy_rule, derivation: row.derivation })]));
    expect(fromWorkbook).toEqual(expected);
    expect(fromDatabase).toEqual(expected);
  });

  it('keeps the release identity out of a row’s own scan identity', () => {
    const scanned = ndjsonRows('workflows').find((row) => row.workflowId === SCANNED_ID)!;
    expect(scanned.scanEvidence).toEqual({ scannerVersion: '2.0.0', analysisStatus: 'COMPLETE', scanFreshness: 'CURRENT', scanBodySha256: SCAN_HASH });
    expect(data.release.scannerVersion).toBe('scanner-beta-1');
    expect((scanned.scanEvidence as Record<string, unknown>).scannerVersion).not.toBe(data.release.scannerVersion);
    expect(ndjsonRows('workflows').find((row) => row.workflowId === 'ruled')?.scanEvidence)
      .toEqual({ scannerVersion: null, analysisStatus: null, scanFreshness: 'SOURCE_UNAVAILABLE', scanBodySha256: null });
  });

  it('keeps the two findings of one workflow distinct and joined in every artifact', () => {
    const findings = ndjsonRows('findings');
    expect(findings).toHaveLength(data.findings.length);
    expect(new Set(findings.map((row) => row.findingId)).size).toBe(findings.length);
    const workflowIds = new Set(ndjsonRows('workflows').map((row) => row.workflowId));
    for (const finding of findings) expect(workflowIds.has(String(finding.workflowId))).toBe(true);
    expect(sqliteRows('findings').map((row) => row.finding_id).sort()).toEqual(findings.map((row) => row.findingId).sort());
  });

  it('repeats a fixed-input export byte for byte', () => {
    const repeat = path.join(workdir, 'repeat');
    expect(writeExcelRelease(projection(), path.join(repeat, 'release.xlsx')).sha256).toBe(xlsx.sha256);
    expect(writeSqliteRelease(projection(), path.join(repeat, 'release.sqlite')).sha256).toBe(sqlite.sha256);
    expect(writeNdjsonRelease(projection(), path.join(repeat, 'ndjson')).files).toEqual(ndjson.files);
  });

  it('gives one changed input a different artifact identity', () => {
    const changed = projection([...ENTRIES, makeEntry({ id: 'extra' })]);
    expect(writeExcelRelease(changed, path.join(workdir, 'changed.xlsx')).sha256).not.toBe(xlsx.sha256);
    expect(writeSqliteRelease(changed, path.join(workdir, 'changed.sqlite')).logicalSha256).not.toBe(sqlite.logicalSha256);
    const changedNdjson = writeNdjsonRelease(changed, path.join(workdir, 'changed-ndjson'));
    const before: Record<string, string> = Object.fromEntries(ndjson.files.map((file) => [file.relation, file.sha256]));
    expect(changedNdjson.files.some((file) => file.sha256 !== before[file.relation])).toBe(true);
  });
});
