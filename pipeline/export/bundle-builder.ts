import { relationNames, relationRows, type ExportProjection } from './export-version.js';
import path from 'node:path';
import { writeNdjsonRelease, type NdjsonReleaseManifest } from './ndjson.js';
import { writeSqliteRelease, type SqliteReleaseInfo } from './sqlite.js';
import { writeExcelRelease, expectedExcelSheetRowCounts, type ExcelReleaseInfo, type ExcelTruncation } from './excel.js';
import { writeAtomicFile } from './atomic-file.js';
import {
  DOCUMENTATION_PATHS,
  writeDataDictionaryDocument,
  writeExamplesDocument,
  writeReleaseNotesDocument,
  writeSchemaDocument,
} from './bundle-documentation.js';

export type PublicReleaseBundle = {
  schemaVersion: ExportProjection['schemaVersion'];
  releaseId: string;
  sourceManifestSha256: string;
  sourceCorpusSha256: string;
  relations: Record<string, number>;
  formats: {
    ndjson: { path: string; manifestPath: string; files: number };
    sqlite: { path: string; byteSize: number; sha256: string; logicalSha256: string };
    excel: { path: string; byteSize: number; sha256: string; logicalSha256: string; sheetRowCounts: Record<string, number>; truncation: ExcelTruncation };
  };
  documentation: { schemaPath: string; dictionaryPath: string; releaseNotesPath: string; examplePath: string };
};

/**
 * The bundle's writers, one per boundary. `buildReleaseBundle` always writes
 * into a caller-provided target directory (a staging directory in
 * production; tests may point straight at a temp directory). Overriding a
 * writer is test-only: it is how the atomicity tests inject a failure after
 * a specific boundary without reaching into filesystem internals.
 */
export type PublicReleaseWriters = {
  ndjson: (projection: ExportProjection, outputDir: string) => NdjsonReleaseManifest;
  sqlite: (projection: ExportProjection, outputPath: string) => SqliteReleaseInfo;
  excel: (projection: ExportProjection, outputPath: string) => ExcelReleaseInfo;
  schema: (projection: ExportProjection, outputDir: string) => void;
  dictionary: (projection: ExportProjection, outputDir: string) => void;
  releaseNotes: (projection: ExportProjection, outputDir: string) => void;
  examples: (projection: ExportProjection, outputDir: string) => void;
  manifest: (bundle: PublicReleaseBundle, outputDir: string) => void;
};

export const defaultPublicReleaseWriters: PublicReleaseWriters = {
  ndjson: writeNdjsonRelease,
  sqlite: writeSqliteRelease,
  excel: writeExcelRelease,
  schema: writeSchemaDocument,
  dictionary: writeDataDictionaryDocument,
  releaseNotes: writeReleaseNotesDocument,
  examples: writeExamplesDocument,
  manifest: (bundle, outputDir) => writeAtomicFile(path.join(outputDir, 'public-release.json'), `${JSON.stringify(bundle)}\n`),
};

function relationCounts(projection: ExportProjection): Record<string, number> {
  return Object.fromEntries(relationNames(projection).map((relation) => [relation, relationRows(projection, relation).length]));
}

function assertNdjsonParity(projection: ExportProjection, files: readonly { relation: string; rowCount: number }[]): void {
  for (const relation of relationNames(projection)) {
    const file = files.find((candidate) => candidate.relation === relation);
    if (!file || file.rowCount !== relationRows(projection, relation).length) throw new Error(`Public release: NDJSON ${relation} parity mismatch`);
  }
}

function assertExcelParity(projection: ExportProjection, sheets: Record<string, number>): void {
  for (const [sheet, rows] of Object.entries(expectedExcelSheetRowCounts(projection))) {
    if (sheets[sheet] !== rows) throw new Error(`Public release: Excel ${sheet} parity mismatch`);
  }
}

/** Write every release artifact — NDJSON, SQLite, Excel, docs, manifest — into `targetDir`. */
export function buildReleaseBundle(projection: ExportProjection, targetDir: string, writers: PublicReleaseWriters = defaultPublicReleaseWriters): PublicReleaseBundle {
  const SHA256_HEX = /^[0-9a-f]{64}$/;
  if (!SHA256_HEX.test(projection.release.manifestSha256)) {
    throw new TypeError(`Public release: source manifest digest is missing or invalid: ${projection.release.manifestSha256}`);
  }
  if (!SHA256_HEX.test(projection.release.corpusSha256)) {
    throw new TypeError(`Public release: source corpus digest is missing or invalid: ${projection.release.corpusSha256}`);
  }
  const ndjson = writers.ndjson(projection, path.join(targetDir, 'ndjson'));
  assertNdjsonParity(projection, ndjson.files);
  const sqlite = writers.sqlite(projection, path.join(targetDir, 'release.sqlite'));
  const excel = writers.excel(projection, path.join(targetDir, 'release.xlsx'));
  assertExcelParity(projection, excel.sheetRowCounts);
  writers.schema(projection, targetDir);
  writers.dictionary(projection, targetDir);
  writers.releaseNotes(projection, targetDir);
  writers.examples(projection, targetDir);
  const bundle: PublicReleaseBundle = {
    schemaVersion: projection.schemaVersion,
    releaseId: projection.release.releaseId,
    sourceManifestSha256: projection.release.manifestSha256,
    sourceCorpusSha256: projection.release.corpusSha256,
    relations: relationCounts(projection),
    formats: {
      ndjson: { path: 'ndjson', manifestPath: 'ndjson/public-release.json', files: ndjson.files.length },
      sqlite: { path: 'release.sqlite', byteSize: sqlite.byteSize, sha256: sqlite.sha256, logicalSha256: sqlite.logicalSha256 },
      excel: { path: 'release.xlsx', byteSize: excel.byteSize, sha256: excel.sha256, logicalSha256: excel.logicalSha256, sheetRowCounts: excel.sheetRowCounts, truncation: excel.truncation },
    },
    documentation: DOCUMENTATION_PATHS,
  };
  writers.manifest(bundle, targetDir);
  return bundle;
}
