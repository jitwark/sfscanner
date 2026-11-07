import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SourceDef } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { validateSources } from '../sources.schema.js';
import { walkRepo, type WalkRepoResult } from './walk-repo.js';
import { collectLicenceEvidence } from './licence-collection.js';
import type { AcquisitionFailure } from './acquisition-manifest.js';

export type RepoMetadata = {
  stargazers_count: number;
  license: { spdx_id: string | null; url: string | null } | null;
  owner: { login: string };
  html_url: string;
  archived: boolean;
  fork: boolean;
  licenceEvidence: {
    files: Array<{ filename: string; sha256: string }>;
    readmeSnippet?: string;
  };
};

export type AcquiredRepo = {
  source: SourceDef;
  metadata: RepoMetadata;
  commit: string;
  committedAt: string;
  walk: WalkRepoResult;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineDir = path.resolve(here, '..');
function runCommand(executable: string, args: string[], cwd?: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) resolve(stdout.trim());
    else reject(new Error(`${executable} ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
  });
  return promise;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function fetchRepoMetadata(repo: string, token = process.env.GITHUB_TOKEN): Promise<Omit<RepoMetadata, 'licenceEvidence'>> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'n8n-community-hub-acq',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub metadata fetch for ${repo} failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as Record<string, any>;
  return {
    stargazers_count: Number(body.stargazers_count) || 0,
    license: body.license && typeof body.license === 'object' ? { spdx_id: body.license.spdx_id ?? null, url: body.license.url ?? null } : null,
    owner: { login: String(body.owner?.login ?? repo.split('/')[0]) },
    html_url: String(body.html_url ?? `https://github.com/${repo}`),
    archived: Boolean(body.archived),
    fork: Boolean(body.fork),
  };
}

async function cloneOneSource(source: SourceDef, workRoot: string, fetchedAt: string): Promise<AcquiredRepo> {
  if (source.kind !== 'github' || !source.repo) {
    throw new Error(`Source ${source.key} is not a GitHub source`);
  }
  const branch = source.branch || 'main';
  const destination = path.join(workRoot, 'clones', source.key);

  await mkdir(path.dirname(destination), { recursive: true });
  // `--no-checkout`: workflows are read straight out of the object database by
  // `walk-git-tree.ts`, so no working tree is needed. That is faster, and it is
  // the only way to read repositories whose filenames exceed the Windows
  // 260-character path limit, where checkout fails even with core.longpaths set.
  const gitConfig = ['-c', 'core.longpaths=true'];
  if (await pathExists(path.join(destination, '.git'))) {
    await runCommand('git', [...gitConfig, 'fetch', '--depth', '1', 'origin', branch], destination);
    await runCommand('git', [...gitConfig, 'update-ref', 'HEAD', 'FETCH_HEAD'], destination);
  } else {
    await runCommand('git', [
      ...gitConfig,
      'clone',
      '--no-checkout',
      '--depth',
      '1',
      '--single-branch',
      '--branch',
      branch,
      `https://github.com/${source.repo}.git`,
      destination,
    ]);
  }

  const commit = await runCommand('git', ['rev-parse', 'HEAD'], destination);
  const committedAt = await runCommand('git', ['log', '-1', '--format=%cI'], destination);

  const metaNoEvidence = await fetchRepoMetadata(source.repo);
  const licenceEvidence = await collectLicenceEvidence((args) => runCommand('git', args, destination));
  const metadata: RepoMetadata = { ...metaNoEvidence, licenceEvidence };

  const walk = await walkRepo(destination, {
    sourceKey: source.key,
    repo: source.repo,
    ownerLogin: metadata.owner.login,
    stars: metadata.stargazers_count,
    commitSha: commit,
    include: source.include,
    exclude: source.exclude,
    fetchedAt,
  });

  return { source, metadata, commit, committedAt, walk };
}

export type CloneSourcesOptions = {
  runId: string;
  only?: string;
  fetchedAt?: string;
  concurrency?: number;
  acquireOne?: (source: SourceDef, workRoot: string, fetchedAt: string) => Promise<AcquiredRepo>;
};

export type CloneSourcesResult = {
  repos: AcquiredRepo[];
  failures: AcquisitionFailure[];
  requested: number;
};

export async function cloneSources(
  sources: SourceDef[],
  options: CloneSourcesOptions,
): Promise<CloneSourcesResult> {
  const active = sources.filter(
    (s) => s.status === 'active' && s.kind === 'github' && (!options.only || s.key === options.only),
  );

  const workRoot = path.join(pipelineDir, '.work', options.runId);
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const results: AcquiredRepo[] = [];
  let index = 0;
  const limit = Math.max(1, Math.min(4, options.concurrency ?? 4));
  const failures: AcquisitionFailure[] = [];
  const acquireOne = options.acquireOne ?? cloneOneSource;

  async function worker() {
    while (index < active.length) {
      const source = active[index++]!;
      try {
        results.push(await acquireOne(source, workRoot, fetchedAt));
      } catch (error) {
        // One unreachable, renamed, or unclonable repository must not abort a
        // ten-source acquisition. Record it and keep going; the run report shows
        // which sources contributed nothing and why.
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ key: source.key, error: message });
        process.stderr.write(`  source ${source.key} failed: ${message.split('\n')[0]}\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, active.length) }, worker));
  if (failures.length > 0) {
    process.stderr.write(`  ${failures.length} of ${active.length} sources failed to acquire\n`);
  }
  const repos = results.sort((a, b) => compareCanonicalStrings(a.source.key, b.source.key));
  failures.sort((a, b) => compareCanonicalStrings(a.key, b.key));
  return { repos, failures, requested: active.length };
}

async function main() {
  const args = process.argv.slice(2);
  const runIdx = args.indexOf('--run');
  const onlyIdx = args.indexOf('--only');
  if (runIdx < 0 || !args[runIdx + 1]) {
    throw new Error('Usage: npx tsx pipeline/acquire/clone-sources.ts --run <runId> [--only <sourceKey>]');
  }

  const runId = args[runIdx + 1]!;
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;

  const rawJson = await readFile(path.join(pipelineDir, 'sources.json'), 'utf8');
  const sources = validateSources(JSON.parse(rawJson));

  const acquisition = await cloneSources(sources, { runId, only });
  for (const repo of acquisition.repos) {
    console.log(`[${repo.source.key}] ${repo.source.repo}`);
    console.log(`  Commit: ${repo.commit}`);
    console.log(`  CommittedAt: ${repo.committedAt}`);
    console.log(`  Stars: ${repo.metadata.stargazers_count}`);
    console.log(`  SPDX Licence: ${repo.metadata.license?.spdx_id ?? 'none'}`);
    console.log(`  Candidates: ${repo.walk.candidates.length}`);
    console.log(`  Rejects: ${repo.walk.rejects.length}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
