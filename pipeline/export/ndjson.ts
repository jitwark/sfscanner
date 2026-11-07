import { relationNames, relationRows, type ExportProjection } from './export-version.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  PUBLIC_RELATION_NAMES,
  type PublicRelationNameV4,
} from '@hub/contracts/public-data-model';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { writeAtomicFile, writeAtomicFileWithWriter } from './atomic-file.js';
import { assertPublicProjection } from './public-export-validation.js';
import { PUBLIC_ROW_KEYS_V4 } from './public-row-contract.js';

const ROW_KEYS: Record<PublicRelationNameV4, readonly string[]> = PUBLIC_ROW_KEYS_V4;

export type NdjsonFileManifest = {
  relation: PublicRelationNameV4;
  path: string;
  sha256: string;
  byteSize: number;
  rowCount: number;
};

export type NdjsonReleaseManifest = {
  schemaVersion: ExportProjection['schemaVersion'];
  releaseId: string;
  files: NdjsonFileManifest[];
};

function digest(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(object).sort(compareCanonicalStrings).map((key) => [key, canonicalValue(object[key])]));
}

function canonicalRow(relation: PublicRelationNameV4, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`NDJSON: ${relation} row is not an object`);
  const source = value as Record<string, unknown>;
  const row: Record<string, unknown> = {};
  for (const key of ROW_KEYS[relation]) if (key in source) row[key] = canonicalValue(source[key]);
  return row;
}

/**
 * The exact bytes one row occupies in its shard, newline included. The writer
 * streams these and the dataset identity digests these, so an id derived from
 * a projection is derived from the bytes the bundle will actually ship rather
 * than from a second serialization that could drift from them.
 */
export function canonicalRowBytes(relation: PublicRelationNameV4, value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalRow(relation, value))}\n`, 'utf8');
}

/**
 * The relations whose rows name the release they belong to. Those cannot take
 * part in the dataset's own content digest — an id cannot be a function of
 * itself — and everything else in them (`artifacts` row hashes and byte sizes,
 * each `releases` field) is the sealed identity or a hash of bytes the other
 * sections already cover. Derived from `ROW_KEYS` so a row shape change cannot
 * silently leave a self-referential relation inside the digest.
 */
export const RELEASE_ID_RELATIONS: readonly PublicRelationNameV4[] = Object.freeze(
  PUBLIC_RELATION_NAMES.filter((relation) => ROW_KEYS[relation].includes('releaseId')),
);

function rowsFor(projection: ExportProjection, relation: PublicRelationNameV4): readonly unknown[] {
  return relationRows(projection, relation);
}

function writeRelationFile(relation: PublicRelationNameV4, rows: readonly unknown[], filePath: string): NdjsonFileManifest {
  let byteSize = 0;
  let rowCount = 0;
  let sha256 = '';
  writeAtomicFileWithWriter(filePath, (temporaryPath) => {
    const descriptor = fs.openSync(temporaryPath, 'w');
    const hasher = crypto.createHash('sha256');
    try {
      for (const value of rows) {
        const bytes = canonicalRowBytes(relation, value);
        let offset = 0;
        while (offset < bytes.byteLength) offset += fs.writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
        hasher.update(bytes);
        byteSize += bytes.byteLength;
        rowCount += 1;
      }
      sha256 = hasher.digest('hex');
    } finally {
      fs.closeSync(descriptor);
    }
  });
  return { relation, path: `${relation}.ndjson`, sha256, byteSize, rowCount };
}

export function writeNdjsonRelease(projection: ExportProjection, outputDir: string): NdjsonReleaseManifest {
  assertPublicProjection(projection);
  fs.mkdirSync(outputDir, { recursive: true });
  const files: NdjsonFileManifest[] = [];
  for (const relation of relationNames(projection)) {
    files.push(writeRelationFile(relation, rowsFor(projection, relation), path.join(outputDir, `${relation}.ndjson`)));
  }
  const manifest: NdjsonReleaseManifest = { schemaVersion: projection.schemaVersion, releaseId: projection.release.releaseId, files };
  writeAtomicFile(path.join(outputDir, 'public-release.json'), `${JSON.stringify(manifest)}\n`);
  verifyNdjsonRelease(projection, outputDir, manifest);
  return manifest;
}

function parseRelation(relation: PublicRelationNameV4, contents: string): unknown[] {
  if (contents.length === 0) return [];
  if (!contents.endsWith('\n')) throw new Error(`NDJSON: ${relation} is missing its final newline`);
  const lines = contents.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.some((line) => line.length === 0)) throw new Error(`NDJSON: ${relation} contains a blank line`);
  return lines.map((line) => JSON.parse(line) as unknown);
}

export function verifyNdjsonRelease(projection: ExportProjection, outputDir: string, manifest: NdjsonReleaseManifest): true {
  assertPublicProjection(projection);
  if (manifest.schemaVersion !== projection.schemaVersion || manifest.releaseId !== projection.release.releaseId || manifest.files.length !== relationNames(projection).length) throw new Error('NDJSON: release metadata mismatch');
  const stored = JSON.parse(fs.readFileSync(path.join(outputDir, 'public-release.json'), 'utf8')) as unknown;
  if (JSON.stringify(stored) !== JSON.stringify(manifest)) throw new Error('NDJSON: release manifest mismatch');
  for (const [index, relation] of relationNames(projection).entries()) {
    const file = manifest.files[index];
    if (!file || file.relation !== relation || file.path !== `${relation}.ndjson`) throw new Error(`NDJSON: manifest order mismatch for ${relation}`);
    const bytes = fs.readFileSync(path.join(outputDir, file.path));
    if (bytes.byteLength !== file.byteSize || digest(bytes) !== file.sha256) throw new Error(`NDJSON: ${relation} checksum mismatch`);
    const actual = parseRelation(relation, bytes.toString('utf8'));
    const expected = rowsFor(projection, relation);
    if (actual.length !== file.rowCount || actual.length !== expected.length) throw new Error(`NDJSON: ${relation} read-back parity mismatch`);
    for (const [index, value] of expected.entries()) {
      if (JSON.stringify(actual[index]) !== JSON.stringify(canonicalRow(relation, value))) throw new Error(`NDJSON: ${relation} read-back parity mismatch`);
    }
  }
  return true;
}
