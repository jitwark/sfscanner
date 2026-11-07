import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Candidate, EntrySource, Reject } from '@hub/contracts';
import { LIMITS } from '@hub/contracts';
import { entryId } from './entry-id.js';

export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/');
  let reStr = '';
  let i = 0;
  while (i < normalized.length) {
    if (normalized.substring(i, i + 3) === '**/') {
      reStr += '(?:.*/|^)';
      i += 3;
    } else if (normalized.substring(i, i + 3) === '/**') {
      reStr += '(?:/.*|$)';
      i += 3;
    } else if (normalized.substring(i, i + 2) === '**') {
      reStr += '.*';
      i += 2;
    } else if (normalized[i] === '*') {
      reStr += '[^/]*';
      i++;
    } else if (normalized[i] === '?') {
      reStr += '[^/]';
      i++;
    } else if (['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'].includes(normalized[i]!)) {
      reStr += '\\' + normalized[i];
      i++;
    } else {
      reStr += normalized[i];
      i++;
    }
  }
  return new RegExp(`^${reStr}$`);
}

export function matchGlobs(relPath: string, include: string[], exclude: string[]): boolean {
  const norm = relPath.replace(/\\/g, '/');
  const incRegexes = include.length > 0 ? include.map(globToRegExp) : [/^.*\.json$/];
  const excRegexes = exclude.map(globToRegExp);

  if (!incRegexes.some((re) => re.test(norm))) return false;
  if (excRegexes.some((re) => re.test(norm))) return false;
  return true;
}

export function computeBlobSha(buffer: Buffer): string {
  const header = Buffer.from(`blob ${buffer.length}\0`);
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

export type WalkFileOptions = {
  sourceKey: string;
  repo: string;
  ownerLogin: string;
  stars: number;
  commitSha: string;
  committedAt?: string;
  relPath: string;
  buffer: Buffer;
  fetchedAt?: string;
  /** Repo licence evidence from the one REST call; the rights stage decides on it. */
  spdxId?: string | null;
  licenceUrl?: string | null;
};

export type WalkFileResult =
  | { type: 'candidate'; candidate: Candidate }
  | { type: 'reject'; reject: Reject };

export function processWorkflowBuffer(opts: WalkFileOptions): WalkFileResult {
  const { sourceKey, repo, ownerLogin, stars, commitSha, relPath, buffer } = opts;
  const fetchedAt = opts.fetchedAt || new Date().toISOString();
  const bytes = buffer.length;

  if (bytes > LIMITS.maxWorkflowBytes) {
    return {
      type: 'reject',
      reject: {
        sourceKey,
        path: relPath,
        reason: 'too_large',
        detail: `File size ${bytes} exceeds limit ${LIMITS.maxWorkflowBytes}`,
      },
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    return {
      type: 'reject',
      reject: {
        sourceKey,
        path: relPath,
        reason: 'invalid_json',
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return {
      type: 'reject',
      reject: {
        sourceKey,
        path: relPath,
        reason: 'not_a_workflow',
        detail: 'Root JSON is not an object',
      },
    };
  }

  const obj = json as Record<string, unknown>;

  if (!('nodes' in obj) || !Array.isArray(obj.nodes)) {
    return {
      type: 'reject',
      reject: {
        sourceKey,
        path: relPath,
        reason: 'not_a_workflow',
        detail: 'Missing or non-array nodes property',
      },
    };
  }

  if (obj.nodes.length === 0) {
    return {
      type: 'reject',
      reject: {
        sourceKey,
        path: relPath,
        reason: 'empty_nodes',
        detail: 'nodes array is empty',
      },
    };
  }

  if (!('connections' in obj) || typeof obj.connections !== 'object' || obj.connections === null) {
    return {
      type: 'reject',
      reject: {
        sourceKey,
        path: relPath,
        reason: 'not_a_workflow',
        detail: 'Missing or invalid connections object',
      },
    };
  }

  const normalizedPath = relPath.replace(/\\/g, '/');
  const id = entryId('github', repo, normalizedPath);
  const title = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : path.basename(normalizedPath, '.json');

  let upstreamDescription: string | undefined;
  if (obj.meta && typeof obj.meta === 'object' && 'description' in obj.meta && typeof (obj.meta as Record<string, unknown>).description === 'string') {
    upstreamDescription = (obj.meta as Record<string, unknown>).description as string;
  } else if ('description' in obj && typeof obj.description === 'string') {
    upstreamDescription = obj.description;
  }

  const permalink = `https://github.com/${repo}/blob/${commitSha}/${normalizedPath}`;
  const blobSha = computeBlobSha(buffer);

  const source: EntrySource = {
    kind: 'github',
    repo,
    owner: ownerLogin,
    stars,
    path: normalizedPath,
    commit: commitSha,
    ...(opts.committedAt ? { committedAt: opts.committedAt } : {}),
    permalink,
    fetchedAt,
  };

  const candidate: Candidate = {
    id,
    title,
    upstreamDescription,
    json,
    bytes,
    blobSha,
    source,
    rights: {
      // Carries the acquired evidence only. `decideRights` sets the real status
      // and reason; leaving licence null here made every MIT repo link-only.
      status: 'link_only',
      licence: opts.spdxId ?? null,
      licenceUrl: opts.licenceUrl ?? null,
      reason: 'pending',
    },
  };

  return { type: 'candidate', candidate };
}

export type WalkRepoOptions = {
  sourceKey: string;
  repo: string;
  ownerLogin: string;
  stars: number;
  commitSha: string;
  committedAt?: string;
  include: string[];
  exclude: string[];
  fetchedAt?: string;
  spdxId?: string | null;
  licenceUrl?: string | null;
};

export type WalkRepoResult = {
  candidates: Candidate[];
  rejects: Reject[];
};

export async function walkRepo(cloneDir: string, opts: WalkRepoOptions): Promise<WalkRepoResult> {
  const candidates: Candidate[] = [];
  const rejects: Reject[] = [];

  async function walkDir(currentDir: string) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      // Dot-directories are tooling artifacts (.git, .github, .playwright-mcp,
      // .vscode). None of them hold publishable workflows, and one of them put
      // `.playwright-mcp/` paths into a real acquisition run.
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(cloneDir, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else if (entry.isFile()) {
        if (!matchGlobs(relPath, opts.include, opts.exclude)) {
          continue;
        }

        const buffer = await readFile(fullPath);
        const res = processWorkflowBuffer({
          sourceKey: opts.sourceKey,
          repo: opts.repo,
          ownerLogin: opts.ownerLogin,
          stars: opts.stars,
          commitSha: opts.commitSha,
          committedAt: opts.committedAt,
          relPath,
          buffer,
          fetchedAt: opts.fetchedAt,
          spdxId: opts.spdxId,
          licenceUrl: opts.licenceUrl,
        });

        if (res.type === 'candidate') {
          candidates.push(res.candidate);
        } else {
          rejects.push(res.reject);
        }
      }
    }
  }

  await walkDir(cloneDir);
  return { candidates, rejects };
}
