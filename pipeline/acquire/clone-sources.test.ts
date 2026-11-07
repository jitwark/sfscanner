import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceDef } from '@hub/contracts';
import { cloneSources, type AcquiredRepo } from './clone-sources.js';
import { collectLicenceEvidence, type GitRunner } from './licence-collection.js';

const execFileAsync = promisify(execFile);
const FIXTURE_REPO = path.join(process.cwd(), 'pipeline', 'acquire', '__fixtures__', 'licence-evidence');

/** The real git binary, bound to a clone directory — same runner production builds. */
function gitIn(cloneDir: string): GitRunner {
  return async (args) => (await execFileAsync('git', args, { cwd: cloneDir })).stdout.trim();
}

const runId = 'test-acquisition-completeness';
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

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('cloneSources acquisition completeness', () => {
  it('returns failures without aborting the remaining sources', async () => {
    const result = await cloneSources([source('good'), source('bad')], {
      runId,
      acquireOne: async (item) => {
        if (item.key === 'bad') throw new Error('repository unavailable');
        return acquired(item);
      },
    });

    expect(result.repos.map((repo) => repo.source.key)).toEqual(['good']);
    expect(result.failures).toEqual([{ key: 'bad', error: 'repository unavailable' }]);
    expect(result.requested).toBe(2);

  });

  it('returns every repository when all sources succeed', async () => {
    const result = await cloneSources([source('one'), source('two')], {
      runId,
      acquireOne: async (item) => acquired(item),
    });

    expect(result.repos.map((repo) => repo.source.key)).toEqual(['one', 'two']);
    expect(result.failures).toEqual([]);
    expect(result.requested).toBe(2);
  });
});

/**
 * Task 6.7, requirement 2 — the root/nested/sibling evidence hashes the rights
 * decision is supposed to read.
 *
 * Clones are `--no-checkout`, so this runs against a real local git repository
 * built from the fixture files in `__fixtures__/licence-evidence/`. That is the
 * only way to see what `ls-tree` actually returns: an in-memory stub would
 * encode the same assumption as the code under test.
 */
describe('collectLicenceEvidence', () => {
  let repository: string | undefined;

  afterEach(async () => {
    if (repository) await fs.rm(repository, { recursive: true, force: true });
    repository = undefined;
  });

  async function buildFixtureRepository(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-licence-evidence-'));
    await fs.cp(FIXTURE_REPO, directory, { recursive: true });
    // `-c core.autocrlf=false` so the committed blobs are the bytes on disk, which
    // is what makes the SHA-256 comparison below a real check rather than a
    // round-trip through git's own conversion.
    const options = { cwd: directory };
    await execFileAsync('git', ['-c', 'core.autocrlf=false', 'init', '--quiet'], options);
    await execFileAsync('git', ['add', '--all'], options);
    await execFileAsync(
      'git',
      ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '--quiet', '--message=fixture'],
      options,
    );
    return directory;
  }

  it('records the root licence and notice instruments with their blob hashes', async () => {
    repository = await buildFixtureRepository();

    const evidence = await collectLicenceEvidence(gitIn(repository));

    const names = evidence.files.map((file) => file.filename).sort();
    expect(names).toEqual(['LICENSE', 'NOTICE', 'collection/LICENSE']);

    const rootLicence = evidence.files.find((file) => file.filename === 'LICENSE')!;
    const onDisk = await fs.readFile(path.join(FIXTURE_REPO, 'LICENSE'), 'utf8');
    expect(rootLicence.sha256).toMatch(/^[0-9a-f]{64}$/);
    // `runCommand` trims the text `git cat-file` returns, so the hash is over the
    // licence text without its trailing whitespace — the same normalisation the
    // collector has always applied.
    expect(rootLicence.sha256).toBe(
      createHash('sha256').update(onDisk.trim(), 'utf8').digest('hex'),
    );
  });

  it('records a licence instrument in a subdirectory, so a subtree conflict is visible to the decision', async () => {
    repository = await buildFixtureRepository();

    const evidence = await collectLicenceEvidence(gitIn(repository));

    const nested = evidence.files.find((file) => file.filename === 'collection/LICENSE');
    const root = evidence.files.find((file) => file.filename === 'LICENSE');
    expect(nested).toBeDefined();
    // Different bytes from the repository licence: not the same terms restated.
    expect(nested!.sha256).not.toBe(root!.sha256);
  });

  it('keeps the root README as the README evidence, never a nested one', async () => {
    repository = await buildFixtureRepository();

    const evidence = await collectLicenceEvidence(gitIn(repository));

    expect(evidence.readmeSnippet).toContain('Fixture data for the rights-evidence tests. Root README.');
    expect(evidence.readmeSnippet).not.toContain('Fixture subtree README');
  });
});
