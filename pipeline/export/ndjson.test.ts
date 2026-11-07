import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION, type PublicReleaseMetadata } from '@hub/contracts/public-data-model';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { SCAN_PROVENANCE_CASES, releaseForEntries } from '../__fixtures__/scan-provenance-cases.js';
import { buildPublicProjection } from './public-projection.js';
import { verifyNdjsonRelease, writeNdjsonRelease } from './ndjson.js';
import { PUBLIC_ROW_KEYS } from './public-row-contract.js';

const tempDirs: string[] = [];
const release: PublicReleaseMetadata = {
  releaseId: 'release-ndjson-test', schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
  generatedAt: '2026-08-30T00:00:00.000Z', toolVersion: 'hub-pipeline@1.0.0', scannerVersion: 'scanner-v1',
  policyVersion: 'policy-v1', searchIndexVersion: 'search-v1', buildRevision: 'revision',
  manifestSha256: 'a'.repeat(64), corpusSha256: 'b'.repeat(64),
  counts: { workflows: 1, redistributable: 1, linkOnly: 0, excluded: 0, findings: 0 },
  facetCounts: { rights: { redistributable: 1, linkOnly: 0, excluded: 0 } },
};

function directory(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ndjson-'));
  tempDirs.push(value);
  return value;
}

function projection() {
  return buildPublicProjection([makeEntry({
    id: 'unicode', title: '=SUM(A1:A10)\nquoted "title"',
    download: { pack: 0, line: 1, offset: 0, length: 10 },
  })], { release, bodySha256ByWorkflowId: { unicode: 'c'.repeat(64) } });
}

