import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION, type PublicReleaseMetadata } from '@hub/contracts/public-data-model';
import { buildReleaseBundle, defaultPublicReleaseWriters } from './bundle-builder.js';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { writeNdjsonRelease } from './ndjson.js';
import { buildPublicProjection } from './public-projection.js';
import { writePublicRelease } from './public-release.js';
import { PUBLIC_FIELD_DEFINITIONS } from './public-data-dictionary.js';
import { writeSqliteRelease } from './sqlite.js';
import { readZip } from './xlsx-zip.js';
import type { ExportProjection } from './export-version.js';

const dirs: string[] = [];
const release: PublicReleaseMetadata = {
  releaseId: 'release-bundle-test', schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
  generatedAt: '2026-08-30T00:00:00.000Z', toolVersion: 'hub-pipeline@1.0.0', scannerVersion: 'scanner-v1',
  policyVersion: 'policy-v1', searchIndexVersion: 'search-v1', buildRevision: 'revision',
  manifestSha256: 'a'.repeat(64), corpusSha256: 'b'.repeat(64),
  counts: { workflows: 1, redistributable: 1, linkOnly: 0, excluded: 0, findings: 0 },
  facetCounts: { rights: { redistributable: 1, linkOnly: 0, excluded: 0 } },
};

afterEach(() => {
  for (const directory of dirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(`${directory}.previous`, { recursive: true, force: true });
  }
});

type WorkflowParityRow = {
  workflowId: string;
  rightsStatus: string;
  bodyKind: string | null;
  bodyPath: string | null;
  bodySha256: string | null;
};

function parityRow(row: { workflowId: string; rightsStatus: string; body: { kind: string; path?: string; sha256: string } | null }): WorkflowParityRow {
  return {
    workflowId: row.workflowId,
    rightsStatus: row.rightsStatus,
    bodyKind: row.body?.kind ?? null,
    bodyPath: row.body?.kind === 'path' ? row.body.path ?? null : null,
    bodySha256: row.body?.sha256 ?? null,
  };
}

function decodeXml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

function excelCell(xml: string, reference: string): string | null {
  if (new RegExp(`<c r="${reference}"[^>]*/>`).test(xml)) return null;
  const cell = xml.match(new RegExp(`<c r="${reference}"[^>]*>([\\s\\S]*?)</c>`))?.[1];
  if (!cell) return null;
  const value = cell.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
  return value === undefined ? null : decodeXml(value);
}

function readExcelWorkflowRows(outputPath: string, count: number): WorkflowParityRow[] {
  const xml = readZip(fs.readFileSync(outputPath)).get('xl/worksheets/sheet2.xml')?.toString('utf8');
  if (!xml) throw new Error('test fixture: missing Workflows sheet');
  return Array.from({ length: count }, (_, index) => {
    const row = index + 2;
    return {
      workflowId: excelCell(xml, `A${row}`) ?? '',
      rightsStatus: excelCell(xml, `F${row}`) ?? '',
      bodyKind: excelCell(xml, `G${row}`),
      bodyPath: excelCell(xml, `H${row}`),
      bodySha256: excelCell(xml, `I${row}`),
    };
  });
}

