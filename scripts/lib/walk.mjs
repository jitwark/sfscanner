import { readdir } from 'node:fs/promises';
import { posix, resolve, sep } from 'node:path';

/**
 * Lists every file beneath `root`, relative to `root`, with forward slashes
 * regardless of platform so callers can match/report paths consistently.
 */
export async function listFilesRecursively(root, relativeDir = '') {
  const entries = await readdir(resolve(root, relativeDir), { withFileTypes: true });
  const found = [];

  for (const entry of entries) {
    const relativePath = relativeDir === '' ? entry.name : posix.join(relativeDir, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await listFilesRecursively(root, relativePath)));
    } else if (entry.isFile()) {
      found.push(relativePath.split(sep).join('/'));
    }
  }

  return found;
}
