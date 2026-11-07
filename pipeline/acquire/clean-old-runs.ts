import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Delete stale run directories, keeping the most recently touched ones.
 *
 * Two safety rules, both learned the hard way: never delete the run currently
 * executing, and never delete a directory that was modified in the last hour.
 * A concurrent official-library acquisition takes over an hour, and name-sorted
 * deletion happily removed it mid-run, losing 1,900 fetched entries.
 */
export async function cleanOldRuns(
  workBaseDir: string,
  keepCount = 2,
  activeRunId?: string,
): Promise<void> {
  try {
    const entries = await readdir(workBaseDir, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    if (directories.length <= keepCount) return;

    const recentlyTouched = Date.now() - 60 * 60 * 1000;
    const dated: Array<{ name: string; modifiedAt: number }> = [];
    for (const name of directories) {
      const info = await stat(join(workBaseDir, name)).catch(() => null);
      dated.push({ name, modifiedAt: info?.mtimeMs ?? 0 });
    }

    dated.sort((a, b) => b.modifiedAt - a.modifiedAt);
    for (const candidate of dated.slice(keepCount)) {
      if (candidate.name === activeRunId) continue;
      if (candidate.modifiedAt > recentlyTouched) continue;
      await rm(join(workBaseDir, candidate.name), { recursive: true, force: true });
    }
  } catch {
    // A missing work directory simply means there is nothing to clean.
  }
}
