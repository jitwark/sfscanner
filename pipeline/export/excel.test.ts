import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION, type PublicReleaseMetadata } from '@hub/contracts/public-data-model';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { SCAN_PROVENANCE_CASES, releaseForEntries } from '../__fixtures__/scan-provenance-cases.js';
import { buildPublicProjection } from './public-projection.js';
import { createZip, readZip } from './xlsx-zip.js';
import { EXCEL_MAX_WORKSHEET_ROWS, assertFinalSheetRowLimits, expectedSheetRowsForTest, verifyExcelRelease, verifyExcelXmlParts, writeExcelRelease } from './excel.js';
import { PUBLIC_FIELD_DEFINITIONS } from './public-data-dictionary.js';

const dirs: string[] = [];
const release: PublicReleaseMetadata = {
  releaseId: 'release-xlsx-test', schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
  generatedAt: '2026-08-30T00:00:00.000Z', toolVersion: 'hub-pipeline@1.0.0', scannerVersion: 'scanner-v1',
  policyVersion: 'policy-v1', searchIndexVersion: 'search-v1', buildRevision: 'revision',
  manifestSha256: 'a'.repeat(64), corpusSha256: 'b'.repeat(64),
  counts: { workflows: 1, redistributable: 1, linkOnly: 0, excluded: 0, findings: 0 },
  facetCounts: { rights: { redistributable: 1, linkOnly: 0, excluded: 0 } },
};

function outputPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-xlsx-')); dirs.push(directory); return path.join(directory, 'release.xlsx');
}

const XML_ENTITIES: Record<string, string> = { '&quot;': '"', '&gt;': '>', '&lt;': '<', '&amp;': '&' };

