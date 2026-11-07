import { lstat, realpath } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { isAbsoluteAdmittedPathV2, isWithinBaseV2, normalizeAdmittedPathV2 } from './path-admission';

/**
 * Read-only admission for a fix target and its backup. It answers one question — may this regular
 * file, under this explicit root, be the subject of a conditional replacement? — using injected
 * filesystem facts so the decision is testable without touching a disk. It never opens, creates,
 * renames or removes anything, and its host surface has no way to do so.
 *
 * Admission is a preflight, not a lock. A separate conditional-replace host must still bind the
 * target identity and digests through the commit; a string `realpath` alone cannot stop a
 * concurrent swap after admission.
 */

export type FixPathStatV1 = Readonly<{
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  nlink?: number;
  dev?: number | bigint;
  ino?: number | bigint;
  /** A reported Windows reparse tag; a junction often reports as a symbolic link already. */
  reparseTag?: number | bigint;
}>;

export type FixPathAdmissionHostV1 = Readonly<{
  lstat: (path: string) => Promise<FixPathStatV1>;
  realpath: (path: string) => Promise<string>;
}>;

export type FixPathDetailV1 =
  | 'FORM' | 'DEVICE' | 'ADS' | 'UNRESOLVABLE' | 'NON_REGULAR' | 'SYMLINK' | 'REPARSE'
  | 'ESCAPE' | 'COLLISION' | 'CROSS_VOLUME' | 'BACKUP' | 'HARDLINK' | 'IDENTITY';

export type FixPathAdmissionResultV1 =
  | Readonly<{
    ok: true;
    rootRealPath: string;
    targetRealPath: string;
    targetDirectory: string;
    targetIdentity: string;
    identityBasis: 'DEVICE_INODE' | 'RESOLVED_PATH';
  }>
  | Readonly<{ ok: false; reason: 'UNSAFE_PATH'; detail: FixPathDetailV1 }>;

export type FixPathAdmissionInputV1 = Readonly<{
  root: string;
  target: string;
  backup?: string;
  host?: FixPathAdmissionHostV1;
}>;

export const defaultFixPathAdmissionHost: FixPathAdmissionHostV1 = Object.freeze({
  lstat: async (path: string) => lstat(path),
  realpath: async (path: string) => realpath(path),
});

const DRIVE = /^([a-z]):\//iu;
// Windows resolves these names to devices regardless of extension, so `CON.json` is not a file.
const DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/iu;

type AdmittedPathV1 = Readonly<{ normalized: string; drive: string | undefined; segments: readonly string[] }>;
type PathDecisionV1 = Readonly<{ ok: true; path: AdmittedPathV1 }> | Readonly<{ ok: false; detail: FixPathDetailV1 }>;
type WalkedPathV1 = Readonly<{ stat: FixPathStatV1; realPath: string }>;
type WalkDecisionV1 = Readonly<{ ok: true; value: WalkedPathV1 }> | Readonly<{ ok: false; detail: FixPathDetailV1 }>;

export async function admitFixTarget(input: FixPathAdmissionInputV1): Promise<FixPathAdmissionResultV1> {
  if (input === null || typeof input !== 'object') return unsafe('FORM');
  const root = classifyPath(input.root, true);
  if (!root.ok) return unsafe(root.detail);
  const target = classifyPath(input.target, false);
  if (!target.ok) return unsafe(target.detail);
  const backup = input.backup === undefined ? undefined : classifyPath(input.backup, false);
  if (backup !== undefined && !backup.ok) return unsafe(backup.detail);

  if (target.path.normalized === root.path.normalized
    || !isWithinBaseV2(target.path.normalized, root.path.normalized)) return unsafe('ESCAPE');
  if (backup?.ok) {
    const refusal = backupRefusal(target.path, backup.path);
    if (refusal !== undefined) return unsafe(refusal);
    if (!isWithinBaseV2(backup.path.normalized, root.path.normalized)) return unsafe('ESCAPE');
  }

  const host = input.host ?? defaultFixPathAdmissionHost;
  const rootWalk = await walkPath(root.path, 'DIRECTORY', host);
  if (!rootWalk.ok) return unsafe(rootWalk.detail);
  const targetWalk = await walkPath(target.path, 'FILE', host);
  if (!targetWalk.ok) return unsafe(targetWalk.detail);
  if (!isWithinBaseV2(targetWalk.value.realPath, rootWalk.value.realPath)) return unsafe('ESCAPE');

  if (backup?.ok) {
    const collision = await absentBackup(backup.path.normalized, host);
    if (collision !== undefined) return unsafe(collision);
  }

  if (targetWalk.value.stat.nlink !== undefined && targetWalk.value.stat.nlink !== 1) return unsafe('HARDLINK');
  const identity = resolveIdentity(targetWalk.value.stat, targetWalk.value.realPath);
  if (!identity.ok) return unsafe('IDENTITY');
  return Object.freeze({
    ok: true as const,
    rootRealPath: rootWalk.value.realPath,
    targetRealPath: targetWalk.value.realPath,
    targetDirectory: parentOf(targetWalk.value.realPath),
    targetIdentity: identity.identity,
    identityBasis: identity.basis,
  });
}

