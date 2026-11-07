/**
 * The bundle privacy gate reads exactly what a promoted bundle ships. These
 * tests pin the claims behind it: relation order cannot drift from the data
 * model, V3 and V4 select closed relation sets, and every string leaf of every
 * shard is swept before the gate reports personal or credential-shaped text.
 */
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
import {
  PUBLIC_RELATION_NAMES as GATE_RELATIONS,
  PUBLIC_RELATION_NAMES_V4 as GATE_RELATIONS_V4,
  baselineTotals,
  regressions,
  sweepBundle,
  summaryFieldPaths,
} from './public-bundle-privacy.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type TestSchema = typeof PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3 | typeof PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4;
type ManifestFile = { relation: string; path: string; sha256: string; byteSize: number; rowCount: number };
type Rows = Record<string, unknown[]>;
type BundleOptions = { rootSchema?: string; ndjsonSchema?: string; releaseSchema?: string; relations?: readonly string[] };

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const relationNames = (schema: TestSchema) => schema === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4
  ? PUBLIC_RELATION_NAMES_V4 : PUBLIC_RELATION_NAMES;

function newDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-privacy-'));
  dirs.push(dir);
  return dir;
}

function writeBundle(
  schema: TestSchema | string = PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3,
  rows: Rows = {},
  options: BundleOptions = {},
): string {
  const dir = newDir();
  fs.mkdirSync(path.join(dir, 'ndjson'));
  const supported = schema === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3 || schema === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4;
  const relations = options.relations ?? (supported ? relationNames(schema as TestSchema) : []);
  const releaseRow = { schemaVersion: options.releaseSchema ?? schema, releaseId: 'release-test' };
  const allRows: Rows = { releases: [releaseRow], ...rows };
  const files = relations.map((relation): ManifestFile => {
    const bytes = (allRows[relation] ?? []).map((row) => `${JSON.stringify(row)}\n`).join('');
    fs.writeFileSync(path.join(dir, 'ndjson', `${relation}.ndjson`), bytes);
    return {
      relation, path: `${relation}.ndjson`, sha256: sha256(Buffer.from(bytes)), byteSize: Buffer.byteLength(bytes),
      rowCount: allRows[relation]?.length ?? 0,
    };
  });
  fs.writeFileSync(path.join(dir, 'ndjson', 'public-release.json'), JSON.stringify({
    schemaVersion: options.ndjsonSchema ?? schema, releaseId: 'release-test', files,
  }));
  fs.writeFileSync(path.join(dir, 'public-release.json'), JSON.stringify({
    schemaVersion: options.rootSchema ?? schema, releaseId: 'release-test',
    relations: Object.fromEntries(files.map((file) => [file.relation, file.rowCount])),
    formats: { ndjson: { path: 'ndjson', manifestPath: 'ndjson/public-release.json', files: files.length } },
  }));
  return dir;
}

function bundleWith(rows: Rows, schema: TestSchema = PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3): string {
  return writeBundle(schema, rows);
}

function readNdjsonManifest(dir: string): { schemaVersion: string; files: ManifestFile[] } {
  return JSON.parse(fs.readFileSync(path.join(dir, 'ndjson', 'public-release.json'), 'utf8'));
}

function writeNdjsonManifest(dir: string, manifest: unknown): void {
  fs.writeFileSync(path.join(dir, 'ndjson', 'public-release.json'), JSON.stringify(manifest));
}

function rewriteShard(dir: string, relation: string, contents: string, rowCount: number): void {
  const bytes = Buffer.from(contents);
  fs.writeFileSync(path.join(dir, 'ndjson', `${relation}.ndjson`), bytes);
  const manifest = readNdjsonManifest(dir);
  const file = manifest.files.find((candidate) => candidate.relation === relation)!;
  Object.assign(file, { sha256: sha256(bytes), byteSize: bytes.byteLength, rowCount });
  writeNdjsonManifest(dir, manifest);
}