/** Text or numeric value of one `<row>'s` cells, XML entities decoded, in document order. */
function rowTextCells(rowXml: string): string[] {
  return [...rowXml.matchAll(/<c\s+[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)].map((cell) => {
    const raw = cell[1]?.match(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/)?.[1] ?? cell[1]?.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
    return raw.replace(/&(?:quot|gt|lt|amp);/g, (entity) => XML_ENTITIES[entity]!);
  });
}

/** Raw `<row>` bodies of one worksheet, addressed by its 1-based workbook index. */
function worksheetRows(outputPath: string, index: number): string[] {
  const content = readZip(fs.readFileSync(outputPath)).get(`xl/worksheets/sheet${index}.xml`);
  if (!content) throw new Error(`test fixture: missing sheet${index}`);
  return [...content.toString('utf8').matchAll(/<row\s+r="\d+"[^>]*>([\s\S]*?)<\/row>/g)].map((match) => match[1]!);
}

/** Column A/B pairs of the Release Metadata sheet (sheet 9 of ten). */
function metadataFields(outputPath: string): Record<string, string> {
  return Object.fromEntries(worksheetRows(outputPath, 9).map((row) => {
    const cells = rowTextCells(row);
    return [cells[0] ?? '', cells[1] ?? ''];
  }));
}

afterEach(() => { for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('Excel public release writer', () => {
  it('writes required sheets, formula-safe cells, bounded text, and read-back parity', () => {
    const projection = buildPublicProjection([makeEntry({ id: 'formula', title: '=SUM(A1:A10)', description: 'safe\u0001 description', download: { pack: 0, line: 1, offset: 0, length: 10 } })], { release, bodySha256ByWorkflowId: { formula: 'c'.repeat(64) } });
    const output = outputPath();
    const info = writeExcelRelease(projection, output);
    expect(info.sheetRowCounts.Workflows).toBe(2);
    expect(info.sheetRowCounts['Data Dictionary']).toBe(PUBLIC_FIELD_DEFINITIONS.length + 1);
    expect(info.truncation).toMatchObject({ limit: 32_767, count: 0, fields: [], cells: [] });
    expect(metadataFields(output).excelTruncatedCells).toBe('0');
    expect(metadataFields(output).excelTruncatedFields).toBe('[]');
    expect(verifyExcelRelease(projection, output)).toBe(true);
    const files = readZip(fs.readFileSync(output));
    const workbook = files.get('xl/workbook.xml')!.toString('utf8');
    const workflows = files.get('xl/worksheets/sheet2.xml')!.toString('utf8');
    expect(workbook).toContain('README');
    expect(workbook).toContain('Data Dictionary');
    expect(workflows).toContain("'=SUM(A1:A10)");
    expect(workflows).not.toContain('\u0001');
    expect(workflows).not.toContain('"nodes"');
    expect(workflows).toContain('packs/pack-0.jsonl');
  });

  it('records a clipped cell with its field instead of clipping it silently', () => {
    const atLimit = 'y'.repeat(32_767);
    // Formula-shaped as well as over-limit: the guard character has to be inside
    // the limit, or the workbook would contain a 32,768-character cell.
    const overLimitTitle = `=${'x'.repeat(32_768)}`;
    const metadata = {
      ...release,
      counts: { ...release.counts, workflows: 2, redistributable: 0, linkOnly: 2 },
      facetCounts: { rights: { redistributable: 0, linkOnly: 2, excluded: 0 } },
    };
    const projection = buildPublicProjection([
      makeEntry({ id: 'at-limit', title: atLimit, rights: { status: 'link_only', licence: null, licenceUrl: null } }),
      makeEntry({ id: 'over-limit', title: overLimitTitle, rights: { status: 'link_only', licence: null, licenceUrl: null } }),
    ], { release: metadata });
    const output = outputPath();
    const info = writeExcelRelease(projection, output);

    expect(info.truncation).toMatchObject({ limit: 32_767, count: 1, fields: ['Workflows.title'] });
    expect(info.truncation.cells).toEqual([
      { sheet: 'Workflows', field: 'Workflows.title', row: 3, originalLength: 32_769, keptLength: 32_767 },
    ]);
    expect(metadataFields(output).excelTruncatedCells).toBe('1');
    expect(metadataFields(output).excelTruncatedFields).toBe('["Workflows.title"]');
    expect(verifyExcelRelease(projection, output)).toBe(true);

    const titles = worksheetRows(output, 2).map((row) => rowTextCells(row)[1] ?? '');
    // The value exactly at the limit is untouched — only the over-limit cell is clipped.
    expect(titles[1]).toHaveLength(32_767);
    expect(titles[2]).toHaveLength(32_767);
    expect(titles[2]!.startsWith("'=")).toBe(true);
    expect(titles[2]!.includes('y')).toBe(false);
    for (const row of [...worksheetRows(output, 2), ...worksheetRows(output, 9)]) {
      for (const cell of rowTextCells(row)) expect(cell.length).toBeLessThanOrEqual(32_767);
    }
  });

  it('keeps logical identity stable across writers and independent of the Excel cell limit', () => {
    const first = outputPath(); const second = outputPath(); const third = outputPath();
    const body = { bodySha256ByWorkflowId: { long: 'c'.repeat(64) } };
    const one = writeExcelRelease(buildPublicProjection([makeEntry({ id: 'long', title: 'x'.repeat(40_000) })], { release, ...body }), first);
    const two = writeExcelRelease(buildPublicProjection([makeEntry({ id: 'long', title: 'x'.repeat(40_000) })], { release, ...body }), second);
    const clippedPrefix = writeExcelRelease(buildPublicProjection([makeEntry({ id: 'long', title: 'x'.repeat(32_767) })], { release, ...body }), third);

    expect(one.truncation.count).toBe(1);
    expect(two.sha256).toBe(one.sha256);
    expect(one.logicalSha256).toBe(two.logicalSha256);
    // The logical hash covers the untruncated projection: a workbook clipped to
    // the cell limit is not the same release as one that fits inside it.
    expect(clippedPrefix.logicalSha256).not.toBe(one.logicalSha256);
    expect(clippedPrefix.truncation.count).toBe(0);
  });

  it('rejects a tampered cell even when sheet row counts remain unchanged', () => {
    const projection = buildPublicProjection([makeEntry({ id: 'tamper', title: 'original' })], { release, bodySha256ByWorkflowId: { tamper: 'c'.repeat(64) } });
    const output = outputPath();
    writeExcelRelease(projection, output);
    const entries = [...readZip(fs.readFileSync(output)).entries()];
    const index = entries.findIndex(([name]) => name === 'xl/worksheets/sheet2.xml');
    const xml = entries[index][1].toString('utf8').replace('>tamper<', '>changed<');
    entries[index][1] = Buffer.from(xml, 'utf8');
    fs.writeFileSync(output, createZip(entries.map(([name, data]) => ({ name, data }))));

    expect(() => verifyExcelRelease(projection, output)).toThrow(/cell|parity|field/i);
  });

  it('publishes every dictionary field of a workflow row, scan evidence included, with nulls for absent values', () => {
    const current = SCAN_PROVENANCE_CASES.find((scanCase) => scanCase.entry.id === 'current')!;
    const refused = SCAN_PROVENANCE_CASES.find((scanCase) => scanCase.entry.id === 'refused-current')!;
    const unscanned = SCAN_PROVENANCE_CASES.find((scanCase) => scanCase.entry.id === 'never-scanned')!;
    const entries = [current.entry, refused.entry, unscanned.entry];
    const projection = buildPublicProjection(entries, {
      release: releaseForEntries(entries),
      admittedIdentity: current.admittedIdentity,
      bodySha256ByWorkflowId: current.bodySha256ByWorkflowId,
      scanReceiptsByWorkflowId: { ...current.scanReceiptsByWorkflowId, ...refused.scanReceiptsByWorkflowId },
    });
    const output = outputPath();
    writeExcelRelease(projection, output);

    const rows = worksheetRows(output, 2).map(rowTextCells);
    const header = rows[0]!;
    // The sheet header is the workflows dictionary, field for field and in order. `body` is the
    // one logical field already published as three leaf columns; the rest publish under the
    // dictionary name with its dot removed, so a renamed, missing or reordered field fails here.
    expect(header).toEqual(PUBLIC_FIELD_DEFINITIONS
      .filter((definition) => definition.relation === 'workflows')
      .flatMap(({ field }) => field === 'body'
        ? ['bodyKind', 'bodyPath', 'bodySha256']
        : [field.replace(/\.(\w)/gu, (_match, letter: string) => letter.toUpperCase())]));

    const byId = new Map(rows.slice(1).map((row) => [row[0]!, row]));
    const cellOf = (id: string, name: string) => byId.get(id)![header.indexOf(name)];
    expect(cellOf('current', 'scanEvidenceScannerVersion')).toBe('2.0.0');
    expect(cellOf('current', 'scanEvidenceAnalysisStatus')).toBe('COMPLETE');
    expect(cellOf('current', 'scanEvidenceScanFreshness')).toBe('CURRENT');
    expect(cellOf('current', 'scanEvidenceScanBodySha256')).toBe('e'.repeat(64));
    expect(cellOf('current', 'grade')).toBe('MEDIUM');
    expect(cellOf('never-scanned', 'scanEvidenceScannerVersion')).toBe('');
    expect(cellOf('never-scanned', 'scanEvidenceAnalysisStatus')).toBe('');
    expect(cellOf('never-scanned', 'scanEvidenceScanFreshness')).toBe('UNSCANNED');
    expect(cellOf('never-scanned', 'scanEvidenceScanBodySha256')).toBe('');
    expect(cellOf('never-scanned', 'grade')).toBe('');
    expect(rows.flat().join('\u0000')).not.toContain('UNKNOWN');
    expect(verifyExcelRelease(projection, output)).toBe(true);
  });

  it('does not overflow the call stack on a sheet with more rows than a spread call can take as arguments', () => {
    // Regression: `sheetXml` used `Math.max(...sheet.rows.map(...))`, and V8
    // rejects a spread call with too many arguments (measured on this
    // engine: fine at 125,000, RangeError at 130,000) with a RangeError, not
    // a graceful fallback. The real corpus's Requirements sheet has 130,972
    // rows; every fixture here has at most a handful, so this was invisible
    // until run at production scale. One entry with 135,000 findings
    // reproduces it without constructing that many separate workflows.
    const manyFindings = Array.from({ length: 135_000 }, (_, index) => ({
      id: `POLICY_${index}`, title: 'Synthetic finding', severity: 'LOW' as const, why: 'why', fix: 'fix',
    }));
    const entry = makeEntry({ id: 'many-findings', rights: { status: 'link_only', licence: null, licenceUrl: null }, security: { findings: manyFindings } });
    const metadata = {
      ...release,
      counts: { ...release.counts, workflows: 1, redistributable: 0, linkOnly: 1, findings: manyFindings.length },
      facetCounts: { rights: { redistributable: 0, linkOnly: 1, excluded: 0 } },
    };
    const projection = buildPublicProjection([entry], { release: metadata });
    const output = outputPath();
    expect(() => writeExcelRelease(projection, output)).not.toThrow();
  }, 20_000);

  it('removes XML 1.0-invalid characters and verification rejects a reintroduced one', () => {
    const entries = [makeEntry({ id: 'xml-char', title: 'bad\uFFFEvalue\uFFFF' })];
    const projection = buildPublicProjection(entries, { release: releaseForEntries(entries) });
    const output = outputPath();
    writeExcelRelease(projection, output);

    const files = readZip(fs.readFileSync(output));
    const sheet = files.get('xl/worksheets/sheet2.xml')!.toString('utf8');
    expect(sheet).toContain('>badvalue<');
    expect(sheet).not.toMatch(/[\uFFFE\uFFFF]/);
    // U+FFFD is valid XML 1.0 and deliberately kept.
    expect(verifyExcelRelease(projection, output)).toBe(true);
    expect(verifyExcelXmlParts(output)).toBe(15);

    // Reintroduce the invalid code point in the written part: verification must
    // reject it even though the row counts and field text still match.
    const entriesList = [...files.entries()];
    const index = entriesList.findIndex(([name]) => name === 'xl/worksheets/sheet2.xml');
    entriesList[index]![1] = Buffer.from(sheet.replace('>badvalue<', '>bad\uFFFFvalue<'), 'utf8');
    fs.writeFileSync(output, createZip(entriesList.map(([name, data]) => ({ name, data }))));
    expect(() => verifyExcelRelease(projection, output)).toThrow(/XML 1.0-invalid/);

    // The sweep is not worksheet-only: a package part outside `xl/worksheets` is checked too.
    const stylesIndex = entriesList.findIndex(([name]) => name === 'xl/styles.xml');
    entriesList[stylesIndex]![1] = Buffer.from(files.get('xl/styles.xml')!.toString('utf8').replace('<fonts', '<fon\uFFFFts'), 'utf8');
    fs.writeFileSync(output, createZip(entriesList.map(([name, data]) => ({ name, data }))));
    expect(() => verifyExcelRelease(projection, output)).toThrow(/styles\.xml has XML 1.0-invalid/);
  });

  it('keeps U+FFFD in a written cell while removing the XML 1.0-invalid U+FFFE and U+FFFF', () => {
    // U+FFFD is what Node emits for an unpaired surrogate and what an upstream
    // conversion leaves behind; it is valid XML 1.0 and meaningful text, so the
    // writer must not fold it into the same control-character rule as U+FFFE/FFFF.
    const entries = [makeEntry({ id: 'replacement-char', title: 'kept\uFFFDgone \uFFFEremoved\uFFFF' })];
    const projection = buildPublicProjection(entries, { release: releaseForEntries(entries) });
    const output = outputPath();
    writeExcelRelease(projection, output);

    const cells = rowTextCells(worksheetRows(output, 2)[1]!);
    expect(cells[1]).toBe('kept\uFFFDgone removed');
    const sheet = readZip(fs.readFileSync(output)).get('xl/worksheets/sheet2.xml')!.toString('utf8');
    expect(sheet).toContain('kept\uFFFDgone removed');
    expect(sheet).not.toMatch(/[\uFFFE\uFFFF]/u);
    expect(verifyExcelRelease(projection, output)).toBe(true);
  });

  it('applies the row cap to the final sheet, including appended metadata rows', () => {
    // Direct boundary checks use sparse arrays and the production default.
    expect(() => assertFinalSheetRowLimits([{ name: 'Requirements', rows: new Array(EXCEL_MAX_WORKSHEET_ROWS) }])).not.toThrow();
    expect(() => assertFinalSheetRowLimits([{ name: 'Requirements', rows: new Array(EXCEL_MAX_WORKSHEET_ROWS + 1) }])).toThrow(/Requirements.*1048576/);

    const entries = [makeEntry({ id: 'row-cap' })];
    const projection = buildPublicProjection(entries, { release: releaseForEntries(entries) });
    // Guard-order fixture: extra release keys render as real metadata rows and make
    // Release Metadata the longest sheet, so a small limit isolates the append
    // boundary. This projection is used ONLY by expectedSheetRowsForTest.
    const paddedRelease = {
      ...releaseForEntries(entries),
      ...Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`fixtureMetadata${index}`, 'x'])),
    } as unknown as PublicReleaseMetadata;
    const paddedProjection = buildPublicProjection(entries, { release: paddedRelease });

    const composed = expectedSheetRowsForTest(paddedProjection);
    const composedMetadata = composed.find((sheet) => sheet.name === 'Release Metadata');
    if (!composedMetadata) throw new Error('Release Metadata sheet missing');
    const base = composedMetadata.rows.length - 3;
    expect(base).toBeGreaterThan(0);
    expect(() => expectedSheetRowsForTest(paddedProjection, base + 2)).toThrow(/Release Metadata/u);
    const atLimit = expectedSheetRowsForTest(paddedProjection, base + 3);
    expect(atLimit.find((sheet) => sheet.name === 'Release Metadata')?.rows).toHaveLength(base + 3);

    const output = outputPath();
    const info = writeExcelRelease(projection, output);
    const metadataRows = worksheetRows(output, 9);
    expect(metadataRows.map((row) => rowTextCells(row)[0])).toEqual(expect.arrayContaining([
      'excelTruncationLimit', 'excelTruncatedCells', 'excelTruncatedFields',
    ]));
    expect(info.sheetRowCounts['Release Metadata']).toBe(metadataRows.length);
  });

  it('rejects an invalid injected row limit instead of silently disabling the cap', () => {
    // NaN and Infinity make `rowCount > rowLimit` false for every sheet, so an
    // unvalidated limit would turn the cap off rather than tighten it.
    const sheets = [{ name: 'Requirements', rows: [] }];
    for (const rowLimit of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      expect(() => assertFinalSheetRowLimits(sheets, rowLimit)).toThrow(/row limit/u);
    }
    expect(() => assertFinalSheetRowLimits(sheets, 1)).not.toThrow();
  });
});
