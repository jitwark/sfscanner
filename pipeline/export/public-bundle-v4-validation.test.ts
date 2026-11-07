import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3,
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4,
  PUBLIC_RELATION_NAMES,
  PUBLIC_RELATION_NAMES_V4,
} from '@hub/contracts/public-data-model';
import type { CorpusV2InputReceipt } from '../../scripts/lib/corpus-v2-input-inventory.js';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { releaseForEntries } from '../__fixtures__/scan-provenance-cases.js';
import { deriveCapturedBody, publicSourceId } from './body-derived-metadata.js';
import { writeExcelRelease } from './excel.js';
import { buildPublicProjectionV4 } from './public-projection-v4.js';
import { projectionSections, sealedDatasetId } from '../../scripts/lib/public-dataset-identity.js';
import { canonicalJson, readSheetRows } from './public-evidence-parity.js';
import { verifyExcelRelease } from './excel.js';
import { canonicalRowBytes } from './ndjson.js';
import {
  assertExcelTruncationRecords,
  assertFrozenCandidateWorkflowCensus,
  assertManifestRelations,
  assertWorkbookCellFloor,
  contentRelations,
  deriveExcelTruncationRecords,
  expectedWorkbookSheetNames,
  preflightCellText,
  resolveBundleRelations,
} from './public-bundle-v4-validation.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const files = (relations: readonly string[]) => relations.map((relation) => ({
  relation, path: `${relation}.ndjson`, rowCount: 0, byteSize: 0, sha256: 'a'.repeat(64),
}));
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

