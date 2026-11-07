import fs from 'node:fs';

/**
 * fsync a regular file by path. Throws if the file cannot be opened or
 * synced. Opened read-write ('r+', not 'r'): Windows rejects fsync on a
 * handle opened read-only with EPERM.
 */
export function fsyncFile(filePath: string): void {
  const descriptor = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * fsync a directory's own entry (durably persists renames/creates/deletes
 * within it) on platforms that support it. Windows does not support fsync on
 * a directory handle, so this is best-effort: the per-file fsync callers also
 * perform is what guarantees file content durability there, and the failure
 * here is swallowed rather than surfaced.
 */
export function fsyncDirectoryBestEffort(directoryPath: string): void {
  try {
    const descriptor = fs.openSync(directoryPath, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    // Unsupported on this platform (e.g. Windows) — nothing more to do.
  }
}
