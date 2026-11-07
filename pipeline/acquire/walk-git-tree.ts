/**
 * Enumerate workflow files straight out of a git object database.
 *
 * A working-tree walk cannot read several real sources on Windows: aggregator
 * repositories name files after the full workflow title, which blows past the
 * 260-character path limit, and `git clone` then fails the checkout even though
 * the objects downloaded fine. `core.longpaths=true` is not enough when the OS
 * policy is off.
 *
 * Reading blobs from the object database sidesteps the filesystem completely.
 * It is also faster: no working tree is materialised, and `git cat-file --batch`
 * streams every blob over one pipe instead of paying an open/read/close per file.
 */
import { spawn } from 'node:child_process';
import type { Candidate, Reject } from '@hub/contracts';
import { LIMITS } from '@hub/contracts';
import { matchGlobs, processWorkflowBuffer, type WalkRepoOptions, type WalkRepoResult } from './walk-repo.js';

type TreeEntry = { sha: string; size: number; path: string };

function gitText(args: string[], cwd: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn('git', args, { cwd, shell: false });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) resolve(stdout);
    else reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`));
  });
  return promise;
}

/** `<mode> blob <sha> <size>\t<path>` — size is right-aligned and space padded. */
export function parseTreeListing(listing: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const line of listing.split('\n')) {
    if (line.length === 0) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const fields = line.slice(0, tab).trim().split(/\s+/);
    const [, type, sha, size] = fields;
    if (type !== 'blob' || !sha) continue;
    entries.push({ sha, size: Number(size) || 0, path: line.slice(tab + 1) });
  }
  return entries;
}

/**
 * Stream blobs through one `git cat-file --batch` process.
 *
 * The protocol is `<sha> <type> <size>\n<payload>\n` per request, so the reader
 * is a small state machine over a growing buffer rather than a line splitter:
 * payloads are arbitrary bytes and may contain newlines.
 */
async function readBlobs(
  cloneDir: string,
  entries: TreeEntry[],
  onBlob: (entry: TreeEntry, buffer: Buffer) => void,
): Promise<void> {
  if (entries.length === 0) return;

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn('git', ['cat-file', '--batch'], { cwd: cloneDir, shell: false });
  let pending: Buffer = Buffer.alloc(0);
  let index = 0;
  let failure: Error | undefined;

  child.stdout.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);

    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) return;

      const header = pending.subarray(0, newline).toString('utf8');
      const parts = header.split(' ');
      if (parts.length < 3) {
        failure = new Error(`unexpected cat-file header: ${header}`);
        child.kill();
        return;
      }

      const payloadLength = Number(parts[2]);
      const total = newline + 1 + payloadLength + 1;
      if (pending.length < total) return;

      const entry = entries[index++];
      if (entry) onBlob(entry, pending.subarray(newline + 1, newline + 1 + payloadLength));
      pending = pending.subarray(total);
      if (index >= entries.length) {
        child.stdin.end();
        return;
      }
    }
  });

  child.on('error', reject);
  child.on('close', () => (failure ? reject(failure) : resolve()));
  child.stdin.write(`${entries.map((entry) => entry.sha).join('\n')}\n`);
  await promise;
}

export async function walkGitTree(cloneDir: string, opts: WalkRepoOptions): Promise<WalkRepoResult> {
  const candidates: Candidate[] = [];
  const rejects: Reject[] = [];

  const listing = await gitText(['ls-tree', '-r', '-l', 'HEAD'], cloneDir);
  const wanted: TreeEntry[] = [];

  for (const entry of parseTreeListing(listing)) {
    if (!entry.path.endsWith('.json')) continue;
    // Dot-directories are tooling artifacts and never hold publishable workflows.
    if (entry.path.split('/').some((segment) => segment.startsWith('.'))) continue;
    if (!matchGlobs(entry.path, opts.include, opts.exclude)) continue;
    if (entry.size > LIMITS.maxWorkflowBytes) {
      rejects.push({
        sourceKey: opts.sourceKey,
        path: entry.path,
        reason: 'too_large',
        detail: `${entry.size} bytes`,
      });
      continue;
    }
    wanted.push(entry);
  }

  await readBlobs(cloneDir, wanted, (entry, buffer) => {
    const result = processWorkflowBuffer({
      sourceKey: opts.sourceKey,
      repo: opts.repo,
      ownerLogin: opts.ownerLogin,
      stars: opts.stars,
      commitSha: opts.commitSha,
      committedAt: opts.committedAt,
      relPath: entry.path,
      buffer,
      fetchedAt: opts.fetchedAt,
      spdxId: opts.spdxId,
      licenceUrl: opts.licenceUrl,
    });

    if (result.type === 'candidate') {
      // The git blob sha is authoritative and already computed; no need to hash again.
      result.candidate.blobSha = entry.sha;
      candidates.push(result.candidate);
    } else {
      rejects.push(result.reject);
    }
  });

  return { candidates, rejects };
}
