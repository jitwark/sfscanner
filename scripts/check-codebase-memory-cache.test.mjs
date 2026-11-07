import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectCacheReport,
  evaluateCacheReport,
  formatCacheReport,
} from './check-codebase-memory-cache.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('codebase-memory cache guard', () => {
  it('reports WAL files and fails when the hard WAL threshold is exceeded', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cbm-cache-'));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, 'project.db-wal'), Buffer.alloc(12));

    const report = collectCacheReport({
      cacheDir: directory,
      freeBytes: 10_000,
      processCount: 1,
    });
    const result = evaluateCacheReport(report, {
      warnWalBytes: 8,
      failWalBytes: 10,
      maxProcessCount: 2,
      minFreeBytes: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('WAL exceeds hard threshold');
    expect(formatCacheReport(report)).toContain('project.db-wal: 12 bytes');
  });

  it('passes a healthy cache without writing or mutating it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cbm-cache-'));
    temporaryDirectories.push(directory);

    const report = collectCacheReport({
      cacheDir: directory,
      freeBytes: 10_000,
      processCount: 1,
    });
    const result = evaluateCacheReport(report, {
      warnWalBytes: 8,
      failWalBytes: 10,
      maxProcessCount: 2,
      minFreeBytes: 100,
    });

    expect(result.ok).toBe(true);
    expect(report.walFiles).toEqual([]);
  });

  it('fails closed when a critical observation is unavailable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cbm-cache-'));
    temporaryDirectories.push(directory);

    const report = collectCacheReport({
      cacheDir: directory,
      freeBytes: null,
      processCount: null,
    });
    const result = evaluateCacheReport(report);

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'MCP process count unavailable',
      'cache volume free space unavailable',
    ]));
  });
});
