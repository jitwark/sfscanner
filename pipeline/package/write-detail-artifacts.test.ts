import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { writeDetailArtifacts } from './write-detail-artifacts.js';

const TEST_DIR = path.join(process.cwd(), 'pipeline', '.work', 'test-detail-artifacts-temp');

function item(id: string): Entry {
  return makeEntry({ id, slug: `slug-${id}`, title: `Title ${id}` });
}

describe('writeDetailArtifacts', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('writes one compact JSONL line per entry, byte-offset addressed', () => {
    const items = [item('a'), item('b'), item('c')];
    writeDetailArtifacts(items, TEST_DIR, 2);

    const jsonl0 = fs.readFileSync(path.join(TEST_DIR, 'details', 'detail-0.jsonl'));
    const jsonl1 = fs.readFileSync(path.join(TEST_DIR, 'details', 'detail-1.jsonl'));

    const index0 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'details', 'detail-index-0.json'), 'utf8'));
    const index1 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'details', 'detail-index-1.json'), 'utf8'));

    expect(Object.keys(index0).sort()).toEqual(['a', 'b']);
    expect(Object.keys(index1).sort()).toEqual(['c']);

    for (const [id, ref] of Object.entries(index0) as [string, { offset: number; length: number; sha256: string }][]) {
      const bytes = jsonl0.subarray(ref.offset, ref.offset + ref.length);
      const parsed = JSON.parse(bytes.toString('utf8'));
      expect(parsed.id).toBe(id);
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(ref.sha256);
    }
    for (const [id, ref] of Object.entries(index1) as [string, { offset: number; length: number; sha256: string }][]) {
      const bytes = jsonl1.subarray(ref.offset, ref.offset + ref.length);
      const parsed = JSON.parse(bytes.toString('utf8'));
      expect(parsed.id).toBe(id);
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(ref.sha256);
    }
  });

  it('matches the same shard boundaries write-artifacts uses for catalogue-N.json', () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`id-${i}`));
    writeDetailArtifacts(items, TEST_DIR, 2);

    const index0 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'details', 'detail-index-0.json'), 'utf8'));
    const index1 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'details', 'detail-index-1.json'), 'utf8'));
    const index2 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'details', 'detail-index-2.json'), 'utf8'));

    expect(Object.keys(index0).sort()).toEqual(['id-0', 'id-1']);
    expect(Object.keys(index1).sort()).toEqual(['id-2', 'id-3']);
    expect(Object.keys(index2).sort()).toEqual(['id-4']);
  });

  it('returns WrittenArtifactInfo entries for both the jsonl and the index, marked identity encoding', () => {
    const written = writeDetailArtifacts([item('a')], TEST_DIR, 2000);
    const jsonlInfo = written.find((w) => w.relativePath === 'details/detail-0.jsonl');
    const indexInfo = written.find((w) => w.relativePath === 'details/detail-index-0.json');

    expect(jsonlInfo?.encoding).toBe('identity');
    expect(indexInfo?.encoding).toBe('identity');
    expect(jsonlInfo?.entryCount).toBe(1);
  });

  it('produces an empty details directory (no shards) for zero entries', () => {
    const written = writeDetailArtifacts([], TEST_DIR, 2000);
    expect(written).toEqual([]);
  });

  it('newline-terminates each line (for generic per-line tooling) without including it in length/hash', () => {
    writeDetailArtifacts([item('a'), item('b')], TEST_DIR, 2000);

    const jsonl = fs.readFileSync(path.join(TEST_DIR, 'details', 'detail-0.jsonl'), 'utf8');
    const lines = jsonl.split('\n').filter((line) => line.trim());
    expect(lines).toHaveLength(2);
    expect(jsonl.endsWith('\n')).toBe(true);

    const index = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'details', 'detail-index-0.json'), 'utf8'));
    const ref = index.a as { offset: number; length: number; sha256: string };
    const raw = fs.readFileSync(path.join(TEST_DIR, 'details', 'detail-0.jsonl'));
    const sliced = raw.subarray(ref.offset, ref.offset + ref.length);
    expect(sliced.toString('utf8')).toBe(lines[0]);
    expect(crypto.createHash('sha256').update(sliced).digest('hex')).toBe(ref.sha256);
  });

  it('rejects a shardSize that is not a positive integer', () => {
    expect(() => writeDetailArtifacts([item('a')], TEST_DIR, 0)).toThrow();
    expect(() => writeDetailArtifacts([item('a')], TEST_DIR, -1)).toThrow();
    expect(() => writeDetailArtifacts([item('a')], TEST_DIR, 1.5)).toThrow();
  });

  it('rejects malformed entries before publication', () => {
    const source = item('bad');
    const malformed = { ...source, security: { ...source.security, score: 101 } };
    expect(() => writeDetailArtifacts([malformed], TEST_DIR, 2)).toThrow(/security.score/);
  });
});
