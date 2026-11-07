/** Excel's hard worksheet row limit in the xlsx format. */
export const EXCEL_MAX_WORKSHEET_ROWS = 1_048_576;

export function assertWorksheetRowLimit(
  sheetName: string,
  rowCount: number,
  rowLimit = EXCEL_MAX_WORKSHEET_ROWS,
): void {
  // `NaN` and `Infinity` make `rowCount > rowLimit` false for every sheet, so an
  // unvalidated injected limit would silently turn the cap off.
  if (!Number.isSafeInteger(rowLimit) || rowLimit <= 0) {
    throw new Error('XLSX: worksheet row limit must be a positive safe integer');
  }
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error(`XLSX: ${sheetName} row count is invalid`);
  }
  if (rowCount > rowLimit) {
    throw new Error(`XLSX: ${sheetName} has ${rowCount} rows; Excel allows at most ${rowLimit}`);
  }
}

export function assertFinalSheetRowLimits(
  sheets: readonly { name: string; rows: readonly unknown[] }[],
  rowLimit = EXCEL_MAX_WORKSHEET_ROWS,
): void {
  for (const sheet of sheets) assertWorksheetRowLimit(sheet.name, sheet.rows.length, rowLimit);
}
