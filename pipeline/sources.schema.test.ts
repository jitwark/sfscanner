import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSourcesJson, validateSources } from './sources.schema.js';

describe('sources.schema', () => {
  it('validates community-hub/pipeline/sources.json without errors', () => {
    const raw = readFileSync(resolve(__dirname, 'sources.json'), 'utf8');
    const sources = parseSourcesJson(raw);
    expect(sources).toHaveLength(10);
    expect(sources.map((s) => s.key)).toContain('zie619');
  });

  it('rejects non-array input', () => {
    expect(() => validateSources({})).toThrow('sources must be an array');
  });

  it('rejects duplicate keys', () => {
    const data = [
      { key: 'test', kind: 'github', repo: 'a/b', branch: 'main', include: [], exclude: [], expectedLicence: 'MIT', status: 'active', note: 'test note', reviewedAt: '2026-08-13' },
      { key: 'test', kind: 'github', repo: 'c/d', branch: 'main', include: [], exclude: [], expectedLicence: 'MIT', status: 'active', note: 'test note', reviewedAt: '2026-08-13' },
    ];
    expect(() => validateSources(data)).toThrow('duplicate key test');
  });

  it('rejects malformed owner/repo', () => {
    const data = [
      { key: 'badrepo', kind: 'github', repo: 'invalid-repo-without-owner', branch: 'main', include: [], exclude: [], expectedLicence: 'MIT', status: 'active', note: 'note', reviewedAt: '2026-08-13' },
    ];
    expect(() => validateSources(data)).toThrow('repo is malformed');
  });

  it('rejects unknown fields', () => {
    const data = [
      { key: 'test', kind: 'github', repo: 'a/b', branch: 'main', include: [], exclude: [], expectedLicence: 'MIT', status: 'active', note: 'note', reviewedAt: '2026-08-13', unknownField: true },
    ];
    expect(() => validateSources(data)).toThrow('unknown field unknownField');
  });

  it('rejects repo/branch on official source', () => {
    const data = [
      { key: 'n8n_official', kind: 'n8n_official', repo: 'n8n/official', include: [], exclude: [], expectedLicence: null, status: 'active', note: 'note', reviewedAt: '2026-08-13' },
    ];
    expect(() => validateSources(data)).toThrow('official sources cannot define repo or branch');
  });
});
