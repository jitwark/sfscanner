import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCorpus } from '../build-corpus.js';
import { cloneSources } from './clone-sources.js';
import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import type { Candidate, EntrySecurity, SourceDef } from '@hub/contracts';
import { parseSourcesJson } from '../sources.schema.js';
import { makeV2RescanManifest, writeV2RescanManifest } from '../scan/v2-rescan-manifest.js';
import { buildScannerSourceReceipt } from '../scan/v2-source-receipt.js';
import { runScanStage } from '../corpus/scan-stage.js';

vi.mock('../corpus/scan-stage.js', () => ({
  runScanStage: vi.fn(async () => {}),
}));
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

const runId = 'test-build-corpus-resume-guard';
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

beforeEach(() => {
  vi.mocked(parseSourcesJson).mockReturnValue([source]);
  vi.mocked(cloneSources).mockResolvedValue({ repos: [], failures: [], requested: 1 });
});

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.rm(path.join(process.cwd(), 'pipeline', 'reports', `corpus-${runId}.md`), { force: true });
});

describe('build corpus acquire-state resume guard (integration)', () => {
  it('rejects an invalid previous run id before creating run state or acquiring sources', async () => {
    await expect(buildCorpus({ runId, previousRunId: '../escape' })).rejects.toThrow(/Invalid previousRunId/);
    expect(cloneSources).not.toHaveBeenCalled();
    await expect(fs.access(workDir)).rejects.toThrow();
  });

  it('proceeds normally when the run directory has no leftover acquire state', async () => {
    await expect(buildCorpus({ runId })).resolves.toMatchObject({ runId });
  });

  it('refuses a run whose .work directory has leftover acquire state, without --resume', async () => {
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(workDir, 'official-cursor.json'), '{}', 'utf8');

    await expect(buildCorpus({ runId })).rejects.toThrow(/--resume/);
  });

  it('proceeds when --resume is passed alongside leftover acquire state', async () => {
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(workDir, 'official-cursor.json'), '{}', 'utf8');

    await expect(buildCorpus({ runId, resume: true })).resolves.toMatchObject({ runId });
  });

  it('discards leftover acquire state when --clean is passed and proceeds', async () => {
    await fs.mkdir(path.join(workDir, 'clones', 'stale-key'), { recursive: true });
    await fs.writeFile(path.join(workDir, 'official-entries.json'), '[]', 'utf8');

    await expect(buildCorpus({ runId, clean: true })).resolves.toMatchObject({ runId });

    await expect(fs.access(path.join(workDir, 'official-entries.json'))).rejects.toThrow();
    await expect(fs.access(path.join(workDir, 'clones', 'stale-key'))).rejects.toThrow();
  });

  it('forwards manifest.receipt to previousRun when previousRunId is provided', async () => {
    const prevRunId = 'test-prev-run';
    const prevDir = path.join(process.cwd(), 'pipeline', '.work', prevRunId);
    await fs.mkdir(prevDir, { recursive: true });
    try {
      const receipt = await buildScannerSourceReceipt({ runId: prevRunId });
      const manifest = makeV2RescanManifest(prevRunId, [], receipt);
      await writeV2RescanManifest(prevDir, manifest);
      await fs.writeFile(path.join(prevDir, 'entries.json'), '[]', 'utf8');

      const result = await buildCorpus({ runId, previousRunId: prevRunId });
      expect(result).toMatchObject({ runId });

      expect(runScanStage).toHaveBeenCalledWith(
        expect.objectContaining({
          previousRun: expect.objectContaining({
            receipt: expect.objectContaining({
              sourceBuildDigest: receipt.sourceBuildDigest,
            }),
          }),
        }),
      );
    } finally {
      await fs.rm(prevDir, { recursive: true, force: true });
    }
  });
});
