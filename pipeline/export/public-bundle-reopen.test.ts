/**
 * Reopen the exact public bundle supplied through `PUBLIC_BUNDLE_ROOT`.
 * Every fact is read back from the bundle's own files. Without a configured
 * root, the historical gitignored work bundle is used when present; otherwise
 * the real-artifact checks skip with an explicit reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3,
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4,
  type PublicWorkflowRow,
} from '@hub/contracts/public-data-model';
import type { ExportProjection } from './export-version.js';
import { verifyDatasetReleaseId } from '../../scripts/lib/public-dataset-identity.js';
import { publicDataDictionaryRows, publicDataDictionaryRowsV4 } from './public-data-dictionary.js';
import { verifyExcelRelease } from './excel.js';
import { verifyNdjsonRelease } from './ndjson.js';
import { assertPublicProjection } from './public-export-validation.js';
import { canonicalJson, physicalName, readNdjsonRows, readSheetRows, WORKFLOW_COLUMNS } from './public-evidence-parity.js';
import { PUBLIC_ROW_KEYS_V4 } from './public-row-contract.js';
import { verifySqliteRelease } from './sqlite.js';
import { readSqlitePreflight } from './sqlite-preflight.js';
import { readZip } from './xlsx-zip.js';
import {
  BUNDLE_DIR, BUILT, COMPARED, EXCEL_PATH, FORMULA_START, NDJSON_DIR, PREFLIGHT_SHEETS, RELATION_SHEETS,
  SQLITE_PATH, WORKFLOW_HEADERS, bodyNeedles, containsBodyNeedle, readJson, readManifest, sha256, workbookCellText,
  type NdjsonManifest,
} from './public-bundle-reopen-support.js';
import {
  assertExcelTruncationRecords,
  assertFrozenCandidateWorkflowCensus,
  assertManifestRelations, contentRelations, expectedWorkbookSheetNames, preflightCellText, resolveBundleRelations,
  assertWorkbookCellFloor, deriveExcelTruncationRecords,
} from './public-bundle-v4-validation.js';

type Rows = Record<string, Record<string, unknown>[]>;

function bundleRows(relations: readonly string[]): Rows {
  return Object.fromEntries(relations.map((relation) => [relation, readNdjsonRows(NDJSON_DIR, relation)]));
}

describe.skipIf(!BUILT)('the candidate bundle reopens as one dataset', () => {
  it('re-derives the declared release id from exactly the schema-specific content shards', () => {
    const manifest = readManifest();
    const ndjson = readJson<NdjsonManifest>(path.join(NDJSON_DIR, 'public-release.json'));
    const [release] = readNdjsonRows(NDJSON_DIR, 'releases');
    const relations = resolveBundleRelations(manifest.schemaVersion, ndjson.schemaVersion, release?.schemaVersion);
    expect(assertManifestRelations(ndjson.files, relations)).toBeUndefined();
    const sealed = verifyDatasetReleaseId(BUNDLE_DIR);
    expect(sealed).toMatchObject({ releaseId: manifest.releaseId, matches: true });
    expect(Object.keys(sealed.sections)).toEqual(contentRelations(relations));
    for (const digest of Object.values(sealed.sections)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches every declared shard, SQLite, and Excel byte identity', () => {
    const manifest = readManifest();
    const ndjson = readJson<NdjsonManifest>(path.join(NDJSON_DIR, 'public-release.json'));
    const [release] = readNdjsonRows(NDJSON_DIR, 'releases');
    const relations = resolveBundleRelations(manifest.schemaVersion, ndjson.schemaVersion, release?.schemaVersion);
    expect(assertManifestRelations(ndjson.files, relations)).toBeUndefined();
    expect(manifest.sourceManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.sourceCorpusSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(manifest.relations)).toEqual([...relations]);
    expect(manifest.formats.ndjson.files).toBe(relations.length);
    for (const file of ndjson.files) {
      const bytes = fs.readFileSync(path.join(NDJSON_DIR, file.path));
      expect(bytes.byteLength, file.relation).toBe(file.byteSize);
      expect(sha256(bytes), file.relation).toBe(file.sha256);
      expect(manifest.relations[file.relation], file.relation).toBe(file.rowCount);
      expect(bytes.toString('utf8').split('\n').filter(Boolean).length, file.relation).toBe(file.rowCount);
      if (file.rowCount === 0) expect(bytes.byteLength, file.relation).toBe(0);
      else expect(bytes.at(-1), file.relation).toBe(0x0a);
    }
    for (const [format, bytes] of [['sqlite', fs.readFileSync(SQLITE_PATH)], ['excel', fs.readFileSync(EXCEL_PATH)]] as const) {
      expect(bytes.byteLength, format).toBe(manifest.formats[format].byteSize);
      expect(sha256(bytes), format).toBe(manifest.formats[format].sha256);
    }
  });

  it('reopens every relation under its row, identity, join, null, and database contracts', () => {
    const manifest = readManifest();
    const ndjson = readJson<NdjsonManifest>(path.join(NDJSON_DIR, 'public-release.json'));
    const rows = bundleRows(ndjson.files.map((file) => file.relation));
    const release = rows.releases?.[0];
    const relations = resolveBundleRelations(manifest.schemaVersion, ndjson.schemaVersion, release?.schemaVersion);
    expect(assertManifestRelations(ndjson.files, relations)).toBeUndefined();
    const projection = { ...rows, schemaVersion: manifest.schemaVersion, release } as ExportProjection;
    assertPublicProjection(projection);
    expect(verifyNdjsonRelease(projection, NDJSON_DIR, ndjson)).toBe(true);
    expect(verifySqliteRelease(projection, SQLITE_PATH)).toBe(true);
    expect(verifyExcelRelease(projection, EXCEL_PATH)).toBe(true);
    const db = new DatabaseSync(SQLITE_PATH, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
        .toBe(manifest.schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4 ? 3 : 2);
      const preflight = new Set(['preflightCoverage', 'preflightEvidence']);
      for (const relation of relations) {
        if (relation === 'workflows' || relation === 'releases' || preflight.has(relation)) continue;
        const table = physicalName(relation);
        const shard = rows[relation]!;
        const stored = db.prepare(`SELECT * FROM ${table}`).all() as unknown as Record<string, unknown>[];
        expect(shard.length, relation).toBe(manifest.relations[relation]);
        expect(stored.length, relation).toBe(shard.length);
        expect((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name), relation)
          .toEqual([...PUBLIC_ROW_KEYS_V4[relation]].map(physicalName));
        for (const row of shard) expect(Object.keys(row), relation).toEqual([...PUBLIC_ROW_KEYS_V4[relation]]);
        expect(stored.map(canonicalJson).sort(), relation).toEqual(shard
          .map((row) => canonicalJson(Object.fromEntries(Object.entries(row).map(([key, value]) => [physicalName(key), value])))).sort());
      }
      const columns = (db.prepare('PRAGMA table_info(workflows)').all() as { name: string }[]).map((row) => row.name);
      expect(columns).toEqual(WORKFLOW_COLUMNS.map(([column]) => column));
      const workflows = rows.workflows!;
      const projected = workflows.map((row) => canonicalJson(Object.fromEntries(WORKFLOW_COLUMNS
        .map(([column, value]) => [column, value(row as unknown as PublicWorkflowRow)]))));
      expect((db.prepare('SELECT * FROM workflows').all() as unknown as Record<string, unknown>[]).map(canonicalJson).sort())
        .toEqual(projected.sort());
      const storedRelease = db.prepare('SELECT * FROM releases').get() as Record<string, unknown>;
      for (const [key, value] of Object.entries(release!)) if (typeof value !== 'object') expect(storedRelease[physicalName(key)], key).toBe(value);
      expect(canonicalJson(JSON.parse(String(storedRelease.counts_json)))).toBe(canonicalJson(release!.counts));
      expect(canonicalJson(JSON.parse(String(storedRelease.facet_counts_json)))).toBe(canonicalJson(release!.facetCounts));
      if (manifest.schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4) {
        const storedPreflight = readSqlitePreflight(db);
        for (const relation of ['preflightCoverage', 'preflightEvidence'] as const) {
          expect(storedPreflight[relation]!.map(canonicalJson).sort(), relation).toEqual(rows[relation]!.map(canonicalJson).sort());
        }
      }
    } finally {
      db.close();
    }
    const census = rows.workflows!.length;
    expect(assertFrozenCandidateWorkflowCensus(census)).toBeUndefined();
    expect(census).toBe(manifest.relations.workflows);
  }, 60_000);

  it('reopens the workbook with exact sheets, rows, literals, nulls, formulas, and truncation', () => {
    const manifest = readManifest();
    const ndjson = readJson<NdjsonManifest>(path.join(NDJSON_DIR, 'public-release.json'));
    const rows = bundleRows(ndjson.files.map((file) => file.relation));
    const release = rows.releases?.[0];
    const relations = resolveBundleRelations(manifest.schemaVersion, ndjson.schemaVersion, release?.schemaVersion);
    const projection = { ...rows, schemaVersion: manifest.schemaVersion, release } as ExportProjection;
    const workbook = fs.readFileSync(EXCEL_PATH);
    const archive = readZip(workbook);
    const sheetNames = [...archive.get('xl/workbook.xml')!.toString('utf8').matchAll(/<sheet\s+name="([^"]+)"/g)].map((match) => match[1]!);
    expect(sheetNames).toEqual(expectedWorkbookSheetNames(manifest.schemaVersion));
    const counts = manifest.formats.excel.sheetRowCounts;
    expect(counts.Workflows).toBe(manifest.relations.workflows! + 1);
    for (const [sheet, relation] of RELATION_SHEETS) expect(counts[sheet], sheet).toBe(manifest.relations[relation]! + 1);
    if (manifest.schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4) {
      for (const [sheet, relation] of PREFLIGHT_SHEETS) expect(counts[sheet], sheet).toBe(manifest.relations[relation]! + 1);
    }
    const dictionary = manifest.schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4 ? publicDataDictionaryRowsV4() : publicDataDictionaryRows();
    expect(counts['Data Dictionary']).toBe(dictionary.length + 1);
    expect(counts['Release Metadata']).toBe(Object.keys(release!).length + 4);
    expect(counts.README).toBe(8);
    for (const [name, bytes] of archive) if (name.startsWith('xl/worksheets/')) expect(bytes.toString('utf8'), name).not.toMatch(/<f(?:\s|>)/);
    const workbookRows = Object.fromEntries(sheetNames.map((sheet) => [sheet, readSheetRows(workbook, sheet)])) as Record<string, string[][]>;
    const metadata = workbookRows['Release Metadata'];
    const recorded = (field: string) => metadata.find((row) => row[0] === field)?.[1] ?? '';
    const truncation = manifest.formats.excel.truncation;
    const truncationAudit = deriveExcelTruncationRecords(projection, workbookRows);
    expect(assertWorkbookCellFloor(truncationAudit.cellCount)).toBeUndefined();
    expect(assertExcelTruncationRecords(truncation, truncationAudit.cells)).toBeUndefined();
    expect(recorded('excelTruncationLimit')).toBe(String(truncation.limit));
    expect(recorded('excelTruncatedCells')).toBe(String(truncation.count));
    expect(recorded('excelTruncatedFields')).toBe(JSON.stringify(truncation.fields));
    expect(truncation.cells).toHaveLength(truncation.count);
    expect([...new Set(truncation.cells.map((cell) => cell.field))].sort()).toEqual([...truncation.fields].sort());
    for (const cell of truncation.cells) {
      expect(sheetNames).toContain(cell.sheet);
      expect(cell.originalLength).toBeGreaterThan(cell.keptLength);
      expect(cell.keptLength).toBeLessThanOrEqual(truncation.limit);
    }
    const [header = [], ...workflowRows] = workbookRows['Workflows'];
    expect(header).toEqual([...WORKFLOW_HEADERS]);
    const columnOf = (name: string) => header.indexOf(name);
    const workflows = new Map(readNdjsonRows(NDJSON_DIR, 'workflows').map((row) => [String(row.workflowId), row]));
    for (const cells of workflowRows) {
      const id = cells[columnOf('workflowId')] ?? '';
      const row = workflows.get(id);
      expect(row, id).toBeDefined();
      for (const [name, value] of COMPARED) {
        const expected = workbookCellText(value(row!));
        expect(cells[columnOf(name)], `${id}.${name}`).toBe(expected);
      }
    }
    if (manifest.schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4) {
      for (const [sheet, relation] of PREFLIGHT_SHEETS) {
        const [sheetHeader = [], ...sheetRows] = workbookRows[sheet];
        expect(sheetHeader).toEqual([...PUBLIC_ROW_KEYS_V4[relation]]);
        const shard = readNdjsonRows(NDJSON_DIR, relation);
        expect(sheetRows).toHaveLength(shard.length);
        for (const [index, row] of shard.entries()) {
          for (const [column, key] of sheetHeader.entries()) {
            const expected = workbookCellText(preflightCellText(key, row[key]));
            expect(sheetRows[index]![column], `${relation}.${index}.${key}`).toBe(expected);
          }
        }
      }
    }
    let offenders = 0;
    for (const sheet of sheetNames) {
      const sheetRows = workbookRows[sheet];
      expect(sheetRows.length, sheet).toBe(counts[sheet]);
      for (const cells of sheetRows) for (const text of cells) if (FORMULA_START.test(text)) offenders += 1;
    }
    expect(offenders).toBe(0);
  }, 60_000);

  it('carries no workflow body bytes from the corpus', () => {
    const manifest = readManifest();
    const ndjson = readJson<NdjsonManifest>(path.join(NDJSON_DIR, 'public-release.json'));
    const [release] = readNdjsonRows(NDJSON_DIR, 'releases');
    const relations = resolveBundleRelations(manifest.schemaVersion, ndjson.schemaVersion, release?.schemaVersion);
    expect(assertManifestRelations(ndjson.files, relations)).toBeUndefined();
    const { source, needles } = bodyNeedles();
    const sourceText = fs.readFileSync(source, 'utf8');
    expect(needles.length, source).toBeGreaterThanOrEqual(3);
    for (const needle of needles) expect(sourceText.includes(needle), 'needle control').toBe(true);
    const docs = ['public-release.json', 'schema.json', 'data-dictionary.json', 'release-notes.md', 'examples.json'];
    for (const needle of needles) {
      for (const relation of relations) expect(containsBodyNeedle(path.join(NDJSON_DIR, `${relation}.ndjson`), needle), relation).toBe(false);
      for (const file of docs) expect(fs.readFileSync(path.join(BUNDLE_DIR, file), 'utf8').includes(needle), file).toBe(false);
      expect(containsBodyNeedle(SQLITE_PATH, needle), 'release.sqlite').toBe(false);
      for (const [name, bytes] of readZip(fs.readFileSync(EXCEL_PATH))) expect(bytes.includes(needle), name).toBe(false);
    }
  });
});
