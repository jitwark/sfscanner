import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceDef } from '@hub/contracts';
import { buildCorpus } from '../build-corpus.js';
import { makeCandidate } from '../__fixtures__/make-entry.js';
import { walkGitTree } from './walk-git-tree.js';
import { cloneSources, type AcquiredRepo } from './clone-sources.js';
import { parseSourcesJson } from '../sources.schema.js';

vi.mock('../sources.schema.js', () => ({ parseSourcesJson: vi.fn() }));
vi.mock('./clone-sources.js', () => ({ cloneSources: vi.fn() }));
vi.mock('./walk-git-tree.js', () => ({ walkGitTree: vi.fn() }));
vi.mock('../cross-check.js', () => ({
  runCrossCheck: vi.fn(async () => ({
    totalVaultFiles: 0,
    matchedCount: 0,
    orphanCount: 0,
    prefixCounts: {},
  })),
}));

const EXCLUDED_ID = 'a1b2c3d4e5f60718';
const KEPT_ID = '0011223344556677';

// The production registry (`exclusions.json`) is empty — no owner-approved
// exclusion exists yet. To prove `build-corpus.ts` actually calls the filter
// and acts on its result (not just that the filter function works in
// isolation, which `exclusion-filter.test.ts` already covers), this replaces
// the module with a fake registry that excludes one specific id.
vi.mock('../rights/exclusion-filter.js', () => ({
  filterExcludedCandidates: vi.fn((candidates: Array<{ id: string }>) => ({
    included: candidates.filter((c) => c.id !== EXCLUDED_ID),
    excluded: candidates.filter((c) => c.id === EXCLUDED_ID),
  })),
}));

const runId = 'test-build-corpus-exclusion';
const workDir = path.join(process.cwd(), 'pipeline', '.work', runId);
const source: SourceDef = {
  key: 'good',
  kind: 'github',
  repo: 'owner/good',
  branch: 'main',
  include: [],
  exclude: [],
  expectedLicence: null,
  status: 'active',
  note: 'test source',
  reviewedAt: '2026-08-13',
};
const acquired: AcquiredRepo = {
  source,
  metadata: {
    stargazers_count: 1,
    license: { spdx_id: 'MIT', url: null },
    owner: { login: 'owner' },
    html_url: 'https://github.com/owner/good',
    archived: false,
    fork: false,
    licenceEvidence: { files: [] },
  },
  commit: 'a'.repeat(40),
  committedAt: '2026-08-13T00:00:00.000Z',
  walk: { candidates: [], rejects: [] },
};

beforeEach(() => {
  vi.mocked(parseSourcesJson).mockReturnValue([source]);
  vi.mocked(cloneSources).mockResolvedValue({ repos: [acquired], failures: [], requested: 1 });
  vi.mocked(walkGitTree).mockResolvedValue({
    candidates: [
      makeCandidate({ id: EXCLUDED_ID, title: 'Should be excluded' }),
      makeCandidate({ id: KEPT_ID, title: 'Should be kept' }),
    ],
    rejects: [],
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.rm(path.join(process.cwd(), 'pipeline', 'reports', `corpus-${runId}.md`), { force: true });
});

describe('build corpus exclusion wiring', () => {
  it('drops an excluded candidate before it reaches entries.json, the acquisition-adjacent output', async () => {
    await buildCorpus({ runId });

    const entries = JSON.parse(await fs.readFile(path.join(workDir, 'entries.json'), 'utf8')) as Array<{
      entry: { id: string };
    }>;
    const ids = entries.map((e) => e.entry.id);

    expect(ids).not.toContain(EXCLUDED_ID);
    expect(ids).toContain(KEPT_ID);
  });
});
