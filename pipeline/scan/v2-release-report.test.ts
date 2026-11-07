import { describe, expect, it } from 'vitest';
import { createV2ReleaseReport, serializeV2ReleaseReport, writeV2ReleaseReport } from './v2-release-report.js';
import type { V2RescanRecord } from './v2-corpus-adapter.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const digest = (letter: string) => letter.repeat(64);
const record = (entryId: string, overrides: Partial<V2RescanRecord> = {}): V2RescanRecord => ({
  entryId,
  sourceDigest: digest('a'),
  inputSha256: digest('b'),
  scannerVersion: '2.0.0',
  engineBuildDigest: digest('c'),
  profileId: 'beta-default',
  profileVersion: '2.0.0',
  rulesetDigest: digest('d'),
  semanticsDigest: digest('e'),
  limitsDigest: digest('f'),
  analysisStatus: 'COMPLETE',
  findingIds: [],
  rightsClass: 'redistributable',
  ok: true,
  ...overrides,
});

const detail = (base: V2RescanRecord, values: Record<string, unknown>): V2RescanRecord => ({ ...base, ...values } as V2RescanRecord);

describe('v2 release report', () => {
  it('classifies every old/new difference with stable counts', () => {
    const previous = [detail(record('same'), { findingIds: ['gone'], grade: 'LOW' }), record('removed')];
    const current = [detail(record('same', { resultDigest: digest('1'), analysisStatus: 'DEGRADED' }), { findingIds: ['new'], grade: 'HIGH' }), record('added')];
    const report = createV2ReleaseReport('release-2', current, previous);
    expect(report.schemaVersion).toBe('v2-release-report');
    expect(report.diffs.map((diff) => [diff.entryId, diff.status])).toEqual([['added', 'ADDED'], ['removed', 'REMOVED'], ['same', 'CHANGED']]);
    expect(report.counts).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 0, findingChanges: 1, gradeChanges: 1, analysisStatusChanges: 1, authorityChanges: 0, rightsChanges: 0 });
    expect(JSON.stringify(report)).not.toContain('nodes');
  });

  it('serializes repeats identically and writes under the supplied release directory', async () => {
    const report = createV2ReleaseReport('release', [record('one')]);
    expect(serializeV2ReleaseReport(report)).toBe(serializeV2ReleaseReport(report));
    const directory = await mkdtemp(join(tmpdir(), 'v2-release-'));
    const path = await writeV2ReleaseReport(directory, report);
    expect(path).toContain('v2-release-report.json');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(report);
  });
});
