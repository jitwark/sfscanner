import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReleaseMetadata, hashReleaseDirectory } from './release-metadata.js';

const outputDir = path.join(process.cwd(), 'pipeline', '.work', `release-metadata-${Date.now()}`);

afterEach(() => fs.rmSync(outputDir, { recursive: true, force: true }));

describe('release metadata', () => {
  it('hashes sorted package bytes while excluding manifest.json', () => {
    fs.mkdirSync(path.join(outputDir, 'packs'), { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'packs', 'pack-0.jsonl'), '{"nodes":[]}\n');
    fs.writeFileSync(path.join(outputDir, 'manifest.json'), 'old');
    const first = hashReleaseDirectory(outputDir);
    fs.writeFileSync(path.join(outputDir, 'manifest.json'), 'new');
    expect(hashReleaseDirectory(outputDir)).toBe(first);
    fs.appendFileSync(path.join(outputDir, 'packs', 'pack-0.jsonl'), 'x');
    expect(hashReleaseDirectory(outputDir)).not.toBe(first);
  });

  it('rejects unknown scanner identity and incomplete generated metadata', () => {
    fs.mkdirSync(outputDir, { recursive: true });
    expect(() => buildReleaseMetadata({
      outputDir,
      corpusId: 'test',
      sanitizerVersion: 'sanitize-v2',
      scannerVersion: 'unknown',
      generatedAt: '2026-08-16T00:00:00.000Z',
    })).toThrow(/scannerVersion/);
    expect(() => buildReleaseMetadata({
      outputDir,
      corpusId: 'test',
      sanitizerVersion: 'sanitize-v2',
      scannerVersion: 'abc123',
      model: 'gemini',
      generatedAt: '2026-08-16T00:00:00.000Z',
    })).toThrow(/promptVersion/);
    expect(() => buildReleaseMetadata({
      outputDir,
      corpusId: 'test',
      sanitizerVersion: 'sanitize-v2',
      scannerVersion: 'abc123',
      generatedAt: 'not-a-timestamp',
    })).toThrow(/generatedAt/);
  });
});
