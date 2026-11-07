import { describe, expect, it } from 'vitest';
import { diffV2ResultRecords } from './v2-result-diff.js';
import type { V2RescanRecord } from './v2-corpus-adapter.js';

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

const withDetails = (base: V2RescanRecord, details: Record<string, unknown>): V2RescanRecord => ({ ...base, ...details } as V2RescanRecord);

describe('diffV2ResultRecords', () => {
  it('classifies added and removed records without leaking workflow content', () => {
    const added = diffV2ResultRecords(undefined, withDetails(record('new'), { findingIds: ['z-rule', 'a-rule'] }));
    expect(added).toMatchObject({ entryId: 'new', status: 'ADDED', findingAdded: ['a-rule', 'z-rule'], findingRemoved: [], authorityChanged: [] });

    const removed = diffV2ResultRecords(withDetails(record('old'), { findingIds: ['old-rule'] }), undefined);
    expect(removed).toMatchObject({ entryId: 'old', status: 'REMOVED', findingAdded: [], findingRemoved: ['old-rule'] });
    expect(JSON.stringify(added)).not.toContain('nodes');
  });

  it('sorts finding changes and records grade, status, and authority changes', () => {
    const prior = withDetails(record('same'), { findingIds: ['same', 'gone'], grade: 'LOW' });
    const current = withDetails(record('same', {
      resultDigest: digest('1'),
      scannerVersion: '2.1.0',
      analysisStatus: 'DEGRADED',
    }), { findingIds: ['same', 'new'], grade: 'HIGH' });
    expect(diffV2ResultRecords(prior, current)).toEqual({
      entryId: 'same',
      status: 'CHANGED',
      findingAdded: ['new'],
      findingRemoved: ['gone'],
      gradeChanged: ['LOW', 'HIGH'],
      analysisStatusChanged: ['COMPLETE', 'DEGRADED'],
      authorityChanged: ['scannerVersion'],
    });
  });

  it('returns a stable unchanged result when records match', () => {
    const one = record('same');
    expect(diffV2ResultRecords(one, { ...one })).toEqual({
      entryId: 'same', status: 'UNCHANGED', findingAdded: [], findingRemoved: [], authorityChanged: [],
    });
  });
});
