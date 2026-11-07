import { createHash } from 'node:crypto';

/**
 * The pinned-source cache is keyed by the whole source identity, not just the entry id: a file from
 * an older repository commit must never be reused as the current one. The digest covers repo,
 * commit and path, so any of the three changing selects a different cache entry.
 */
export function hydrationCacheFileName(entryId: string, repo: string, commit: string, sourcePath: string): string {
  const identity = createHash('sha256').update(`${repo}\0${commit}\0${sourcePath}`, 'utf8').digest('hex').slice(0, 16);
  return `${entryId}.${identity}.json`;
}
