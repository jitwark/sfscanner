import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryWithChart } from '@hub/contracts';
import { makeEntryWithChart } from '../__fixtures__/make-entry.js';
import { writePreviewArtifacts } from './write-preview-artifacts.js';

const TEST_DIR = path.join(process.cwd(), 'pipeline', '.work', 'test-preview-artifacts-temp');

function item(id: string): EntryWithChart {
  return makeEntryWithChart({ id, slug: `slug-${id}`, title: `Title ${id}` });
}

describe('writePreviewArtifacts', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('writes one rendered preview per entry, byte-offset addressed', () => {
    const items = [item('a'), item('b'), item('c')];
    writePreviewArtifacts(items, TEST_DIR, 2);

    const jsonl0 = fs.readFileSync(path.join(TEST_DIR, 'previews', 'preview-0.jsonl'));
    const index0 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'previews', 'preview-index-0.json'), 'utf8'));
    const index1 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'previews', 'preview-index-1.json'), 'utf8'));

    expect(Object.keys(index0).sort()).toEqual(['a', 'b']);
    expect(Object.keys(index1).sort()).toEqual(['c']);

    for (const [id, ref] of Object.entries(index0) as [string, { offset: number; length: number; sha256: string }][]) {
      const bytes = jsonl0.subarray(ref.offset, ref.offset + ref.length);
      const parsed = JSON.parse(bytes.toString('utf8'));
      expect(parsed.id).toBe(id);
      expect(parsed.tier).toBe('A');
      expect(typeof parsed.svg).toBe('string');
      expect(Array.isArray(parsed.nodeList)).toBe(true);
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(ref.sha256);
    }
  });

  it('matches the same shard boundaries write-artifacts uses for catalogue-N.json', () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`id-${i}`));
    writePreviewArtifacts(items, TEST_DIR, 2);

    const index0 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'previews', 'preview-index-0.json'), 'utf8'));
    const index1 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'previews', 'preview-index-1.json'), 'utf8'));
    const index2 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'previews', 'preview-index-2.json'), 'utf8'));

    expect(Object.keys(index0).sort()).toEqual(['id-0', 'id-1']);
    expect(Object.keys(index1).sort()).toEqual(['id-2', 'id-3']);
    expect(Object.keys(index2).sort()).toEqual(['id-4']);
  });

  it('returns WrittenArtifactInfo entries for both the jsonl and the index, marked identity encoding', () => {
    const written = writePreviewArtifacts([item('a')], TEST_DIR, 2000);
    const jsonlInfo = written.find((w) => w.relativePath === 'previews/preview-0.jsonl');
    const indexInfo = written.find((w) => w.relativePath === 'previews/preview-index-0.json');

    expect(jsonlInfo?.encoding).toBe('identity');
    expect(indexInfo?.encoding).toBe('identity');
    expect(jsonlInfo?.entryCount).toBe(1);
  });

  it('produces no preview directory contents for zero entries', () => {
    const written = writePreviewArtifacts([], TEST_DIR, 2000);
    expect(written).toEqual([]);
  });

  it('rejects a shardSize that is not a positive integer', () => {
    expect(() => writePreviewArtifacts([item('a')], TEST_DIR, 0)).toThrow();
    expect(() => writePreviewArtifacts([item('a')], TEST_DIR, -1)).toThrow();
    expect(() => writePreviewArtifacts([item('a')], TEST_DIR, 1.5)).toThrow();
  });

  it('reflects an entry with no resolvable chart as the finite invalid tier, not a crash', () => {
    const empty = makeEntryWithChart({ id: 'empty' }, { nodes: [], edges: [] });
    writePreviewArtifacts([empty], TEST_DIR, 10);

    const jsonl = fs.readFileSync(path.join(TEST_DIR, 'previews', 'preview-0.jsonl'), 'utf8');
    const parsed = JSON.parse(jsonl.trim());
    expect(parsed.tier).toBe('invalid');
    expect(parsed.nodeList).toEqual([]);
  });
});