describe('writePublicRelease', () => {
  it('writes all formats from one projection and publishes shared relation parity', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-release-')); dirs.push(directory);
    const projection = buildPublicProjection([makeEntry({ id: 'one', download: { pack: 0, line: 1, offset: 0, length: 10 } })], { release, bodySha256ByWorkflowId: { one: 'c'.repeat(64) } });
    const bundle = writePublicRelease(projection, directory);
    expect(bundle.schemaVersion).toBe(PUBLIC_DATA_MODEL_SCHEMA_VERSION);
    expect(bundle.relations.workflows).toBe(1);
    expect(bundle.relations.releases).toBe(1);
    expect(bundle.formats.ndjson.files).toBe(16);
    expect(bundle.formats.sqlite.path).toBe('release.sqlite');
    expect(bundle.formats.excel.path).toBe('release.xlsx');
    expect(bundle.formats.excel.truncation).toMatchObject({ limit: 32_767, count: 0, fields: [] });
    expect(fs.existsSync(path.join(directory, 'ndjson', 'public-release.json'))).toBe(true);
    expect(fs.existsSync(path.join(directory, 'release.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(directory, 'release.xlsx'))).toBe(true);
    const dictionary = JSON.parse(fs.readFileSync(path.join(directory, 'data-dictionary.json'), 'utf8')) as { fields: unknown[] };
    expect(dictionary.fields).toHaveLength(PUBLIC_FIELD_DEFINITIONS.length);
    const schema = JSON.parse(fs.readFileSync(path.join(directory, 'schema.json'), 'utf8')) as { relations: Record<string, string[]> };
    expect(schema.relations.findings).toContain('findingId');
    expect(schema.relations.artifacts).toContain('artifactId');
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'public-release.json'), 'utf8'))).toEqual(bundle);
  });

  it('keeps canonical rights, exclusion, redaction, and body availability aligned across formats', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-release-parity-')); dirs.push(directory);
    const parityRelease: PublicReleaseMetadata = {
      ...release,
      releaseId: 'release-cross-format-parity',
      counts: { workflows: 2, redistributable: 1, linkOnly: 1, excluded: 0, findings: 1 },
      facetCounts: { rights: { redistributable: 1, linkOnly: 1, excluded: 0 } },
    };
    const projection = buildPublicProjection([
      makeEntry({
        id: 'redistributable',
        description: 'Public description; scanner prose contains [REDACTED] only.',
        download: { pack: 3, line: 7, offset: 12, length: 90 },
        security: { findings: [{ id: 'policy.secret', title: 'Credential exposure', severity: 'HIGH', why: 'Credential value [REDACTED]', fix: 'Replace the redacted credential' }] },
      }),
      makeEntry({ id: 'link-only', rights: { status: 'link_only', licence: null, licenceUrl: null }, source: { kind: 'n8n_official' } }),
      makeEntry({ id: 'excluded-by-registry', download: { pack: 8, line: 1, offset: 0, length: 10 } }),
    ], {
      release: parityRelease,
      excludedIds: ['excluded-by-registry'],
      bodySha256ByWorkflowId: { redistributable: 'd'.repeat(64) },
    });
    const bundle = writePublicRelease(projection, directory);
    const expected = projection.workflows.map(parityRow);
    const ndjsonRows = fs.readFileSync(path.join(directory, 'ndjson', 'workflows.ndjson'), 'utf8').trim().split('\n').map((line) => parityRow(JSON.parse(line) as Parameters<typeof parityRow>[0]));
    expect(ndjsonRows).toEqual(expected);
    expect(ndjsonRows.some((row) => row.workflowId === 'excluded-by-registry')).toBe(false);
    expect(ndjsonRows.find((row) => row.workflowId === 'link-only')?.bodyKind).toBeNull();

    const database = new DatabaseSync(path.join(directory, bundle.formats.sqlite.path), { readOnly: true });
    let sqliteRows: WorkflowParityRow[];
    try {
      sqliteRows = database.prepare('SELECT workflow_id, rights_status, body_kind, body_path, body_sha256 FROM workflows ORDER BY workflow_id').all().map((row) => {
        const value = row as { workflow_id: string; rights_status: string; body_kind: string | null; body_path: string | null; body_sha256: string | null };
        return { workflowId: value.workflow_id, rightsStatus: value.rights_status, bodyKind: value.body_kind, bodyPath: value.body_path, bodySha256: value.body_sha256 };
      });
      expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
    expect(sqliteRows!).toEqual(expected);

    const excelRows = readExcelWorkflowRows(path.join(directory, bundle.formats.excel.path), expected.length);
    expect(excelRows).toEqual(expected);
    const excelXml = readZip(fs.readFileSync(path.join(directory, bundle.formats.excel.path))).get('xl/worksheets/sheet2.xml')!.toString('utf8');
    expect(excelXml).not.toContain('excluded-by-registry');
    expect(excelXml).not.toContain('"nodes"');
    expect(excelXml).toContain('[REDACTED]');
  });

  it('fails closed before machine writers accept invalid rights or exclusion rows', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-release-invalid-')); dirs.push(directory);
    const expected = buildPublicProjection([makeEntry({ id: 'one', download: { pack: 0, line: 1, offset: 0, length: 10 } })], { release, bodySha256ByWorkflowId: { one: 'c'.repeat(64) } });
    const invalidRights = { ...expected, workflows: expected.workflows.map((row) => ({ ...row, rightsStatus: 'link_only' as const })) };

    expect(() => writeNdjsonRelease(invalidRights, path.join(directory, 'ndjson'))).toThrow(/non-redistributable.*body/i);
    expect(() => writeSqliteRelease(invalidRights, path.join(directory, 'release.sqlite'))).toThrow(/non-redistributable.*body/i);
    expect(fs.existsSync(path.join(directory, 'release.sqlite'))).toBe(false);

    const invalidExclusion = { ...expected, exclusions: [{ exclusionId: 'exclusion-one', workflowId: 'one', status: 'excluded' as const, reasonCode: 'rights-review', publicReference: null }] };
    expect(() => writeNdjsonRelease(invalidExclusion, path.join(directory, 'excluded-ndjson'))).toThrow(/exclusion.*leaks/i);
  });

  it('rejects drift in any of the ten worksheet row counts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bundle-')); dirs.push(directory);
    const projection = buildPublicProjection([makeEntry({ id: 'bundle-parity' })], { release });
    const writers = {
      ...defaultPublicReleaseWriters,
      excel: (value: ExportProjection, output: string) => {
        const info = defaultPublicReleaseWriters.excel(value, output);
        return { ...info, sheetRowCounts: { ...info.sheetRowCounts, README: info.sheetRowCounts.README! + 1 } };
      },
    };
    expect(() => buildReleaseBundle(projection, directory, writers)).toThrow(/README parity mismatch/);
  });

  it('rejects release metadata with an invalid integrity hash at both writers', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-release-hash-')); dirs.push(directory);
    const expected = buildPublicProjection([makeEntry({ id: 'one' })], { release, bodySha256ByWorkflowId: {} });
    const invalid = { ...expected, release: { ...expected.release, manifestSha256: 'not-a-sha256' }, releases: [{ ...expected.release, manifestSha256: 'not-a-sha256' }] };

    expect(() => writeNdjsonRelease(invalid, path.join(directory, 'ndjson'))).toThrow(/hash/i);
    expect(() => writeSqliteRelease(invalid, path.join(directory, 'release.sqlite'))).toThrow(/hash/i);
  });

  it('binds source manifest and corpus digests into the public release bundle manifest', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bundle-source-digest-')); dirs.push(directory);
    const projection = buildPublicProjection([makeEntry({ id: 'bound-source-entry' })], { release });
    const bundle = buildReleaseBundle(projection, directory);
    expect(bundle.sourceManifestSha256).toBe(release.manifestSha256);
    expect(bundle.sourceCorpusSha256).toBe(release.corpusSha256);

    const storedManifest = JSON.parse(fs.readFileSync(path.join(directory, 'public-release.json'), 'utf8'));
    expect(storedManifest.sourceManifestSha256).toBe(release.manifestSha256);
    expect(storedManifest.sourceCorpusSha256).toBe(release.corpusSha256);
  });

  it('rejects buildReleaseBundle with TypeError before calling writers when source digests are absent or invalid', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bundle-bad-digest-')); dirs.push(directory);
    const projection = buildPublicProjection([makeEntry({ id: 'bound-source-entry' })], { release });
    let writerCalled = false;
    const writers = {
      ...defaultPublicReleaseWriters,
      ndjson: () => { writerCalled = true; throw new Error('writer should not be called'); },
    };

    // Invalid hash
    const invalidManifest = { ...projection, release: { ...projection.release, manifestSha256: 'bad-digest' } };
    expect(() => buildReleaseBundle(invalidManifest, directory, writers)).toThrow(TypeError);
    expect(() => buildReleaseBundle(invalidManifest, directory, writers)).toThrow(/source manifest digest is missing or invalid/);
    expect(writerCalled).toBe(false);

    // Absent hash (undefined)
    const absentManifest = { ...projection, release: { ...projection.release, manifestSha256: undefined as unknown as string } };
    expect(() => buildReleaseBundle(absentManifest, directory, writers)).toThrow(TypeError);
    expect(writerCalled).toBe(false);

    // Absent corpus digest
    const absentCorpus = { ...projection, release: { ...projection.release, corpusSha256: '' } };
    expect(() => buildReleaseBundle(absentCorpus, directory, writers)).toThrow(TypeError);
    expect(() => buildReleaseBundle(absentCorpus, directory, writers)).toThrow(/source corpus digest is missing or invalid/);
    expect(writerCalled).toBe(false);
  });
});
