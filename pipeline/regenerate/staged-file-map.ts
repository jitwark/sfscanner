/**
 * File maps for staging: sorted path+SHA-256 maps, their comparison, and the source pin that proves
 * the code which produced a run did not move under it.
 *
 * The comparison is content-only by construction — size and digest, never mtime — so a touched but
 * unchanged file cannot excuse a dataset difference, and a one-byte change cannot hide behind a
 * stable manifest. The source pin exists because a declared engine-identity tuple is not a content
 * hash of the engine: an edit to a capability between the two runs changes their bytes while the
 * identity stays identical, which is exactly what happened on the first real pair this packet ran.
 */
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { collectStagedFiles, manifestDigest, type StagedFile } from './staged-bytes-sweep.js';

export type FileMapComparison = Readonly<{ files: number; bytes: number; identical: boolean; differences: readonly string[] }>;

/** Sorted full path+SHA-256 maps, compared as maps: a missing, extra or differing file is named. */
export function compareFileMaps(left: readonly StagedFile[], right: readonly StagedFile[]): FileMapComparison {
  const leftOf = new Map(left.map((file) => [file.path, file]));
  const rightOf = new Map(right.map((file) => [file.path, file]));
  const paths = [...new Set([...leftOf.keys(), ...rightOf.keys()])].sort(compareCanonicalStrings);
  const differences: string[] = [];
  let bytes = 0;
  for (const filePath of paths) {
    const a = leftOf.get(filePath);
    const b = rightOf.get(filePath);
    bytes += a?.bytes ?? b?.bytes ?? 0;
    if (a === undefined) differences.push(`only-in-right ${filePath}`);
    else if (b === undefined) differences.push(`only-in-left ${filePath}`);
    else if (a.sha256 !== b.sha256 || a.bytes !== b.bytes) differences.push(`content-differs ${filePath}`);
  }
  return { files: paths.length, bytes, identical: differences.length === 0, differences: Object.freeze(differences) };
}

export type SourcePin = Readonly<{ roots: readonly string[]; fileCount: number; totalBytes: number; manifestDigest: string }>;

/** One digest over the roots that decide a run's output bytes, root-qualified so two trees cannot collide. */
export function pinSourceTrees(roots: readonly string[]): SourcePin {
  const files: StagedFile[] = [];
  for (const root of roots) {
    for (const file of collectStagedFiles(root)) files.push({ ...file, path: `${root.replace(/\\/g, '/')}/${file.path}` });
  }
  let totalBytes = 0;
  for (const file of files) totalBytes += file.bytes;
  return { roots: Object.freeze([...roots]), fileCount: files.length, totalBytes, manifestDigest: manifestDigest(files) };
}
