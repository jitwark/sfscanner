import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceDef } from '@hub/contracts';
import { buildCorpus } from '../build-corpus.js';
import { cloneSources, type AcquiredRepo } from './clone-sources.js';
import { readAcquisitionManifest } from './acquisition-manifest.js';
import { parseSourcesJson } from '../sources.schema.js';

vi.mock('../sources.schema.js', () => ({ parseSourcesJson: vi.fn() }));
vi.mock('./clone-sources.js', () => ({ cloneSources: vi.fn() }));
vi.mock('./walk-git-tree.js', () => ({
  walkGitTree: vi.fn(async () => ({ candidates: [], rejects: [] })),
}));

vi.mock('../cross-check.js', () => ({
  runCrossCheck: vi.fn(async () => ({
    totalVaultFiles: 0,
    matchedCount: 0,
    orphanCount: 0,
    prefixCounts: {},
  })),
}));

const runId = 'test-build-acquisition-manifest';
const workDir = path.join(process.cwd(), 'pipeline', '.work', runId);
const source = (key: string): SourceDef => ({
  key,
  kind: 'github',
  repo: `owner/${key}`,
  branch: 'main',
  include: [],
  exclude: [],
  expectedLicence: null,
  status: 'active',
  note: 'test source',
  reviewedAt: '2026-08-13',
});
const acquired = (definition: SourceDef): AcquiredRepo => ({
  source: definition,
  metadata: {
    stargazers_count: 1,
    license: null,
    owner: { login: 'owner' },
    html_url: `https://github.com/${definition.repo}`,
    archived: false,
    fork: false,
    licenceEvidence: { files: [] },
  },
  commit: 'a'.repeat(40),
  committedAt: '2026-08-13T00:00:00.000Z',
  walk: { candidates: [], rejects: [] },
});

beforeEach(() => {
  vi.mocked(parseSourcesJson).mockReturnValue([source('good'), source('bad')]);
  vi.mocked(cloneSources).mockResolvedValue({
    repos: [],
    failures: [{ key: 'bad', error: 'repository unavailable' }],
    requested: 2,
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.rm(path.join(process.cwd(), 'pipeline', 'reports', `corpus-${runId}.md`), { force: true });
});

describe('build corpus acquisition manifest', () => {
  it('keeps corpus modules off the app scanner engine', async () => {
    // The scan stage lives in `pipeline/corpus/`; no corpus module may reach the
    // app's scanner engine. Routing behaviour is covered by the v2 adapter tests,
    // so this guard does not pin a particular call symbol.
    const corpusDir = path.join(process.cwd(), 'pipeline', 'corpus');
    const corpusModules = (await fs.readdir(corpusDir)).filter((name) => name.endsWith('.ts'));
    const files = ['build-corpus.ts', ...corpusModules.map((name) => path.join('corpus', name))];
    const sources = await Promise.all(
      files.map((file) => fs.readFile(path.join(process.cwd(), 'pipeline', file), 'utf8')),
    );

    for (const source of sources) {
      expect(source).not.toContain('../app/src/scanner/engine.js');
    }
  });

  it('writes an incomplete manifest with the failed source and reason', async () => {
    await buildCorpus({ runId });

    const manifest = await readAcquisitionManifest(path.join(workDir, 'acquisition-manifest.json'));
    expect(manifest.requestedSourceKeys).toEqual(['bad', 'good']);
    expect(manifest.acquiredSourceKeys).toEqual([]);
    expect(manifest.failures).toEqual([{ key: 'bad', error: 'repository unavailable' }]);
    expect(manifest.complete).toBe(false);
  });

  it('writes a complete manifest when every source is acquired', async () => {
    vi.mocked(cloneSources).mockResolvedValue({
      repos: [acquired(source('good')), acquired(source('bad'))],
      failures: [],
      requested: 2,
    });

    await buildCorpus({ runId });

    const manifest = await readAcquisitionManifest(path.join(workDir, 'acquisition-manifest.json'));
    expect(manifest.complete).toBe(true);
    expect(manifest.counts).toEqual({ requested: 2, acquired: 2, failed: 0 });
  });
});
