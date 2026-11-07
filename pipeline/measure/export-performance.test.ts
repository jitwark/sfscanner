import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION, type PublicReleaseMetadata } from '@hub/contracts/public-data-model';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { runExportPerformanceCli } from './export-performance-cli.js';
import { measurePublicExport } from './export-performance.js';

const directories: string[] = [];
const release: PublicReleaseMetadata = {
  releaseId: 'release-measurement-test', schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
  generatedAt: '2026-08-30T00:00:00.000Z', toolVersion: 'hub-pipeline@1.0.0', scannerVersion: 'scanner-v1',
  policyVersion: 'policy-v1', searchIndexVersion: 'search-v1', buildRevision: 'revision',
  manifestSha256: 'a'.repeat(64), corpusSha256: 'b'.repeat(64),
  counts: { workflows: 2, redistributable: 1, linkOnly: 1, excluded: 0, findings: 0 },
  facetCounts: { rights: { redistributable: 1, linkOnly: 1, excluded: 0 } },
};

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('export performance measurement', () => {
  // SQLite/XLSX writer startup can exceed Vitest's 5s default when the full
  // multi-project suite is exercising the same machine. This is still a
  // bounded fixture, so keep a generous test timeout rather than hiding a
  // legitimate hang behind an unbounded setting.
  it('measures the canonical projection and writers with shared row parity', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-export-measure-'));
    directories.push(outputDir);
    const entries = [
      makeEntry({ id: 'link', rights: { status: 'link_only' } }),
      makeEntry({ id: 'redis', download: { pack: 0, line: 1, offset: 0, length: 10 } }),
    ];

    const report = measurePublicExport(entries, {
      outputDir,
      release,
      bodySha256ByWorkflowId: { redis: 'c'.repeat(64) },
    });

    expect(report.measurementVersion).toBe('export-measurement-v1');
    expect(report.inputEntryCount).toBe(2);
    expect(report.projection.relationRows.workflows).toBe(2);
    expect(report.writers.relationRows).toEqual(report.projection.relationRows);
    expect(report.writers.artifactBytes.ndjson).toBeGreaterThan(0);
    expect(report.writers.artifactBytes.sqlite).toBeGreaterThan(0);
    expect(report.writers.artifactBytes.excel).toBeGreaterThan(0);
    expect(report.total.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(report.peakRssBytes).toBeGreaterThan(0);
    expect(report.peakRssBytes).toBeGreaterThanOrEqual(report.total.rssAfterBytes);
    expect(report.rssSource).toMatch(/resourceUsage|max/);
    expect(fs.existsSync(path.join(outputDir, 'ndjson', 'workflows.ndjson'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'release.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'release.xlsx'))).toBe(true);
  }, 30_000);

  it('runs through the repeatable CLI input boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-export-cli-'));
    directories.push(root);
    const entries = [
      makeEntry({ id: 'link', rights: { status: 'link_only' } }),
      makeEntry({ id: 'redis', download: { pack: 0, line: 1, offset: 0, length: 10 } }),
    ];
    const entriesPath = path.join(root, 'entries.json');
    const releasePath = path.join(root, 'release.json');
    const bodyShaPath = path.join(root, 'body-sha256.json');
    fs.writeFileSync(entriesPath, JSON.stringify(entries));
    fs.writeFileSync(releasePath, JSON.stringify(release));
    fs.writeFileSync(bodyShaPath, JSON.stringify({ redis: 'c'.repeat(64) }));

    const report = JSON.parse(runExportPerformanceCli([
      '--entries', entriesPath, '--release', releasePath, '--body-sha256', bodyShaPath,
      '--output', path.join(root, 'release'),
    ])) as { inputEntryCount: number; releaseId: string; writers: { relationRows: Record<string, number> } };

    expect(report.inputEntryCount).toBe(2);
    expect(report.releaseId).toBe(release.releaseId);
    expect(report.writers.relationRows.workflows).toBe(2);
  });
});
