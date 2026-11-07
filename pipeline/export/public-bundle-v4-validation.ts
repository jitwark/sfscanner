import {
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3,
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4,
  PUBLIC_RELATION_NAMES,
  PUBLIC_RELATION_NAMES_V4,
  type PublicRelationNameV4,
} from '@hub/contracts/public-data-model';
import { expectedSheetRowsForTest, type ExcelCellTruncation, type ExcelTruncation } from './excel.js';
import type { ExportProjection } from './export-version.js';
import { canonicalJson } from './public-evidence-parity.js';
import { PUBLIC_ROW_KEYS_V4 } from './public-row-contract.js';

const FORMULA_START = /^[=+\-@]/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g;
const EXCEL_CELL_LIMIT = 32_767;
const FROZEN_CANDIDATE_WORKFLOWS = 11_464;
const MINIMUM_WORKBOOK_CELLS = 250_000;
const V3_SHEETS = [
  'README', 'Workflows', 'Findings', 'Integrations', 'Tags', 'Triggers', 'Provenance',
  'Requirements', 'Release Metadata', 'Data Dictionary',
] as const;
const V4_SHEETS = [...V3_SHEETS, 'Preflight Coverage', 'Preflight Evidence'] as const;

export type WorkbookSheets = Readonly<Record<string, readonly string[][]>>;
export type DerivedExcelTruncation = ExcelCellTruncation & { keptPrefix: string };
export type ExcelTruncationAudit = {
  cells: readonly DerivedExcelTruncation[];
  cellCount: number;
};
type ExcelRow = readonly (string | number | boolean | null)[];

function isExcelRow(value: unknown): value is ExcelRow {
  return Array.isArray(value) && value.every((cell) =>
    cell === null || typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean');
}

export function assertFrozenCandidateWorkflowCensus(count: unknown): void {
  if (count !== FROZEN_CANDIDATE_WORKFLOWS) {
    throw new Error(`public bundle reopen: workflow census ${String(count)} does not match frozen candidate ${FROZEN_CANDIDATE_WORKFLOWS}`);
  }
}

export function assertWorkbookCellFloor(count: unknown): void {
  if (!Number.isSafeInteger(count) || (count as number) <= MINIMUM_WORKBOOK_CELLS) {
    throw new Error(`public bundle reopen: workbook cell count ${String(count)} must exceed ${MINIMUM_WORKBOOK_CELLS}`);
  }
}

export function excelCellText(value: unknown): { text: string; clipped: boolean; originalLength: number } {
  if (value === null || value === undefined) return { text: '', clipped: false, originalLength: 0 };
  if (typeof value === 'number') { const text = String(value); return { text, clipped: false, originalLength: text.length }; }
  if (typeof value === 'boolean') { const text = value ? '1' : '0'; return { text, clipped: false, originalLength: text.length }; }
  const original = String(value);
  const stripped = original.replace(CONTROL_CHARACTERS, '');
  const guarded = FORMULA_START.test(stripped) ? `'${stripped}` : stripped;
  return guarded.length > EXCEL_CELL_LIMIT
    ? { text: guarded.slice(0, EXCEL_CELL_LIMIT), clipped: true, originalLength: original.length }
    : { text: guarded, clipped: false, originalLength: original.length };
}

function excelColumn(index: number): string {
  let value = '';
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) {
    value = String.fromCharCode(65 + ((number - 1) % 26)) + value;
  }
  return value;
}

function truncationField(sheet: string, header: unknown, rowIndex: number, columnIndex: number): string {
  const label = rowIndex > 0 && typeof header === 'string' && header.length > 0
    ? header : `column ${excelColumn(columnIndex)}`;
  return `${sheet}.${label}`;
}

/** Rebuild the writer's truncation ledger from reopened values and workbook cells. */
export function deriveExcelTruncationRecords(
  projection: ExportProjection,
  workbookSheets: WorkbookSheets,
): ExcelTruncationAudit {
  const sheets = expectedSheetRowsForTest(projection);
  const cells: DerivedExcelTruncation[] = [];
  let cellCount = 0;
  for (const sheet of sheets) {
    const actualRows = workbookSheets[sheet.name];
    const expectedRows = sheet.rows.map((row, rowIndex) => {
      if (!isExcelRow(row)) throw new Error(`public bundle reopen: ${sheet.name} expected row ${rowIndex + 1} is not an Excel row`);
      return row;
    });
    if (!actualRows || actualRows.length !== expectedRows.length) {
      throw new Error(`public bundle reopen: ${sheet.name} workbook row count mismatch`);
    }
    const header = expectedRows[0];
    for (const [rowIndex, expectedRow] of expectedRows.entries()) {
      const actualRow = actualRows[rowIndex]!;
      if (actualRow.length !== expectedRow.length) throw new Error(`public bundle reopen: ${sheet.name} workbook cell count mismatch at row ${rowIndex + 1}`);
      cellCount += actualRow.length;
      for (const [columnIndex, value] of expectedRow.entries()) {
        const computed = excelCellText(value);
        const field = truncationField(sheet.name, header?.[columnIndex], rowIndex, columnIndex);
        if (actualRow[columnIndex] !== computed.text) {
          throw new Error(`public bundle reopen: ${sheet.name} cell mismatch at row ${rowIndex + 1} column ${columnIndex + 1}`);
        }
        if (computed.clipped) cells.push({
          sheet: sheet.name, field, row: rowIndex + 1,
          originalLength: computed.originalLength, keptLength: computed.text.length, keptPrefix: computed.text,
        });
      }
    }
  }
  return { cells, cellCount };
}

