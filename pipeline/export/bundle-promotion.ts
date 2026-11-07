import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fsyncDirectoryBestEffort, fsyncFile } from './fsync.js';

function pathExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function uniqueSiblingPath(parentDir: string, prefix: string): string {
  return path.join(parentDir, `${prefix}${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
}

function fsyncTree(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) fsyncTree(full);
    else if (entry.isFile()) fsyncFile(full);
  }
  fsyncDirectoryBestEffort(root);
}

/**
 * File the displaced (previously visible) bundle away as the single
 * preserved "previous" generation. Runs only after the new bundle is
 * already live, so a failure here (e.g. the old `.previous` is locked) does
 * not affect the correctness of the promotion — it just leaves the displaced
 * bundle preserved under its temporary name instead of the canonical one.
 */
function preserveDisplaced(displaced: string, outputDir: string): void {
  const previousDir = `${outputDir}.previous`;
  try {
    if (pathExists(previousDir)) fs.rmSync(previousDir, { recursive: true, force: true });
    fs.renameSync(displaced, previousDir);
  } catch {
    // Non-fatal: the promotion already succeeded.
  }
}

/**
 * Swap the new bundle into `outputDir`. Windows cannot rename a directory
 * onto an existing target path (empty or not), so this never renames
 * directly onto `outputDir` while it exists: the current bundle is first
 * displaced to a fresh sibling path, then the staged bundle takes the
 * now-free `outputDir` path. If that second rename fails (disk full, the
 * staging directory locked, ...), the displaced bundle is renamed straight
 * back so `outputDir` never observes anything but wholly-old or wholly-new
 * content.
 */
function swapIntoPlace(outputDir: string, stagingDir: string, parentDir: string, name: string): void {
  if (!pathExists(outputDir)) {
    fs.renameSync(stagingDir, outputDir);
    fsyncDirectoryBestEffort(parentDir);
    return;
  }
  const displaced = uniqueSiblingPath(parentDir, `.${name}.previous-`);
  fs.renameSync(outputDir, displaced);
  try {
    fs.renameSync(stagingDir, outputDir);
  } catch (error) {
    fs.renameSync(displaced, outputDir);
    throw error;
  }
  fsyncDirectoryBestEffort(parentDir);
  preserveDisplaced(displaced, outputDir);
}

/**
 * Build a complete artifact bundle in a sibling staging directory, then
 * promote it into `outputDir` with a single atomic visibility swap: an
 * observer of `outputDir` only ever sees the wholly-old or the wholly-new
 * bundle, never a mixture. `build` failing at any point leaves `outputDir`
 * completely untouched, and the previous bundle (if any) is preserved at
 * `${outputDir}.previous` rather than destroyed.
 */
export function promoteReleaseBundle<T>(outputDir: string, build: (stagingDir: string) => T): T {
  const parentDir = path.dirname(outputDir);
  const name = path.basename(outputDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const stagingDir = uniqueSiblingPath(parentDir, `.${name}.staging-`);
  fs.mkdirSync(stagingDir);
  try {
    const bundle = build(stagingDir);
    fsyncTree(stagingDir);
    swapIntoPlace(outputDir, stagingDir, parentDir, name);
    return bundle;
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}
