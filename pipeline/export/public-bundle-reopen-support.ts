import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PublicRelationNameV4, PublicWorkflowRow } from '@hub/contracts/public-data-model';
import type { ExcelTruncation } from './excel.js';
import type { ExportProjection } from './export-version.js';
import type { NdjsonReleaseManifest } from './ndjson.js';
import { excelCellText } from './public-bundle-v4-validation.js';

/** An explicitly configured root is a hard requirement: a missing bundle must fail, never skip. */
const configuredRoot = process.env.PUBLIC_BUNDLE_ROOT ? path.resolve(process.env.PUBLIC_BUNDLE_ROOT) : undefined;
export const BUNDLE_DIR = configuredRoot ?? path.resolve(import.meta.dirname, '..', '.work', 'october17-release', 'public-dataset');
const BUILD_COMMAND = 'node --import tsx scripts/export-public-dataset.ts --data data --out pipeline/.work/october17-release/public-dataset';
export const NDJSON_DIR = path.join(BUNDLE_DIR, 'ndjson');
export const SQLITE_PATH = path.join(BUNDLE_DIR, 'release.sqlite');
export const EXCEL_PATH = path.join(BUNDLE_DIR, 'release.xlsx');
export const BUILT = fs.existsSync(path.join(BUNDLE_DIR, 'public-release.json'));
if (configuredRoot && !BUILT) throw new Error(`Configured PUBLIC_BUNDLE_ROOT "${configuredRoot}" is absent or missing public-release.json`);
if (!BUILT) console.warn(`bundle reopen: skipping — ${BUNDLE_DIR} is absent. Build it with \`${BUILD_COMMAND}\`.`);

export type BundleManifest = {
  schemaVersion: ExportProjection['schemaVersion']; releaseId: string; sourceManifestSha256: string; sourceCorpusSha256: string;
  relations: Record<string, number>;
  formats: {
    ndjson: { files: number };
    sqlite: { path: string; byteSize: number; sha256: string };
    excel: {
      path: string; byteSize: number; sha256: string; sheetRowCounts: Record<string, number>;
      truncation: ExcelTruncation;
    };
  };
};
export type NdjsonManifest = NdjsonReleaseManifest;

export const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const readManifest = (): BundleManifest => readJson<BundleManifest>(path.join(BUNDLE_DIR, 'public-release.json'));

export const WORKFLOW_HEADERS = ['workflowId', 'title', 'description', 'descriptionAuthority', 'sourceId', 'rightsStatus', 'bodyKind', 'bodyPath', 'bodySha256', 'grade', 'score', 'completeness', 'complexity', 'nodeCount', 'connectionCount', 'readinessStatus', 'scanEvidenceScannerVersion', 'scanEvidenceAnalysisStatus', 'scanEvidenceScanFreshness', 'scanEvidenceScanBodySha256'];
type RelationSheet = readonly [sheet: string, relation: PublicRelationNameV4];
export const RELATION_SHEETS: readonly RelationSheet[] = [
  ['Findings', 'findings'], ['Integrations', 'integrations'], ['Tags', 'tags'], ['Triggers', 'triggers'],
  ['Provenance', 'sources'], ['Requirements', 'requirements'],
];
export const PREFLIGHT_SHEETS: readonly RelationSheet[] = [
  ['Preflight Coverage', 'preflightCoverage'], ['Preflight Evidence', 'preflightEvidence'],
];
export const FORMULA_START = /^[=+\-@]/;

export const COMPARED: readonly (readonly [string, (row: Record<string, unknown>) => unknown])[] = [
  ['workflowId', (row) => row.workflowId], ['title', (row) => row.title], ['description', (row) => row.description],
  ['sourceId', (row) => row.sourceId], ['rightsStatus', (row) => row.rightsStatus], ['nodeCount', (row) => row.nodeCount],
  ['grade', (row) => nullableValue(row.grade)], ['score', (row) => nullableValue(row.score)],
  ['scanEvidenceScanFreshness', (row) => evidenceField(row, 'scanFreshness')],
  ['scanEvidenceAnalysisStatus', (row) => evidenceField(row, 'analysisStatus')],
];

function nullableValue(cell: unknown): unknown {
  const shaped = cell as { status?: unknown; value?: unknown } | null;
  return shaped?.status === 'known' ? shaped.value : null;
}

function evidenceField(row: Record<string, unknown>, key: 'scanFreshness' | 'analysisStatus'): unknown {
  const evidence = row.scanEvidence;
  if (typeof evidence !== 'object' || evidence === null) return null;
  const shaped = evidence as Record<string, unknown>;
  return key in shaped ? shaped[key] : null;
}

export const workbookCellText = (value: unknown): string => excelCellText(value).text;

function bodyNeedles(): { source: string; needles: string[] } {
  const charts = path.resolve(import.meta.dirname, '..', '..', 'data', 'charts');
  const source = path.join(charts, fs.readdirSync(charts).sort().at(-1)!);
  const lines = fs.readFileSync(source, 'utf8').split('\n').filter((line) => line.length > 0).slice(0, 3);
  const nodes = lines.flatMap((line) => ((JSON.parse(line) as { nodes?: { id?: string }[] }).nodes ?? []).slice(0, 2));
  return { source, needles: [...new Set(nodes.flatMap((node) => (node.id ? [node.id] : [])))] };
}

export function containsBodyNeedle(file: string, needle: string): boolean {
  const descriptor = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    let carry = Buffer.alloc(0);
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) return false;
      const window = Buffer.concat([carry, chunk.subarray(0, read)]);
      if (window.includes(needle)) return true;
      carry = window.subarray(Math.max(0, window.length - needle.length + 1));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export { bodyNeedles };
export type WorkflowRow = PublicWorkflowRow;
