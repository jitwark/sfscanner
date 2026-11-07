import { stylesXml, workbookXml, contentTypes, relationships, rootRelationships } from './excel-envelope.js';
import { preflightSheets } from './excel-preflight.js';
import { canonicalJson, relationNames, relationRows, dictionaryRows, isV4, type ExportProjection } from './export-version.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { type PublicWorkflowRow } from '@hub/contracts/public-data-model';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { createZip, readZip, type ZipEntry } from './xlsx-zip.js';
import { writeAtomicFileWithWriter } from './atomic-file.js';
import { assertPublicProjection } from './public-export-validation.js';
import { assertXmlParts, verifyExcelXmlParts } from './xlsx-xml.js';
import { EXCEL_MAX_WORKSHEET_ROWS, assertFinalSheetRowLimits } from './xlsx-sheet-limits.js';
export { EXCEL_MAX_WORKSHEET_ROWS, assertFinalSheetRowLimits, verifyExcelXmlParts };

type Cell = string | number | boolean | null;
type Sheet = { name: string; rows: Cell[][] };
const LIMIT = 32_767;
/** Characters Excel refuses outright; stripped before the value is measured against `LIMIT`. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g;
const FORMULA_START = /^[=+\-@]/;
const README_SHEET = 'README';
const RELEASE_METADATA_SHEET = 'Release Metadata';
const SHEET_NAMES = ['README', 'Workflows', 'Findings', 'Integrations', 'Tags', 'Triggers', 'Provenance', 'Requirements', 'Release Metadata', 'Data Dictionary'] as const;

/** One workbook cell whose text could not fit Excel's per-cell limit. */
export type ExcelCellTruncation = { sheet: string; field: string; row: number; originalLength: number; keptLength: number };

/**
 * What a workbook had to leave out, recorded rather than hidden. Excel cannot
 * store more than `limit` characters in a cell, so the writer clips — but a
 * clipped cell always appears here with the relation field it belongs to, and
 * the count is written into machine-readable release metadata.
 */
export type ExcelTruncation = { limit: number; count: number; fields: string[]; cells: ExcelCellTruncation[] };

/**
 * Returns the text Excel will store plus whether the limit clipped it. The
 * formula guard is applied *before* the limit: clipping first would emit
 * `LIMIT + 1` characters for a cell starting with `=`, `+`, `-`, or `@`.
 */
