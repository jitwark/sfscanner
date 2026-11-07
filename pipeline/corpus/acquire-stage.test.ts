import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candidate, SourceDef } from '@hub/contracts';
import { runAcquireStage } from './acquire-stage.js';
import { parseSourcesJson } from '../sources.schema.js';
import { cloneSources } from '../acquire/clone-sources.js';
import { walkGitTree } from '../acquire/walk-git-tree.js';

vi.mock('../sources.schema.js', () => ({ parseSourcesJson: vi.fn() }));
vi.mock('../acquire/clone-sources.js', () => ({ cloneSources: vi.fn() }));
vi.mock('../acquire/walk-git-tree.js', () => ({ walkGitTree: vi.fn() }));

/**
 * Task 6.7, requirement 3. A workflow whose licence cannot be established at
 * the selected commit is dropped at acquisition, not acquired as a candidate
 * whose `licence: null` some later stage could read as "no restrictions".
 */
const runId = 'test-acquire-licence-evidence';
const workDir = path.join(process.cwd(), 'pipeline', '.work', runId);

const source = (key: string, repo: string): SourceDef => ({
  key,
  kind: 'github',
  repo,
  branch: 'main',
  include: [],
  exclude: [],
  expectedLicence: 'MIT',
  status: 'active',
  note: 'test source',
  reviewedAt: '2026-08-13',
});

const candidate = (repo: string, filePath: string): Candidate => ({
  id: `id-${repo.replace('/', '-')}`,
  source: {
    kind: 'github',
    repo,
    owner: repo.split('/')[0]!,
    path: filePath,
    commit: 'a'.repeat(40),
    permalink: `https://github.com/${repo}/blob/${'a'.repeat(40)}/${filePath}`,
    fetchedAt: '2026-08-13T00:00:00.000Z',
  },
  rights: { status: 'link_only', licence: 'MIT', licenceUrl: 'https://example.invalid/LICENSE', reason: 'pending' },
  title: 'fixture workflow',
  json: { name: 'fixture', nodes: [], connections: {} },
  bytes: 42,
  blobSha: 'b'.repeat(40),
});

const acquired = (
  definition: SourceDef,
  licenceFiles: Array<{ filename: string; sha256: string }>,
  apiLicence: boolean,
) => ({
  source: definition,
  metadata: {
    stargazers_count: 1,
    license: apiLicence ? { spdx_id: 'MIT', url: 'https://api.github.com/licenses/mit' } : null,
    owner: { login: definition.repo!.split('/')[0]! },
    html_url: `https://github.com/${definition.repo}`,
    archived: false,
    fork: false,
    licenceEvidence: { files: licenceFiles },
  },
  commit: 'a'.repeat(40),
  committedAt: '2026-08-13T00:00:00.000Z',
  walk: { candidates: [], rejects: [] },
});

beforeEach(async () => {
  await fs.mkdir(workDir, { recursive: true });
  vi.mocked(parseSourcesJson).mockReturnValue([
    source('unlicensed', 'owner/unlicensed'),
    source('licensed', 'owner/licensed'),
  ]);
  vi.mocked(walkGitTree).mockImplementation(async (_cloneDir, opts) => ({
    candidates: [candidate(opts.repo, 'workflows/one.json')],
    rejects: [],
  }));
});

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(workDir, { recursive: true, force: true });
});

const acquire = () =>
  runAcquireStage({
    runId,
    workDir,
    ledgerPath: path.join(workDir, 'stages.jsonl'),
    ledger: new Map(),
    kind: 'github',
    acceptPartial: false,
  });

describe('runAcquireStage licence evidence', () => {
  it('keeps the workflow when the repository licence instrument is recorded at the commit', async () => {
    vi.mocked(cloneSources).mockResolvedValue({
      repos: [
        acquired(source('licensed', 'owner/licensed'), [{ filename: 'LICENSE', sha256: 'licence-hash' }], true),
      ],
      failures: [],
      requested: 1,
    });

    const result = await acquire();

    expect(result.candidates.map((c) => c.source.repo)).toEqual(['owner/licensed']);
    expect(result.rejects).toEqual([]);
    expect(result.repoEvidence.get('owner/licensed')).toMatchObject({
      licenceFiles: [{ filename: 'LICENSE', sha256: 'licence-hash' }],
      licenceBasis: 'same-commit-file',
    });
  });

  it('drops the workflow when the licence cannot be established, and records why', async () => {
    vi.mocked(cloneSources).mockResolvedValue({
      repos: [acquired(source('unlicensed', 'owner/unlicensed'), [], false)],
      failures: [],
      requested: 1,
    });

    const result = await acquire();

    expect(result.candidates.some((c) => c.source.repo === 'owner/unlicensed')).toBe(false);
    expect(result.rejects).toEqual([
      {
        sourceKey: 'unlicensed',
        path: 'workflows/one.json',
        reason: 'rights_evidence_missing',
        detail: expect.stringContaining('cannot be established'),
      },
    ]);
    expect(result.repoEvidence.get('owner/unlicensed')).toMatchObject({
      licenceFiles: [],
      licenceBasis: 'none',
    });
  });

  it('keeps the workflow when only repository metadata carried the identifier', async () => {
    vi.mocked(cloneSources).mockResolvedValue({
      repos: [acquired(source('unlicensed', 'owner/unlicensed'), [], true)],
      failures: [],
      requested: 1,
    });

    const result = await acquire();

    expect(result.candidates).toHaveLength(1);
    expect(result.repoEvidence.get('owner/unlicensed')?.licenceBasis).toBe('metadata-only');
  });
});