function longTextWorkbook() {
  const entry = makeEntry({ id: 'long-cell', title: `=${'x'.repeat(32_767)}`, download: undefined });
  const body = { nodes: [{ name: 'Set', type: 'n8n-nodes-base.set', parameters: {} }], connections: {} };
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const inventorySha256 = 'b'.repeat(64);
  const receipt = (): CorpusV2InputReceipt => ({
    entryId: entry.id, identityKind: 'GITHUB', status: 'AVAILABLE', bodySha256: hash(bytes), byteLength: bytes.length,
    sourceCommit: 'private', sourcePath: 'private', reasonCode: null,
  });
  const preflight = deriveCapturedBody(receipt(), inventorySha256, publicSourceId(entry), bytes).preflight;
  const dataEntry = { ...entry, readiness: deriveCapturedBody(receipt(), inventorySha256, publicSourceId(entry), bytes, true).replacement!.readiness };
  const metadata = { ...releaseForEntries([dataEntry]), schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4 };
  const pending = buildPublicProjectionV4([dataEntry], { release: metadata, preflight: [preflight], inventorySha256 });
  const releaseId = sealedDatasetId(metadata, projectionSections(pending));
  const projection = buildPublicProjectionV4([dataEntry], {
    release: { ...metadata, releaseId }, preflight: [preflight], inventorySha256,
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-excel-audit-')); roots.push(root);
  const workbook = writeExcelRelease(projection, path.join(root, 'release.xlsx'));
  const bytesRead = fs.readFileSync(workbook.path);
  const sheets = Object.fromEntries(expectedWorkbookSheetNames(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4)
    .map((name) => [name, readSheetRows(bytesRead, name)]));
  return { projection, workbook, sheets };
}

describe('public bundle schema-specific validation', () => {
  it('selects the canonical V3 and V4 relation sets and rejects unknown or mixed versions', () => {
    expect(resolveBundleRelations(
      PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3,
      PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3,
      PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3,
    )).toEqual(PUBLIC_RELATION_NAMES);
    expect(resolveBundleRelations(
      PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4,
      PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4,
      PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4,
    )).toEqual(PUBLIC_RELATION_NAMES_V4);
    expect(() => resolveBundleRelations('public-data-model-v5', 'public-data-model-v5', 'public-data-model-v5'))
      .toThrow(/unsupported schema version/i);
    expect(() => resolveBundleRelations(
      PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4,
      PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3,
      PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4,
    )).toThrow(/mixed schema versions/i);
  });

  it('requires the exact manifest order, unique supported relations and canonical shard paths', () => {
    expect(() => assertManifestRelations(files(PUBLIC_RELATION_NAMES_V4), PUBLIC_RELATION_NAMES_V4)).not.toThrow();
    expect(() => assertManifestRelations(files(PUBLIC_RELATION_NAMES), PUBLIC_RELATION_NAMES_V4))
      .toThrow(/exactly 18 relations/i);

    const duplicate = files(PUBLIC_RELATION_NAMES_V4);
    duplicate[17] = { ...duplicate[0]! };
    expect(() => assertManifestRelations(duplicate, PUBLIC_RELATION_NAMES_V4)).toThrow(/duplicate relation releases/i);

    const misplaced = files(PUBLIC_RELATION_NAMES_V4);
    misplaced[0] = { ...misplaced[0]!, path: 'other/releases.ndjson' };
    expect(() => assertManifestRelations(misplaced, PUBLIC_RELATION_NAMES_V4)).toThrow(/canonical path/i);

    const reordered = files(PUBLIC_RELATION_NAMES_V4);
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    expect(() => assertManifestRelations(reordered, PUBLIC_RELATION_NAMES_V4)).toThrow(/order mismatch/i);
  });

  it('derives identity content relations from the row contract and preserves V4 preflight coverage', () => {
    expect(contentRelations(PUBLIC_RELATION_NAMES)).toEqual(
      PUBLIC_RELATION_NAMES.filter((relation) => relation !== 'releases' && relation !== 'artifacts'),
    );
    expect(contentRelations(PUBLIC_RELATION_NAMES_V4)).toEqual(
      PUBLIC_RELATION_NAMES_V4.filter((relation) => relation !== 'releases' && relation !== 'artifacts'),
    );
    expect(contentRelations(PUBLIC_RELATION_NAMES_V4).slice(-2)).toEqual(['preflightCoverage', 'preflightEvidence']);
  });

  it('uses the V4 twelve-sheet order while retaining the legacy ten-sheet V3 order', () => {
    expect(expectedWorkbookSheetNames(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3)).toHaveLength(10);
    expect(expectedWorkbookSheetNames(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4)).toEqual([
      'README', 'Workflows', 'Findings', 'Integrations', 'Tags', 'Triggers', 'Provenance',
      'Requirements', 'Release Metadata', 'Data Dictionary', 'Preflight Coverage', 'Preflight Evidence',
    ]);
  });

  it('carries numbers, canonical arrays, nulls and spreadsheet formula guards exactly', () => {
    expect(preflightCellText('nodeIndex', 0)).toBe('0');
    expect(preflightCellText('nodeName', null)).toBe('');
    expect(preflightCellText('omissionCodes', ['BODY_MISSING'])).toBe('["BODY_MISSING"]');
    expect(preflightCellText('detailPointer', '=HYPERLINK("https://example.test")'))
      .toBe(`'=HYPERLINK("https://example.test")`);
  });

  it('binds release volume to the frozen candidate rather than a self-consistent manifest', () => {
    expect(() => assertFrozenCandidateWorkflowCensus(0)).toThrow(/11,?464/);
    expect(() => assertFrozenCandidateWorkflowCensus(11_464)).not.toThrow();
    expect(() => assertWorkbookCellFloor(250_000)).toThrow(/250,?000/);
    expect(() => assertWorkbookCellFloor(250_001)).not.toThrow();
  });

  it('derives every truncation from real writer output and rejects omitted, extra, and forged records', () => {
    const { projection, workbook, sheets } = longTextWorkbook();
    const audit = deriveExcelTruncationRecords(projection, sheets);
    expect(audit.cells).toHaveLength(1);
    expect(audit.cells[0]).toMatchObject({ sheet: 'Workflows', field: 'Workflows.title', row: 2 });
    expect(audit.cells[0]!.keptPrefix).toHaveLength(32_767);
    expect(audit.cells[0]!.keptPrefix.startsWith("'=")).toBe(true);
    expect(workbook.truncation.cells).toEqual(audit.cells.map(({ keptPrefix: _keptPrefix, ...record }) => record));
    expect(() => assertExcelTruncationRecords(workbook.truncation, audit.cells)).not.toThrow();

    const forgedZero = { ...workbook.truncation, count: 0, fields: [], cells: [] };
    expect(() => assertExcelTruncationRecords(forgedZero, audit.cells)).toThrow(/count/i);
    const forgedMetadataSheets = structuredClone(sheets);
    const metadataRows = forgedMetadataSheets['Release Metadata']!;
    metadataRows.find((row) => row[0] === 'excelTruncatedCells')![1] = '0';
    metadataRows.find((row) => row[0] === 'excelTruncatedFields')![1] = '[]';
    expect(() => deriveExcelTruncationRecords(projection, forgedMetadataSheets)).toThrow(/Release Metadata cell mismatch/i);
    const forgedOriginal = { ...workbook.truncation, cells: [{ ...workbook.truncation.cells[0]!, originalLength: 1 }] };
    expect(() => assertExcelTruncationRecords(forgedOriginal, audit.cells)).toThrow(/record/i);
    const extra = { ...workbook.truncation, count: 2, cells: [...workbook.truncation.cells, workbook.truncation.cells[0]!] };
    expect(() => assertExcelTruncationRecords(extra, audit.cells)).toThrow(/count|record/i);

    const tamperedSheets = structuredClone(sheets);
    const column = tamperedSheets.Workflows![0]!.indexOf('title');
    tamperedSheets.Workflows![1]![column] = 'forged-prefix';
    expect(() => deriveExcelTruncationRecords(projection, tamperedSheets)).toThrow(/cell mismatch/i);
  });

  it('records object release metadata canonically so a canonical reopen matches the workbook', () => {
    const { projection, workbook, sheets } = longTextWorkbook();
    const release = JSON.parse(canonicalRowBytes('releases', projection.release).toString('utf8')) as typeof projection.release;
    const reopened = { ...projection, release, releases: [release] } as typeof projection;
    expect(() => verifyExcelRelease(reopened, workbook.path)).not.toThrow();
    expect(() => deriveExcelTruncationRecords(reopened, sheets)).not.toThrow();
    const metadata = readSheetRows(fs.readFileSync(workbook.path), 'Release Metadata');
    const recordedCounts = metadata.find((row) => row[0] === 'counts')?.[1];
    expect(recordedCounts).toBe(canonicalJson(reopened.release.counts));
  });
});
