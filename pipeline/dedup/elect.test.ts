import { describe, expect, it } from 'vitest';
import { makeCandidate, makeRights, makeSource } from '../__fixtures__/make-entry.js';
import type { CandidateWithDedup } from './elect.js';
import { elect } from './elect.js';
describe('dedup/elect', () => {
  const commonJson = {
    nodes: [{ id: '1', name: 'Start', type: 'n8n-nodes-base.webhook' }],
    connections: {},
  };

  it('elects a redistributable GitHub copy over an official link-only entry', () => {
    const officialEntry: CandidateWithDedup = makeCandidate({
      id: 'official-100',
      title: 'Official Workflow',
      bytes: 100,
      json: commonJson,
      rights: makeRights({
        status: 'link_only',
        licence: null,
        licenceUrl: null,
        reason: 'official n8n template',
      }),
      source: makeSource({
        kind: 'n8n_official',
        permalink: 'https://n8n.io/workflows/100',
        stars: 500,
        committedAt: '2026-02-01T00:00:00Z',
      }),
    });

    const githubEntry: CandidateWithDedup = makeCandidate({
      id: 'github-zie619-wf1',
      title: 'GitHub Copy',
      bytes: 100,
      json: commonJson,
      rights: makeRights({
        status: 'redistributable',
        licence: 'MIT',
        licenceUrl: null,
        reason: 'repo licence MIT',
      }),
      source: makeSource({
        kind: 'github',
        repo: 'zie619/n8n',
        permalink: 'https://github.com/zie619/n8n/blob/main/wf1.json',
        stars: 10,
        committedAt: '2025-01-01T00:00:00Z',
      }),
    });

    const result = elect([officialEntry, githubEntry]);

    expect(result.canonical).toHaveLength(1);
    expect(result.canonical[0].id).toBe('github-zie619-wf1');
    expect(result.canonical[0].dedup?.canonical).toBe(true);
    expect(result.canonical[0].dedup?.alsoFoundIn).toEqual(['https://n8n.io/workflows/100']);

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].id).toBe('official-100');
    expect(result.duplicates[0].dedup?.canonical).toBe(false);
    expect(result.duplicates[0].dedup?.duplicateOf).toBe('github-zie619-wf1');
  });

  it('resolves a full tie deterministically by lexicographic entry id', () => {
    const entryA: CandidateWithDedup = makeCandidate({
      id: 'beta-entry',
      title: 'Tie Workflow',
      bytes: 100,
      json: commonJson,
      rights: makeRights({ status: 'redistributable', licence: 'MIT', licenceUrl: null, reason: 'MIT' }),
      source: makeSource({
        kind: 'github',
        repo: 'repo1/wf',
        permalink: 'https://github.com/repo1/wf.json',
        stars: 10,
        committedAt: '2025-01-01',
      }),
    });

    const entryB: CandidateWithDedup = makeCandidate({
      id: 'alpha-entry',
      title: 'Tie Workflow',
      bytes: 100,
      json: commonJson,
      rights: makeRights({ status: 'redistributable', licence: 'MIT', licenceUrl: null, reason: 'MIT' }),
      source: makeSource({
        kind: 'github',
        repo: 'repo2/wf',
        permalink: 'https://github.com/repo2/wf.json',
        stars: 10,
        committedAt: '2025-01-01',
      }),
    });

    const result = elect([entryA, entryB]);

    expect(result.canonical).toHaveLength(1);
    expect(result.canonical[0].id).toBe('alpha-entry');
  });

  it('remains stable and produces identical canonical count across shuffled input orders', () => {
    const candidates: CandidateWithDedup[] = Array.from({ length: 20 }, (_, i) =>
      makeCandidate({
        id: `cand-${String(i).padStart(2, '0')}`,
        title: `Workflow ${i}`,
        bytes: 200,
        json: {
          nodes: [
            { id: '1', name: 'Start', type: 'n8n-nodes-base.webhook' },
            { id: '2', name: 'Process', type: `n8n-nodes-base.${i % 5}` },
          ],
          connections: {},
        },
        rights: makeRights({
          status: i % 2 === 0 ? 'redistributable' : 'link_only',
          licence: 'MIT',
          licenceUrl: null,
          reason: 'MIT',
        }),
        source: makeSource({
          kind: 'github',
          repo: `user/repo-${i}`,
          permalink: `https://github.com/user/repo/wf-${i}.json`,
          stars: i * 5,
          committedAt: `2025-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
        }),
      }),
    );

    const result1 = elect(candidates);
    const shuffled = [...candidates].reverse();
    const result2 = elect(shuffled);

    expect(result1.stats).toEqual(result2.stats);
    expect(result1.canonical.map((c) => c.id)).toEqual(result2.canonical.map((c) => c.id));
  });

  it('uses the hashes the caller supplied instead of recomputing from json', () => {
    // Regression for run rederive-62: `build-corpus` computes a per-template
    // fingerprint for candidates that carry no `json`, and this function threw
    // it away and hashed `undefined` instead. All 11,490 official templates
    // landed in one exact-duplicate group and 11,489 were dropped, so the
    // official library added exactly 1 entry to the catalogue.
    const withoutJson = (id: string, fp: string): CandidateWithDedup => ({
      ...makeCandidate({
        id,
        title: `Template ${id}`,
        bytes: 0,
        json: null,
        rights: makeRights({ status: 'link_only', licence: null, licenceUrl: null, reason: 'official n8n template' }),
        source: makeSource({ kind: 'n8n_official', permalink: `https://n8n.io/workflows/${id}` }),
      }),
      dedup: { fingerprint: fp, structuralHash: `sh-${fp}`, canonical: false, alsoFoundIn: [] },
    });

    const result = elect([withoutJson('a', 'fp-a'), withoutJson('b', 'fp-b'), withoutJson('c', 'fp-c')]);

    expect(result.stats.canonicals).toBe(3);
    expect(result.stats.exactDuplicates).toBe(0);
    expect(result.canonical.map((c) => c.dedup?.fingerprint).sort()).toEqual(['fp-a', 'fp-b', 'fp-c']);
  });

  it('still collapses genuine duplicates that share a supplied hash', () => {
    const shared = (id: string): CandidateWithDedup => ({
      ...makeCandidate({
        id,
        title: `Template ${id}`,
        bytes: 0,
        json: null,
        rights: makeRights({ status: 'link_only', licence: null, licenceUrl: null, reason: 'official n8n template' }),
        source: makeSource({ kind: 'n8n_official', permalink: `https://n8n.io/workflows/${id}` }),
      }),
      dedup: { fingerprint: 'same', structuralHash: 'same', canonical: false, alsoFoundIn: [] },
    });

    const result = elect([shared('a'), shared('b')]);
    expect(result.stats.canonicals).toBe(1);
    expect(result.stats.exactDuplicates).toBe(1);
  });
});
