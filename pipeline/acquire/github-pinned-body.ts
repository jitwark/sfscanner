import { createHash } from 'node:crypto';
import { computeBlobSha } from './walk-repo.js';

export type CatalogueSourceRow = {
  kind: string | null;
  repo: string | null;
  owner: string | null;
  path: string | null;
  commit: string | null;
  permalink: string | null;
};

export type PinnedBodyResult = { body: Buffer; reason?: never } | { body?: never; reason: string };

const API = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const RATE_LIMIT_RETRIES = 3;
let paceQueue = Promise.resolve();
let nextRequestAt = 0;

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function paceRequest(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const turn = paceQueue;
  paceQueue = promise;
  await turn;
  const now = Date.now();
  const wait = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + 250;
  resolve();
  if (wait > 0) await delay(wait);
}

async function githubGet(url: string, token: string, accept = 'application/vnd.github+json', redirect: RequestInit['redirect'] = 'manual'): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await paceRequest();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
          'User-Agent': 'n8n-community-hub-authentic-acquisition',
          'X-GitHub-Api-Version': API_VERSION,
        },
        redirect,
      });
    } catch (error) {
      if (attempt >= RATE_LIMIT_RETRIES) throw new Error(`GitHub request failed: ${String(error)}`);
      await delay(1000 * 2 ** attempt);
      continue;
    }

    if (response.status !== 403 && response.status !== 429) {
      if (!response.ok) await response.body?.cancel();
      return response;
    }
    const message = await response.clone().text();
    const remaining = response.headers.get('x-ratelimit-remaining');
    const rateLimited = response.status === 429 || remaining === '0' || /rate limit|abuse detection/i.test(message);
    if (!rateLimited) {
      await response.body?.cancel();
      return response;
    }
    if (attempt >= RATE_LIMIT_RETRIES) {
      await response.body?.cancel();
      throw new Error(`GitHub rate limit retry exhausted (HTTP ${response.status})`);
    }

    const retryAfter = Number(response.headers.get('retry-after'));
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : remaining === '0' && Number.isFinite(reset)
        ? Math.max(1000, reset * 1000 - Date.now() + 1000)
        : 60_000 * 2 ** attempt;
    await response.body?.cancel();
    process.stderr.write(`GitHub rate limit; waiting ${Math.ceil(wait / 1000)}s before retry\n`);
    await delay(wait);
  }
}

function repositoryApiPath(repo: string): string {
  return `${API}/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;
}

export async function checkRepository(repo: string, token: string): Promise<string | null> {
  const response = await githubGet(repositoryApiPath(repo), token);
  if (response.ok) {
    await response.body?.cancel();
    return null;
  }
  if (response.status === 404) return 'repository_unavailable';
  if (response.status === 403) return 'repository_forbidden';
  if ([301, 302, 307, 308].includes(response.status)) return 'repository_redirected';
  throw new Error(`GitHub repository check failed for ${repo}: HTTP ${response.status}`);
}

function workflowReason(body: Buffer): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return 'invalid_json';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'not_a_workflow';
  const workflow = parsed as Record<string, unknown>;
  if (!Array.isArray(workflow.nodes)) return 'not_a_workflow';
  if (workflow.nodes.length === 0) return 'empty_nodes';
  if (!workflow.connections || typeof workflow.connections !== 'object' || Array.isArray(workflow.connections)) return 'not_a_workflow';
  return null;
}

async function commitFailureReason(repo: string, commit: string, token: string): Promise<string> {
  const url = `${repositoryApiPath(repo)}/commits/${encodeURIComponent(commit)}`;
  const response = await githubGet(url, token);
  if (response.ok) {
    await response.body?.cancel();
    return 'path_absent_at_commit';
  }
  if (response.status === 404) return 'commit_unreachable';
  if (response.status === 403) return 'commit_forbidden';
  if ([301, 302, 307, 308].includes(response.status)) return 'repository_redirected';
  throw new Error(`GitHub commit check failed for ${repo}@${commit}: HTTP ${response.status}`);
}

export async function fetchPinnedWorkflow(source: CatalogueSourceRow, token: string): Promise<PinnedBodyResult> {
  const repoPath = repositoryApiPath(source.repo!);
  const encodedPath = source.path!.split('/').map(encodeURIComponent).join('/');
  const contentsUrl = `${repoPath}/contents/${encodedPath}?ref=${encodeURIComponent(source.commit!)}`;
  const response = await githubGet(contentsUrl, token);
  if (response.status === 404) return { reason: await commitFailureReason(source.repo!, source.commit!, token) };
  if (response.status === 403) return { reason: 'content_forbidden' };
  if ([301, 302, 307, 308].includes(response.status)) return { reason: 'repository_redirected' };
  if (!response.ok) throw new Error(`GitHub content fetch failed for ${source.repo}@${source.commit}:${source.path}: HTTP ${response.status}`);

  const payload = await response.json() as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { reason: 'not_regular_file' };
  const metadata = payload as Record<string, unknown>;
  if (metadata.type !== 'file') return { reason: 'not_regular_file' };
  if (metadata.path !== source.path) return { reason: 'path_mismatch' };
  if (typeof metadata.sha !== 'string' || typeof metadata.size !== 'number') throw new Error(`GitHub returned incomplete file metadata for ${source.repo}:${source.path}`);

  let body: Buffer;
  if (metadata.encoding === 'base64' && typeof metadata.content === 'string') {
    body = Buffer.from(metadata.content.replace(/\s/g, ''), 'base64');
  } else if (metadata.encoding === 'none') {
    const raw = await githubGet(contentsUrl, token, 'application/vnd.github.raw+json', 'follow');
    if (raw.status === 404) return { reason: 'raw_content_not_found' };
    if (raw.status === 403) return { reason: 'content_forbidden' };
    if (!raw.ok) throw new Error(`GitHub raw content fetch failed for ${source.repo}@${source.commit}:${source.path}: HTTP ${raw.status}`);
    body = Buffer.from(await raw.arrayBuffer());
  } else {
    throw new Error(`GitHub returned unsupported content encoding for ${source.repo}:${source.path}`);
  }

  if (body.length !== metadata.size || computeBlobSha(body) !== metadata.sha.toLowerCase()) return { reason: 'blob_mismatch' };
  const reason = workflowReason(body);
  return reason ? { reason } : { body };
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