function unsafe(detail: FixPathDetailV1): FixPathAdmissionResultV1 {
  return Object.freeze({ ok: false as const, reason: 'UNSAFE_PATH' as const, detail });
}

function classifyPath(raw: unknown, allowRoot: boolean): PathDecisionV1 {
  const normalized = normalizeAdmittedPathV2(raw);
  if (normalized === undefined || !isAbsoluteAdmittedPathV2(normalized)) return { ok: false, detail: 'FORM' };
  const drive = DRIVE.exec(normalized)?.[1]?.toUpperCase();
  const rest = drive === undefined ? normalized.slice(1) : normalized.slice(3);
  const segments = rest.split('/').filter((segment) => segment.length > 0);
  if (!allowRoot && segments.length === 0) return { ok: false, detail: 'FORM' };
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return { ok: false, detail: 'FORM' };
    if (segment.includes(':')) return { ok: false, detail: 'ADS' };
    // Windows drops trailing dots and spaces, so the same file would have two spellings.
    if (/[. ]$/u.test(segment)) return { ok: false, detail: 'FORM' };
    if (DEVICE_NAME.test(segment)) return { ok: false, detail: 'DEVICE' };
  }
  return { ok: true, path: { normalized, drive, segments } };
}

function backupRefusal(target: AdmittedPathV1, backup: AdmittedPathV1): FixPathDetailV1 | undefined {
  const fold = (value: string): string => (target.drive === undefined ? value : value.toLowerCase());
  if (fold(backup.drive ?? '') !== fold(target.drive ?? '')) return 'CROSS_VOLUME';
  if (fold(parentOf(backup.normalized)) !== fold(parentOf(target.normalized))) return 'BACKUP';
  return fold(backup.normalized) === fold(target.normalized) ? 'COLLISION' : undefined;
}

function parentOf(path: string): string {
  return (DRIVE.test(path) ? win32 : posix).dirname(path);
}

async function walkPath(
  admitted: AdmittedPathV1,
  kind: 'FILE' | 'DIRECTORY',
  host: FixPathAdmissionHostV1,
): Promise<WalkDecisionV1> {
  const base = admitted.drive === undefined ? '/' : `${admitted.drive}:/`;
  const chain: string[] = [];
  let current = base;
  for (const segment of admitted.segments) {
    current = current.endsWith('/') ? `${current}${segment}` : `${current}/${segment}`;
    chain.push(current);
  }
  if (chain.length === 0) chain.push(base);

  let stat: FixPathStatV1 | undefined;
  for (const [index, candidate] of chain.entries()) {
    let observed: FixPathStatV1;
    try { observed = await host.lstat(candidate); } catch { return { ok: false, detail: 'UNRESOLVABLE' }; }
    if (observed.isSymbolicLink()) return { ok: false, detail: 'SYMLINK' };
    if (isReparse(observed)) return { ok: false, detail: 'REPARSE' };
    if (index < chain.length - 1 && !observed.isDirectory()) return { ok: false, detail: 'NON_REGULAR' };
    stat = observed;
  }
  const finalPath = chain[chain.length - 1] ?? base;
  if (stat === undefined || (kind === 'FILE' ? !stat.isFile() : !stat.isDirectory())) {
    return { ok: false, detail: 'NON_REGULAR' };
  }
  let resolved: string;
  try { resolved = await host.realpath(finalPath); } catch { return { ok: false, detail: 'UNRESOLVABLE' }; }
  const normalized = normalizeAdmittedPathV2(resolved);
  if (normalized === undefined || !isAbsoluteAdmittedPathV2(normalized)) {
    return { ok: false, detail: 'UNRESOLVABLE' };
  }
  return { ok: true, value: { stat, realPath: normalized } };
}

function isReparse(stat: FixPathStatV1): boolean {
  if (stat.reparseTag === undefined) return false;
  try { return BigInt(stat.reparseTag) !== 0n; } catch { return true; }
}

async function absentBackup(path: string, host: FixPathAdmissionHostV1): Promise<FixPathDetailV1 | undefined> {
  try {
    await host.lstat(path);
    return 'COLLISION';
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return code === 'ENOENT' ? undefined : 'UNRESOLVABLE';
  }
}

function resolveIdentity(
  stat: FixPathStatV1,
  realPath: string,
): Readonly<{ ok: true; identity: string; basis: 'DEVICE_INODE' | 'RESOLVED_PATH' }> | Readonly<{ ok: false }> {
  if (stat.dev === undefined && stat.ino === undefined) {
    return { ok: true, identity: `path:${realPath}`, basis: 'RESOLVED_PATH' };
  }
  const dev = stat.dev === undefined ? undefined : toCount(stat.dev);
  const ino = stat.ino === undefined ? undefined : toCount(stat.ino);
  // A half-reported or zero inode is not a stable identity; refuse rather than guess.
  if (dev === undefined || ino === undefined || ino === 0n) return { ok: false };
  return { ok: true, identity: `inode:${dev}:${ino}`, basis: 'DEVICE_INODE' };
}

function toCount(value: number | bigint): bigint | undefined {
  if (typeof value === 'bigint') return value >= 0n ? value : undefined;
  return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
}