export function assertExcelTruncationRecords(
  declared: ExcelTruncation,
  derived: readonly DerivedExcelTruncation[],
): void {
  if (declared.limit !== EXCEL_CELL_LIMIT) {
    throw new Error(`public bundle reopen: Excel truncation limit ${String(declared.limit)} does not match ${EXCEL_CELL_LIMIT}`);
  }
  if (!Array.isArray(declared.cells) || declared.count !== derived.length || declared.cells.length !== derived.length) {
    throw new Error(`public bundle reopen: Excel truncation count ${String(declared.count)} does not match ${derived.length} clipped cells`);
  }
  const declaredFields = [...new Set(declared.cells.map((cell) => cell.field))].sort();
  if (JSON.stringify(declared.fields) !== JSON.stringify(declaredFields)) {
    throw new Error('public bundle reopen: Excel truncation fields do not match clipped cells');
  }
  const shape = ({ sheet, field, row, originalLength, keptLength }: ExcelCellTruncation) =>
    ({ sheet, field, row, originalLength, keptLength });
  if (JSON.stringify(declared.cells.map(shape)) !== JSON.stringify(derived.map(shape))) {
    throw new Error('public bundle reopen: Excel truncation record mismatch');
  }
}

export function resolveBundleRelations(
  rootSchema: unknown,
  ndjsonSchema: unknown,
  releaseSchema: unknown,
): readonly PublicRelationNameV4[] {
  if (rootSchema !== PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3 && rootSchema !== PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4) {
    throw new Error(`public bundle reopen: unsupported schema version ${String(rootSchema)}`);
  }
  if (ndjsonSchema !== rootSchema || releaseSchema !== rootSchema) {
    throw new Error(
      `public bundle reopen: mixed schema versions root=${String(rootSchema)} ndjson=${String(ndjsonSchema)} release=${String(releaseSchema)}`,
    );
  }
  return rootSchema === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4 ? PUBLIC_RELATION_NAMES_V4 : PUBLIC_RELATION_NAMES;
}

export function assertManifestRelations(
  files: readonly { relation?: unknown; path?: unknown }[],
  expected: readonly PublicRelationNameV4[],
): void {
  if (files.length !== expected.length) throw new Error(`public bundle reopen: manifest must declare exactly ${expected.length} relations`);
  const relations = files.map((file) => file.relation);
  const supported = new Set<string>(expected);
  for (const relation of relations) {
    if (typeof relation !== 'string' || !supported.has(relation)) throw new Error(`public bundle reopen: unsupported relation ${String(relation)}`);
  }
  if (new Set(relations).size !== relations.length) {
    const duplicate = relations.find((relation, index) => relations.indexOf(relation) !== index);
    throw new Error(`public bundle reopen: duplicate relation ${String(duplicate)}`);
  }
  for (const [index, relation] of expected.entries()) {
    if (relations[index] !== relation) throw new Error(`public bundle reopen: relation order mismatch at ${relation}`);
    if (files[index]?.path !== `${relation}.ndjson`) throw new Error(`public bundle reopen: canonical path mismatch for ${relation}`);
  }
}

export function contentRelations(
  relations: readonly PublicRelationNameV4[],
): readonly PublicRelationNameV4[] {
  return relations.filter((relation) => !PUBLIC_ROW_KEYS_V4[relation].includes('releaseId'));
}

export function expectedWorkbookSheetNames(schema: unknown): readonly string[] {
  if (schema === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3) return V3_SHEETS;
  if (schema === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4) return V4_SHEETS;
  throw new Error(`public bundle reopen: unsupported schema version ${String(schema)}`);
}

export function preflightCellText(_key: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? canonicalJson(value) : String(value);
  return FORMULA_START.test(text) ? `'${text}` : text;
}