it('keeps both JS relation literals equal to the data model', () => {
  expect(GATE_RELATIONS).toEqual(PUBLIC_RELATION_NAMES);
  expect(GATE_RELATIONS_V4).toEqual(PUBLIC_RELATION_NAMES_V4);
  expect(GATE_RELATIONS_V4).toEqual([...GATE_RELATIONS, 'preflightCoverage', 'preflightEvidence']);
});

it('retains V3 and sweeps every string leaf, reporting paths without values', () => {
  const v3 = bundleWith({ findings: [{ title: 'x', remediation: 'contact someone@internal.local' }] });
  const v3Result = sweepBundle(v3);
  expect(v3Result.totals['email-address']).toBe(1);
  expect(summaryFieldPaths(v3Result)['email-address']).toEqual([['remediation', 1]]);

  const v4 = bundleWith({
    preflightCoverage: [{ omissionCounts: [{ code: 'x', note: 'owner@internal.local' }] }],
    preflightEvidence: [{ omissionCodes: ['x'], nested: { pointer: '10.0.0.7' } }],
  }, PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
  const result = sweepBundle(v4);
  expect(result.totals['email-address']).toBe(1);
  expect(result.totals['private-ip']).toBe(1);
  expect(summaryFieldPaths(result)['email-address']).toEqual([['omissionCounts[0].note', 1]]);
  expect(summaryFieldPaths(result)['private-ip']).toEqual([['nested.pointer', 1]]);
  expect(JSON.stringify(result)).not.toContain('owner@internal.local');
  expect(JSON.stringify(summaryFieldPaths(result))).not.toContain('10.0.0.7');
});

it('rejects unknown, mixed, duplicate, missing, misplaced, misnamed, and traversal entries', () => {
  const unknownSchema = writeBundle(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
  const root = JSON.parse(fs.readFileSync(path.join(unknownSchema, 'public-release.json'), 'utf8'));
  fs.writeFileSync(path.join(unknownSchema, 'public-release.json'), JSON.stringify({ ...root, schemaVersion: 'public-data-model-v5' }));
  expect(() => sweepBundle(unknownSchema)).toThrow(/unsupported schema version/i);

  const mixed = writeBundle(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4, {}, { ndjsonSchema: PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3 });
  expect(() => sweepBundle(mixed)).toThrow(/schema version.*mix|mix.*schema version/i);

  const duplicate = writeBundle(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
  const duplicateManifest = readNdjsonManifest(duplicate);
  duplicateManifest.files[17] = { ...duplicateManifest.files[0]! };
  writeNdjsonManifest(duplicate, duplicateManifest);
  expect(() => sweepBundle(duplicate)).toThrow(/duplicate relation releases/);

  const missing = writeBundle(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
  const missingManifest = readNdjsonManifest(missing);
  missingManifest.files.pop();
  writeNdjsonManifest(missing, missingManifest);
  expect(() => sweepBundle(missing)).toThrow(/exactly 18 relations/);

  const unknown = writeBundle(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
  const unknownManifest = readNdjsonManifest(unknown);
  unknownManifest.files[0] = { ...unknownManifest.files[0]!, relation: 'unknownRelation', path: 'unknownRelation.ndjson' };
  writeNdjsonManifest(unknown, unknownManifest);
  expect(() => sweepBundle(unknown)).toThrow(/unknown relation unknownRelation/);

  const misplaced = writeBundle(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
  const misplacedManifest = readNdjsonManifest(misplaced);
  misplacedManifest.files[0] = { ...misplacedManifest.files[0]!, path: 'other/releases.ndjson' };
  writeNdjsonManifest(misplaced, misplacedManifest);
  expect(() => sweepBundle(misplaced)).toThrow(/outside ndjson/);

  const wrongName = writeBundle(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
  const wrongNameManifest = readNdjsonManifest(wrongName);
  wrongNameManifest.files[0] = { ...wrongNameManifest.files[0]!, path: 'wrong.ndjson' };
  writeNdjsonManifest(wrongName, wrongNameManifest);
  expect(() => sweepBundle(wrongName)).toThrow(/must be releases\.ndjson inside ndjson\//);

  const traversal = writeBundle(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
  const traversalManifest = readNdjsonManifest(traversal);
  traversalManifest.files[0] = { ...traversalManifest.files[0]!, path: '../releases.ndjson' };
  writeNdjsonManifest(traversal, traversalManifest);
  expect(() => sweepBundle(traversal)).toThrow(/outside ndjson/);
});

it('rejects unparseable manifests, bad schemas, and mismatched release metadata', () => {
  const unparseable = writeBundle(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
  fs.writeFileSync(path.join(unparseable, 'ndjson', 'public-release.json'), '{nope');
  expect(() => sweepBundle(unparseable)).toThrow(/malformed manifest/);

  const releaseMismatch = writeBundle(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
  const releaseManifest = readNdjsonManifest(releaseMismatch);
  writeNdjsonManifest(releaseMismatch, { ...releaseManifest, releaseId: 'release-other' });
  expect(() => sweepBundle(releaseMismatch)).toThrow(/release id|releaseId/i);

  const releaseSchema = writeBundle(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4, {}, {
    releaseSchema: PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3,
  });
  expect(() => sweepBundle(releaseSchema)).toThrow(/release.*schema|schema.*release/i);
});

it('rejects mismatched shard bytes, sizes, counts, newlines, blank lines, and malformed rows', () => {
  const hashMismatch = writeBundle(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
  fs.appendFileSync(path.join(hashMismatch, 'ndjson', 'releases.ndjson'), ' ');
  expect(() => sweepBundle(hashMismatch)).toThrow(/byte size|checksum|sha-256/i);

  const sizeMismatch = writeBundle(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
  const sizeManifest = readNdjsonManifest(sizeMismatch);
  sizeManifest.files[0] = { ...sizeManifest.files[0]!, byteSize: sizeManifest.files[0]!.byteSize + 1 };
  writeNdjsonManifest(sizeMismatch, sizeManifest);
  expect(() => sweepBundle(sizeMismatch)).toThrow(/byte size/i);

  const countMismatch = writeBundle(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
  const countManifest = readNdjsonManifest(countMismatch);
  countManifest.files[0] = { ...countManifest.files[0]!, rowCount: 2 };
  writeNdjsonManifest(countMismatch, countManifest);
  expect(() => sweepBundle(countMismatch)).toThrow(/row count/i);

  const noNewline = bundleWith({ releases: [{ schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3, releaseId: 'r' }] });
  rewriteShard(noNewline, 'releases', JSON.stringify({ releaseId: 'r' }), 1);
  expect(() => sweepBundle(noNewline)).toThrow(/final newline/);

  const blank = bundleWith({});
  rewriteShard(blank, 'releases', '\n', 1);
  expect(() => sweepBundle(blank)).toThrow(/blank line/);

  const malformed = bundleWith({});
  rewriteShard(malformed, 'releases', '{nope\n', 1);
  expect(() => sweepBundle(malformed)).toThrow(/malformed JSON row/);
});

describe('baseline boundary', () => {
  it('rejects a malformed baseline and fails a matcher only once it is above its total', () => {
    const result = sweepBundle(bundleWith({ findings: [{ remediation: 'mail jane@acme.co.uk' }] }));
    const totals = result.totals;

    expect(() => baselineTotals(null)).toThrow(/totals/);
    expect(() => baselineTotals({ totals: [] })).toThrow(/totals/);
    expect(() => baselineTotals({ totals: {} })).toThrow(/email-address/);
    expect(() => baselineTotals({ totals: { ...totals, 'email-address': '1' } })).toThrow(/email-address/);
    expect(() => baselineTotals({ totals: { ...totals, 'private-ip': -1 } })).toThrow(/private-ip/);
    expect(baselineTotals({ totals })).toEqual(totals);

    expect(regressions(result, baselineTotals({ totals }))).toEqual([]);
    expect(regressions(result, baselineTotals({ totals: { ...totals, 'email-address': 0 } })))
      .toEqual(['email-address: 1 occurrences, baseline 0']);
  });
});