function linkOnlyProjection() {
  const linkOnlyRelease = {
    ...release,
    releaseId: 'release-ndjson-edge-test',
    counts: { workflows: 1, redistributable: 0, linkOnly: 1, excluded: 0, findings: 0 },
    facetCounts: { rights: { redistributable: 0, linkOnly: 1, excluded: 0 } },
  };
  return buildPublicProjection([makeEntry({
    id: 'edge', title: 'line 1\nline 2\r\t\u0000\u0001 — café ☕ "quoted"', description: 'null-safe description',
    source: { kind: 'n8n_official' }, rights: { status: 'link_only' },
  })], { release: linkOnlyRelease });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('NDJSON public release writer', () => {
  it('writes deterministic UTF-8 relation files and verifies read-back parity', () => {
    const outputDir = directory();
    const manifest = writeNdjsonRelease(projection(), outputDir);
    expect(manifest.schemaVersion).toBe(PUBLIC_DATA_MODEL_SCHEMA_VERSION);
    expect(manifest.files.find((file) => file.relation === 'workflows')).toMatchObject({ rowCount: 1, path: 'workflows.ndjson' });
    const bytes = fs.readFileSync(path.join(outputDir, 'workflows.ndjson'));
    expect(bytes.toString('utf8')).toContain('\\n');
    expect(bytes.toString('utf8')).not.toContain('=SUM(A1:A10)\nquoted');
    expect(bytes.toString('utf8').startsWith('{"workflowId"')).toBe(true);
    expect(verifyNdjsonRelease(projection(), outputDir, manifest)).toBe(true);
  });

  it('round-trips control characters, Unicode, and null values without extra lines', () => {
    const outputDir = directory();
    const data = linkOnlyProjection();
    const manifest = writeNdjsonRelease(data, outputDir);
    const workflowFile = fs.readFileSync(path.join(outputDir, 'workflows.ndjson'), 'utf8');
    const sourceFile = fs.readFileSync(path.join(outputDir, 'sources.ndjson'), 'utf8');
    const workflow = JSON.parse(workflowFile.trimEnd()) as Record<string, unknown>;
    const source = JSON.parse(sourceFile.trimEnd()) as Record<string, unknown>;

    expect(workflowFile.trimEnd().split('\n')).toHaveLength(1);
    expect(workflow.title).toBe('line 1\nline 2\r\t\u0000\u0001 — café ☕ "quoted"');
    expect(workflow.body).toBeNull();
    expect(source.repositoryUrl).toBeNull();
    expect(source.licence).toBeNull();
    expect(source.licenceUrl).toBeNull();
    expect(workflowFile).toContain('\\n');
    expect(workflowFile).toContain('\\u0000');
    expect(verifyNdjsonRelease(data, outputDir, manifest)).toBe(true);
  });

  it('round-trips a materially large text field and records its UTF-8 byte size', () => {
    const outputDir = directory();
    const largeDescription = `${'segment-'.repeat(32_768)}終端\n`; // over 250 KiB before JSON framing
    const data = buildPublicProjection([makeEntry({ id: 'large', description: largeDescription, download: { pack: 0, line: 1, offset: 0, length: 10 } })], {
      release: { ...release, releaseId: 'release-ndjson-large-test' }, bodySha256ByWorkflowId: { large: 'c'.repeat(64) },
    });
    const manifest = writeNdjsonRelease(data, outputDir);
    const file = manifest.files.find((value) => value.relation === 'workflows')!;
    const bytes = fs.readFileSync(path.join(outputDir, file.path));
    const row = JSON.parse(bytes.toString('utf8').trimEnd()) as { description: string };

    expect(bytes.byteLength).toBeGreaterThan(250_000);
    expect(row.description).toBe(largeDescription);
    expect(file.byteSize).toBe(bytes.byteLength);
    expect(verifyNdjsonRelease(data, outputDir, manifest)).toBe(true);
  });

  it('rebuilds byte-identically and rejects a tampered relation', () => {
    const first = directory();
    const second = directory();
    const firstManifest = writeNdjsonRelease(projection(), first);
    const secondManifest = writeNdjsonRelease(projection(), second);
    const files = firstManifest.files.map((file) => file.path).concat('public-release.json');
    for (const file of files) {
      const left = fs.readFileSync(path.join(first, file));
      const right = fs.readFileSync(path.join(second, file));
      expect(crypto.createHash('sha256').update(left).digest('hex')).toBe(crypto.createHash('sha256').update(right).digest('hex'));
    }
    fs.appendFileSync(path.join(first, 'workflows.ndjson'), '\n');
    expect(() => verifyNdjsonRelease(projection(), first, firstManifest)).toThrow(/checksum|parity|line/i);
  });

  it('rejects a non-empty relation without its canonical final newline', () => {
    const outputDir = directory();
    const data = projection();
    const manifest = writeNdjsonRelease(data, outputDir);
    const relationPath = path.join(outputDir, 'workflows.ndjson');
    const contents = fs.readFileSync(relationPath);
    const withoutFinalNewline = contents.subarray(0, -1);
    fs.writeFileSync(relationPath, withoutFinalNewline);
    const updatedManifest = {
      ...manifest,
      files: manifest.files.map((file) => file.relation === 'workflows'
        ? { ...file, sha256: crypto.createHash('sha256').update(withoutFinalNewline).digest('hex'), byteSize: withoutFinalNewline.byteLength }
        : file),
    };
    fs.writeFileSync(path.join(outputDir, 'public-release.json'), `${JSON.stringify(updatedManifest)}\n`);

    expect(() => verifyNdjsonRelease(data, outputDir, updatedManifest)).toThrow(/final newline/i);
  });

  it('writes relation rows incrementally instead of materializing a relation buffer', () => {
    const outputDir = directory();
    const writeFile = vi.spyOn(fs, 'writeFileSync');

    writeNdjsonRelease(projection(), outputDir);

    expect(writeFile.mock.calls.some(([file]) => String(file).endsWith('workflows.ndjson'))).toBe(false);
  });

  it('publishes the row scan evidence, in contract order, and never a known grade for an unscanned row', () => {
    const outputDir = directory();
    const selected = ['current', 'refused-current', 'never-scanned'].map((id) =>
      SCAN_PROVENANCE_CASES.find((scanCase) => scanCase.entry.id === id)!);
    const entries = selected.map((scanCase) => scanCase.entry);
    const data = buildPublicProjection(entries, {
      release: releaseForEntries(entries),
      admittedIdentity: selected[0]!.admittedIdentity,
      bodySha256ByWorkflowId: selected[0]!.bodySha256ByWorkflowId,
      scanReceiptsByWorkflowId: Object.assign({}, ...selected.map((scanCase) => scanCase.scanReceiptsByWorkflowId)),
    });
    const manifest = writeNdjsonRelease(data, outputDir);
    const contents = fs.readFileSync(path.join(outputDir, 'workflows.ndjson'), 'utf8');
    const byId = new Map(contents.trimEnd().split('\n').map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      return [String(row.workflowId), row];
    }));

    expect(Object.keys(byId.get('current')!)).toEqual([...PUBLIC_ROW_KEYS.workflows]);
    expect(byId.get('current')!.scanEvidence).toEqual({
      analysisStatus: 'COMPLETE', scanBodySha256: 'e'.repeat(64), scanFreshness: 'CURRENT', scannerVersion: '2.0.0',
    });
    expect(byId.get('never-scanned')!.scanEvidence).toEqual({
      analysisStatus: null, scanBodySha256: null, scanFreshness: 'UNSCANNED', scannerVersion: null,
    });
    expect(byId.get('never-scanned')!.grade).toEqual({ status: 'unknown', value: null });
    expect(contents).not.toContain('UNKNOWN');
    expect(verifyNdjsonRelease(data, outputDir, manifest)).toBe(true);
  });
});
