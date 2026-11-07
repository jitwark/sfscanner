/**
 * Reopen helpers behind the public-format parity checks. Each written artifact gets one reader here,
 * so the fixture parity test and the real-bundle reopen test compare the same facts the same way
 * instead of each inventing its own idea of "the same row". Key lists come from `public-row-contract.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PublicWorkflowRow } from '@hub/contracts/public-data-model';
import { readZip } from './xlsx-zip.js';

/** Key-sorted JSON of any value, so two artifacts can be compared as facts rather than as bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null';
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

/** The physical table or column name a logical name reads back from. */
export const physicalName = (name: string): string => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** One relation's stored rows, read back from the NDJSON shards that carry them. */
export function readNdjsonRows(ndjsonDir: string, relation: string): Record<string, unknown>[] {
  const contents = fs.readFileSync(path.join(ndjsonDir, `${relation}.ndjson`), 'utf8');
  const lines = contents.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const XML_ENTITIES: Record<string, string> = { '&quot;': '"', '&gt;': '>', '&lt;': '<', '&amp;': '&' };
export const decodeXmlEntities = (value: string): string =>
  value.replace(/&(?:quot|gt|lt|amp);/g, (entity) => XML_ENTITIES[entity]!);

/** One worksheet's decoded cells by sheet name, addressed through the workbook's own sheet list. */
export function readSheetRows(zipBytes: Buffer, name: string): string[][] {
  const archive = readZip(zipBytes);
  const workbook = archive.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const names = [...workbook.matchAll(/<sheet\s+name="([^"]+)"[^>]*\/>/g)].map((match) => decodeXmlEntities(match[1]!));
  const index = names.indexOf(name);
  if (index < 0) throw new Error(`xlsx reopen: sheet ${name} is missing`);
  const content = archive.get(`xl/worksheets/sheet${index + 1}.xml`)?.toString('utf8');
  if (!content) throw new Error(`xlsx reopen: sheet${index + 1}.xml is missing`);
  return [...content.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => [...row[1]!.matchAll(/<c\s+[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)]
    .map((cell) => decodeXmlEntities(cell[1]?.match(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/)?.[1] ?? cell[1]?.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '')));
}

/**
 * The workflows table's columns in the database's own order, each with the logical value it stores.
 * Pinned here rather than derived from the writer, so a rename on either side fails the comparison.
 */
export const WORKFLOW_COLUMNS: readonly (readonly [string, (row: PublicWorkflowRow) => unknown])[] = [
  ['workflow_id', (row) => row.workflowId], ['title', (row) => row.title], ['description', (row) => row.description],
  ['description_authority', (row) => row.descriptionAuthority], ['source_id', (row) => row.sourceId], ['rights_status', (row) => row.rightsStatus],
  ['body_kind', (row) => row.body?.kind ?? null], ['body_path', (row) => row.body?.kind === 'path' ? row.body.path : null], ['body_sha256', (row) => row.body?.sha256 ?? null],
  ['grade_status', (row) => row.grade.status], ['grade', (row) => row.grade.status === 'known' ? row.grade.value : null],
  ['score_status', (row) => row.score.status], ['score', (row) => row.score.status === 'known' ? row.score.value : null],
  ['completeness', (row) => row.completeness], ['complexity', (row) => row.complexity], ['node_count', (row) => row.nodeCount],
  ['connection_count', (row) => row.connectionCount], ['readiness_status', (row) => row.readinessStatus],
  ['scan_scanner_version', (row) => row.scanEvidence.scannerVersion], ['scan_analysis_status', (row) => row.scanEvidence.analysisStatus],
  ['scan_freshness', (row) => row.scanEvidence.scanFreshness], ['scan_body_sha256', (row) => row.scanEvidence.scanBodySha256],
];