function cleanCellText(value: string): { text: string; clipped: boolean } {
  const stripped = value.replace(CONTROL_CHARACTERS, '');
  const guarded = FORMULA_START.test(stripped) ? `'${stripped}` : stripped;
  return guarded.length > LIMIT ? { text: guarded.slice(0, LIMIT), clipped: true } : { text: guarded, clipped: false };
}
function clean(value: string): string { return cleanCellText(value).text; }
function xml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function column(index: number): string { let value = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) value = String.fromCharCode(65 + ((n - 1) % 26)) + value; return value; }
function cell(reference: string, value: Cell, style: number): string {
  if (value === null) return `<c r="${reference}" s="${style}"/>`;
  if (typeof value === 'number' || typeof value === 'boolean') return `<c r="${reference}" s="${style}" t="${typeof value === 'boolean' ? 'b' : 'n'}"><v>${typeof value === 'boolean' ? (value ? 1 : 0) : value}</v></c>`;
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(clean(value))}</t></is></c>`;
}
function sheetXml(sheet: Sheet): string {
  // `Math.max(...array)` spreads every element into a single call, and V8
  // rejects that once the array is large enough (measured on this engine:
  // fine at 125,000 elements, a RangeError at 130,000) — the real corpus's
  // Requirements sheet has 130,972 rows. `reduce` visits the same values
  // without ever making them call arguments.
  const width = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const end = `${column(width - 1)}${sheet.rows.length}`;
  const columns = Array.from({ length: width }, (_, index) => {
    const longest = sheet.rows.reduce((max, row) => {
      const cellLines = String(row[index] ?? '').split('\n').reduce((lineMax, part) => Math.max(lineMax, part.length), 0);
      return Math.max(max, cellLines);
    }, 0);
    return `<col min="${index + 1}" max="${index + 1}" width="${Math.min(48, Math.max(12, Math.min(46, longest + 2)))}" customWidth="1"/>`;
  }).join('');
  const rows = sheet.rows.map((row, rowIndex) => `<row r="${rowIndex + 1}"${rowIndex === 0 ? ' ht="24" customHeight="1"' : ''}>${row.map((value, index) => cell(`${column(index)}${rowIndex + 1}`, value, rowIndex === 0 ? 1 : 0)).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${columns}</cols><dimension ref="A1:${end}"/><sheetData>${rows}</sheetData>${sheet.rows.length > 1 ? `<autoFilter ref="A1:${end}"/>` : ''}</worksheet>`;
}
/**
 * The Workflows sheet's columns, in dictionary field order. `body` and `scanEvidence` are one
 * logical field each, so they publish one column per leaf. This single list builds both the header
 * row and every data cell, and the sheet test holds the list against the published data dictionary,
 * so a writer column cannot drift from the row contract. `grade`/`score` publish the projection's
 * fact value and are null whenever the fact is not known — never a grade re-derived here.
 */
const WORKFLOW_SHEET_COLUMNS: readonly { field: string; header: string; value: (row: PublicWorkflowRow) => Cell }[] = [
  { field: 'workflowId', header: 'workflowId', value: (row) => row.workflowId },
  { field: 'title', header: 'title', value: (row) => row.title },
  { field: 'description', header: 'description', value: (row) => row.description },
  { field: 'descriptionAuthority', header: 'descriptionAuthority', value: (row) => row.descriptionAuthority },
  { field: 'sourceId', header: 'sourceId', value: (row) => row.sourceId },
  { field: 'rightsStatus', header: 'rightsStatus', value: (row) => row.rightsStatus },
  { field: 'body', header: 'bodyKind', value: (row) => row.body?.kind ?? null },
  { field: 'body', header: 'bodyPath', value: (row) => row.body?.kind === 'path' ? row.body.path : null },
  { field: 'body', header: 'bodySha256', value: (row) => row.body?.sha256 ?? null },
  { field: 'grade', header: 'grade', value: (row) => row.grade.status === 'known' ? row.grade.value : null },
  { field: 'score', header: 'score', value: (row) => row.score.status === 'known' ? row.score.value : null },
  { field: 'completeness', header: 'completeness', value: (row) => row.completeness },
  { field: 'complexity', header: 'complexity', value: (row) => row.complexity },
  { field: 'nodeCount', header: 'nodeCount', value: (row) => row.nodeCount },
  { field: 'connectionCount', header: 'connectionCount', value: (row) => row.connectionCount },
  { field: 'readinessStatus', header: 'readinessStatus', value: (row) => row.readinessStatus },
  { field: 'scanEvidence.scannerVersion', header: 'scanEvidenceScannerVersion', value: (row) => row.scanEvidence.scannerVersion },
  { field: 'scanEvidence.analysisStatus', header: 'scanEvidenceAnalysisStatus', value: (row) => row.scanEvidence.analysisStatus },
  { field: 'scanEvidence.scanFreshness', header: 'scanEvidenceScanFreshness', value: (row) => row.scanEvidence.scanFreshness },
  { field: 'scanEvidence.scanBodySha256', header: 'scanEvidenceScanBodySha256', value: (row) => row.scanEvidence.scanBodySha256 },
];

function tableRows(projection: ExportProjection): Sheet[] {
  const named = (name: string, rows: readonly { id: string; label: string }[]): Sheet => ({ name, rows: [['id', 'label'], ...rows.map((row) => [row.id, row.label])] });
  const workflows = projection.workflows.map((row) => WORKFLOW_SHEET_COLUMNS.map((column) => column.value(row)));
  const findings = projection.findings.map((row) => [row.findingId, row.workflowId, row.policyId, row.severity, row.category, row.effect, row.confidence, row.title, row.remediation] as Cell[]);
  const sources = projection.sources.map((row) => [row.sourceId, row.kind, row.publicUrl, row.repositoryUrl, row.licence, row.licenceUrl] as Cell[]);
  const requirements = projection.requirements.map((row) => [row.requirementId, row.workflowId, row.kind, row.label, row.status] as Cell[]);
  const metadata: Cell[][] = [['field', 'value'], ...Object.entries(projection.release).flatMap(([key, value]) => typeof value === 'object' && value !== null ? [[key, canonicalJson(value)] as Cell[]] : [[key, value as Cell]])];
  const dictionary: Cell[][] = [['relation', 'field', 'type', 'nullable', 'authority', 'rightsClass', 'privacyRule', 'derivation'], ...dictionaryRows(projection).map((row) => [row.relation, row.field, row.type, row.nullable, row.authority, row.rightsClass, row.privacyRule, row.derivation] as Cell[])];
  return [
    { name: README_SHEET, rows: [
      ['SecureFlow Community Hub public data release', null],
      ['Release', projection.release.releaseId],
      ['Schema', projection.schemaVersion],
      ['Purpose', 'Deterministic, rights-aware normalized workflow data.'],
      ['Limitations', 'Descriptions are prose; security findings are deterministic scanner output, not an execution guarantee.'],
      ['Body policy', 'Workflow bodies are release-relative references only for redistributable records.'],
      ['Text limits', 'An Excel cell holds at most 32,767 characters. The complete value is always in the NDJSON and SQLite artifacts of this release; a cell clipped here is counted, with its field, as excelTruncatedCells and excelTruncatedFields on the Release Metadata sheet.'],
      ['Credentials relation', isV4(projection) ? 'Legacy credential and community reference rows retain their counts with fixed category labels and public ordinals. Original type/package tokens and their hashes are withheld. Source-bound prerequisite facts live in Preflight Coverage and Preflight Evidence; live facts remain UNKNOWN.' : 'The credentials relation is the deduplicated set of credential types this release references, and Requirements rows with kind = "credential" are those same references at workflow grain (one row per workflow and credential type). The two come from one derivation, so they cannot disagree about presence. A credentials count of zero means no credential reference was recorded in this release; it does not mean the workflows need none to run.'],
    ] },
    { name: 'Workflows', rows: [WORKFLOW_SHEET_COLUMNS.map((column) => column.header), ...workflows] },
    { name: 'Findings', rows: [['findingId', 'workflowId', 'policyId', 'severity', 'category', 'effect', 'confidence', 'title', 'remediation'], ...findings] },
    named('Integrations', projection.integrations), named('Tags', projection.tags), named('Triggers', projection.triggers),
    { name: 'Provenance', rows: [['sourceId', 'kind', 'publicUrl', 'repositoryUrl', 'licence', 'licenceUrl'], ...sources] },
    { name: 'Requirements', rows: [['requirementId', 'workflowId', 'kind', 'label', 'status'], ...requirements] },
    { name: RELEASE_METADATA_SHEET, rows: metadata }, { name: 'Data Dictionary', rows: dictionary },
    ...preflightSheets(projection),
  ];
}

/** Stable field identity for a clipped cell: `Sheet.header` for data rows, `Sheet.column A` for header rows. */
function fieldLabel(sheet: Sheet, columnIndex: number, rowIndex: number): string {
  const header = rowIndex > 0 ? sheet.rows[0]?.[columnIndex] : undefined;
  return `${sheet.name}.${typeof header === 'string' && header.length > 0 ? header : `column ${column(columnIndex)}`}`;
}

/** Every cell the workbook will clip, measured from the same values `sheetXml` serializes. */
function measureTruncations(sheets: readonly Sheet[]): ExcelTruncation {
  const cells: ExcelCellTruncation[] = [];
  for (const sheet of sheets) {
    for (const [rowIndex, row] of sheet.rows.entries()) {
      for (const [columnIndex, value] of row.entries()) {
        // Cheap guard: stripping control characters never lengthens a value and
        // the formula guard adds at most one character, so nothing shorter than
        // the limit can clip. Only the exceptional cell pays for the transform.
        if (typeof value !== 'string' || value.length < LIMIT) continue;
        const measured = cleanCellText(value);
        if (!measured.clipped) continue;
        cells.push({ sheet: sheet.name, field: fieldLabel(sheet, columnIndex, rowIndex), row: rowIndex + 1, originalLength: value.length, keptLength: measured.text.length });
      }
    }
  }
  return { limit: LIMIT, count: cells.length, fields: [...new Set(cells.map((cell) => cell.field))].sort(compareCanonicalStrings), cells };
}

function truncationSummaryRows(truncation: ExcelTruncation): Cell[][] {
  const rows: Cell[][] = [['excelTruncationLimit', truncation.limit], ['excelTruncatedCells', truncation.count], ['excelTruncatedFields', JSON.stringify(truncation.fields)]];
  // These rows are short by construction. If one ever is not, failing beats
  // writing a summary that its own workbook had to clip.
  for (const row of rows) for (const value of row) if (typeof value === 'string' && cleanCellText(value).clipped) throw new Error('XLSX: truncation summary exceeds the Excel cell limit');
  return rows;
}

/**
 * The workbook as it will be written: the truncation summary is appended to the
 * Release Metadata sheet, so the count a reader sees is the count the writer
 * measured. Both `writeExcelRelease` and `verifyExcelRelease` build the sheets
 * through here, which is what makes read-back parity check the recorded numbers.
 */
function expectedSheets(projection: ExportProjection, rowLimit = EXCEL_MAX_WORKSHEET_ROWS): { sheets: Sheet[]; truncation: ExcelTruncation } {
  const tables = tableRows(projection);
  const truncation = measureTruncations(tables);
  const summary = truncationSummaryRows(truncation);
  const sheets = tables.map((sheet) => (sheet.name === RELEASE_METADATA_SHEET ? { name: sheet.name, rows: [...sheet.rows, ...summary] } : sheet));
  assertFinalSheetRowLimits(sheets, rowLimit);
  return { sheets, truncation };
}

export function expectedSheetRowsForTest(projection: ExportProjection, rowLimit = EXCEL_MAX_WORKSHEET_ROWS): readonly { name: string; rows: readonly unknown[] }[] { return expectedSheets(projection, rowLimit).sheets; }
export function expectedExcelSheetRowCounts(projection: ExportProjection): Record<string, number> { return Object.fromEntries(expectedSheets(projection).sheets.map((sheet) => [sheet.name, sheet.rows.length])); }

export type ExcelReleaseInfo = { path: string; byteSize: number; sha256: string; logicalSha256: string; sheetRowCounts: Record<string, number>; truncation: ExcelTruncation };
function hash(value: Uint8Array | string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function logicalPayload(projection: ExportProjection): string { return relationNames(projection).map((relation) => `${relation}\n${(isV4(projection) ? canonicalJson(relationRows(projection, relation)) : JSON.stringify(relationRows(projection, relation)))}`).join('\n'); }
function unxml(value: string): string { return value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]!); }
function columnIndex(value: string): number { return [...value].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1; }
function safeRows(rows: readonly Cell[][]): Cell[][] { return rows.map((row) => row.map((value) => typeof value === 'string' ? clean(value) : value)); }

function parseCell(attributes: string, body: string | undefined, sheet: string): Cell {
  if (body === undefined) {
    if (/\bt=/.test(attributes)) throw new Error(`XLSX: ${sheet} malformed null cell`);
    return null;
  }
  if (/<f(?:\s|>)/.test(body)) throw new Error(`XLSX: ${sheet} formula cell detected`);
  const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
  if (type === 'inlineStr') {
    const text = /<t(?: [^>]*)?>([\s\S]*)<\/t>/.exec(body)?.[1];
    if (text === undefined) throw new Error(`XLSX: ${sheet} malformed inline string`);
    return unxml(text);
  }
  const value = /<v>([\s\S]*)<\/v>/.exec(body)?.[1];
  if (value === undefined || (type && type !== 'n' && type !== 'b')) throw new Error(`XLSX: ${sheet} malformed typed cell`);
  if (type === 'b') {
    if (value !== '0' && value !== '1') throw new Error(`XLSX: ${sheet} malformed boolean cell`);
    return value === '1';
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`XLSX: ${sheet} malformed numeric cell`);
  return number;
}

function readSheetRows(content: string, sheet: string): Cell[][] {
  const rows: Cell[][] = []; const rowPattern = /<row\s+r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g; let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(content)) !== null) {
    const rowNumber = Number(rowMatch[1]); if (rowNumber !== rows.length + 1) throw new Error(`XLSX: ${sheet} row ordering mismatch`);
    const values: Cell[] = []; const cellPattern = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(rowMatch[2])) !== null) {
      const reference = /\br="([A-Z]+)(\d+)"/.exec(cellMatch[1]);
      if (!reference || Number(reference[2]) !== rowNumber || columnIndex(reference[1]!) !== values.length) throw new Error(`XLSX: ${sheet} cell ordering mismatch`);
      values.push(parseCell(cellMatch[1], cellMatch[2], sheet));
    }
    rows.push(values);
  }
  return rows;
}

function workbookSheetNames(workbook: string): string[] { return [...workbook.matchAll(/<sheet\s+name="([^"]+)"[^>]*\/>/g)].map((match) => unxml(match[1]!)); }

export function writeExcelRelease(projection: ExportProjection, outputPath: string): ExcelReleaseInfo {
  assertPublicProjection(projection);
  const { sheets, truncation } = expectedSheets(projection); const entries: ZipEntry[] = [{ name: '[Content_Types].xml', data: Buffer.from(contentTypes(sheets.map((sheet) => sheet.name))) }, { name: '_rels/.rels', data: Buffer.from(rootRelationships()) }, { name: 'xl/workbook.xml', data: Buffer.from(workbookXml(sheets.map((sheet) => sheet.name))) }, { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(relationships(sheets.map((sheet) => sheet.name))) }, { name: 'xl/styles.xml', data: Buffer.from(stylesXml()) }];
  for (const [index, sheet] of sheets.entries()) entries.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: Buffer.from(sheetXml(sheet)) });
  const bytes = createZip(entries);
  writeAtomicFileWithWriter(outputPath, (temporaryPath) => {
    fs.writeFileSync(temporaryPath, bytes);
    verifyExcelRelease(projection, temporaryPath);
  });
  return { path: outputPath, byteSize: bytes.byteLength, sha256: hash(bytes), logicalSha256: hash(logicalPayload(projection)), sheetRowCounts: Object.fromEntries(sheets.map((sheet) => [sheet.name, sheet.rows.length])), truncation };
}

export function verifyExcelRelease(projection: ExportProjection, outputPath: string): true {
  const files = readZip(fs.readFileSync(outputPath)); const workbook = files.get('xl/workbook.xml')?.toString('utf8'); if (!workbook || !files.has('[Content_Types].xml') || !files.has('xl/styles.xml')) throw new Error('XLSX: missing workbook parts');
  assertXmlParts(files);
  if (JSON.stringify(workbookSheetNames(workbook)) !== JSON.stringify([...SHEET_NAMES, ...(isV4(projection) ? ['Preflight Coverage', 'Preflight Evidence'] : [])])) throw new Error('XLSX: sheet layout mismatch');
  const sheets = expectedSheets(projection).sheets; for (const [index, sheet] of sheets.entries()) { const content = files.get(`xl/worksheets/sheet${index + 1}.xml`)?.toString('utf8'); if (!content) throw new Error(`XLSX: missing ${sheet.name} sheet`); if (content.includes('&quot;nodes&quot;') && content.includes('&quot;connections&quot;')) throw new Error('XLSX: inline workflow JSON detected'); const actual = readSheetRows(content, sheet.name); if (actual.length !== sheet.rows.length) throw new Error(`XLSX: ${sheet.name} row parity mismatch`); if (JSON.stringify(actual) !== JSON.stringify(safeRows(sheet.rows))) throw new Error(`XLSX: ${sheet.name} field parity mismatch`); }
  if (!workbook.includes('Release Metadata') || !workbook.includes('Data Dictionary')) throw new Error('XLSX: required documentation sheets missing');
  return true;
}
