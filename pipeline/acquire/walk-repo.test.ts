import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globToRegExp, matchGlobs, processWorkflowBuffer, walkRepo } from './walk-repo.js';

describe('walk-repo', () => {
  describe('glob matching', () => {
    it('handles **/*.json pattern', () => {
      const include = ['**/*.json'];
      const exclude = ['**/node_modules/**'];
      expect(matchGlobs('workflow.json', include, exclude)).toBe(true);
      expect(matchGlobs('sub/dir/workflow.json', include, exclude)).toBe(true);
      expect(matchGlobs('node_modules/pkg/workflow.json', include, exclude)).toBe(false);
      expect(matchGlobs('workflow.txt', include, exclude)).toBe(false);
    });

    it('handles complex exclude globs', () => {
      const include = ['**/*.json'];
      const exclude = ['**/node_modules/**', '**/.github/**', '**/docs/**', '**/test/**', '**/tests/**', '**/__tests__/**'];
      expect(matchGlobs('.github/workflows/ci.json', include, exclude)).toBe(false);
      expect(matchGlobs('docs/example.json', include, exclude)).toBe(false);
      expect(matchGlobs('tests/fixtures/test.json', include, exclude)).toBe(false);
      expect(matchGlobs('src/workflows/active.json', include, exclude)).toBe(true);
    });
  });

  describe('n8n shape predicate & fixtures', () => {
    const fixtureDir = resolve(__dirname, '__fixtures__');
    const commonOpts = {
      sourceKey: 'test-source',
      repo: 'owner/repo',
      ownerLogin: 'owner',
      stars: 100,
      commitSha: 'abc123456789',
      relPath: 'workflow.json',
      fetchedAt: '2026-08-13T00:00:00.000Z',
    };

    it('accepts real workflow fixture (workflow-1.json)', () => {
      const buffer = readFileSync(resolve(fixtureDir, 'workflow-1.json'));
      const res = processWorkflowBuffer({ ...commonOpts, buffer });
      expect(res.type).toBe('candidate');
      if (res.type === 'candidate') {
        expect(res.candidate.title).toBe('Translate cocktail instructions using DeepL');
        expect(res.candidate.source.permalink).toBe('https://github.com/owner/repo/blob/abc123456789/workflow.json');
        expect(res.candidate.source.commit).toBe('abc123456789');
        expect(res.candidate.rights.status).toBe('link_only');
        expect(res.candidate.blobSha).toMatch(/^[a-f0-9]{40}$/);
      }
    });

    it('rejects package.json fixture as not_a_workflow', () => {
      const buffer = readFileSync(resolve(fixtureDir, 'package.json'));
      const res = processWorkflowBuffer({ ...commonOpts, relPath: 'package.json', buffer });
      expect(res.type).toBe('reject');
      if (res.type === 'reject') {
        expect(res.reject.reason).toBe('not_a_workflow');
      }
    });

    it('rejects empty-nodes.json fixture as empty_nodes', () => {
      const buffer = readFileSync(resolve(fixtureDir, 'empty-nodes.json'));
      const res = processWorkflowBuffer({ ...commonOpts, relPath: 'empty-nodes.json', buffer });
      expect(res.type).toBe('reject');
      if (res.type === 'reject') {
        expect(res.reject.reason).toBe('empty_nodes');
      }
    });

    it('rejects oversized.json fixture as too_large', () => {
      const buffer = readFileSync(resolve(fixtureDir, 'oversized.json'));
      const res = processWorkflowBuffer({ ...commonOpts, relPath: 'oversized.json', buffer });
      expect(res.type).toBe('reject');
      if (res.type === 'reject') {
        expect(res.reject.reason).toBe('too_large');
      }
    });
  });

  describe('walkRepo directory scanning', () => {
    it('walks __fixtures__ directory returning candidates and rejects', async () => {
      const fixtureDir = resolve(__dirname, '__fixtures__');
      const res = await walkRepo(fixtureDir, {
        sourceKey: 'fixtures',
        repo: 'test/fixtures',
        ownerLogin: 'test',
        stars: 50,
        commitSha: '12345678',
        include: ['**/workflow-*.json', '**/package.json', '**/empty-nodes.json', '**/oversized.json'],
        exclude: [],
        fetchedAt: '2026-08-13T00:00:00.000Z',
      });
      expect(res.candidates.length).toBe(3); // workflow-1, workflow-2, workflow-3
      expect(res.rejects.length).toBe(3); // package.json, empty-nodes.json, oversized.json
    });
  });
});
