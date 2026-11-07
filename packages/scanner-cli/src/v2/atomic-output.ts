import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export type AtomicOutputFailureCodeV2 = 'INVALID_CONFIG' | 'SERIALIZATION_FAILED' | 'OUTPUT_WRITE_FAILED' | 'CANCELLED';
export type AtomicOutputResultV2 = Readonly<{ ok: true } | { ok: false; code: AtomicOutputFailureCodeV2; message: string }>;
export type AtomicOutputHandleV2 = Readonly<{ write: (bytes: Uint8Array) => Promise<void>; sync: () => Promise<void>; close: () => Promise<void> }>;
export type AtomicOutputStatV2 = Pick<Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink'>;
export type AtomicOutputHostV2 = Readonly<{
  lstat?: (path: string) => Promise<AtomicOutputStatV2>;
  realpath?: (path: string) => Promise<string>;
  open?: (path: string) => Promise<AtomicOutputHandleV2>;
  write?: (path: string, bytes: Uint8Array) => Promise<void>;
  sync?: (path: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
}>;
export type AtomicOutputOptionsV2 = Readonly<{ baseDirectory?: string; inputPaths?: readonly string[]; signal?: AbortSignal; maxTempAttempts?: number; host?: AtomicOutputHostV2 }>;

const INVALID = 'Output path is not admitted.';
const COLLISION = 'Output path collides with an input file.';
const WRITE_FAILED = 'Output could not be written.';
const CANCELLED = 'Output was cancelled.';
const DEFAULT_ATTEMPTS = 8;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ABSOLUTE = /^(?:[a-z][a-z\d+.-]*:|\/|[a-z]:|\\\\)/i;

export async function writeAtomicUtf8V2(target: string, text: string, options: AtomicOutputOptionsV2 = {}): Promise<AtomicOutputResultV2> {
  if (typeof text !== 'string' || /[\ud800-\udfff]/.test(text) && !/^(?:[\u0000-\ud7ff\ue000-\uffff]|[\ud800-\udbff][\udc00-\udfff])*$/.test(text)) return fail('SERIALIZATION_FAILED', WRITE_FAILED);
  return writeAtomicOutputV2(target, new TextEncoder().encode(text), options);
}

export async function writeAtomicBytesV2(target: string, bytes: Uint8Array, options: AtomicOutputOptionsV2 = {}): Promise<AtomicOutputResultV2> {
  return bytes instanceof Uint8Array ? writeAtomicOutputV2(target, bytes, options) : fail('SERIALIZATION_FAILED', WRITE_FAILED);
}

export async function writeAtomicOutputV2(target: string, content: string | Uint8Array, options: AtomicOutputOptionsV2 = {}): Promise<AtomicOutputResultV2> {
  if (options === null || typeof options !== 'object') return fail('INVALID_CONFIG', INVALID);
  const normalized = normalizeTarget(target);
  const bytes = typeof content === 'string' ? encodeText(content) : content instanceof Uint8Array ? new Uint8Array(content) : undefined;
  const attempts = options.maxTempAttempts ?? DEFAULT_ATTEMPTS;
  if (!normalized || !bytes || !validOptions(options, attempts)) return fail(!bytes ? 'SERIALIZATION_FAILED' : 'INVALID_CONFIG', !bytes ? WRITE_FAILED : INVALID);
  const baseDirectory = resolve(options.baseDirectory ?? '.');
  const output = resolve(baseDirectory, normalized);
  const host = options.host ?? {};
  const fsLstat = host.lstat ?? (async (path: string) => lstat(path));
  const fsRealpath = host.realpath ?? (async (path: string) => realpath(path));
  const fsRename = host.rename ?? (async (from: string, to: string) => rename(from, to));
  const fsUnlink = host.unlink ?? (async (path: string) => unlink(path));
  try {
    const parent = dirname(output);
    // The destination is contained by the resolved base, not by lexical spelling: an ancestor
    // link that resolves outside the base is refused before any temp file or rename happens.
    const realBase = await fsRealpath(baseDirectory).catch(() => undefined);
    const realParent = await fsRealpath(parent).catch(() => undefined);
    if (!realBase || !realParent || !withinResolvedRoot(realBase, realParent)) return fail('INVALID_CONFIG', INVALID);
    const parentStat = await fsLstat(realParent).catch(() => undefined);
    if (!parentStat?.isDirectory()) return fail('INVALID_CONFIG', INVALID);
    const safeOutput = join(realParent, basename(output));
    const inputIds = await inputIdentities(options.inputPaths ?? [], baseDirectory, fsLstat, fsRealpath);
    if (!inputIds) return fail('INVALID_CONFIG', INVALID);
    const existing = await existingTarget(safeOutput, fsLstat, fsRealpath);
    if (existing?.kind === 'directory' || existing?.kind === 'special') return fail('INVALID_CONFIG', INVALID);
    if (existing?.realPath && inputIds.has(identity(existing.realPath))) return fail('INVALID_CONFIG', COLLISION);
    if (inputIds.has(identity(safeOutput))) return fail('INVALID_CONFIG', COLLISION);
    if (existing?.kind === 'symlink') return fail('INVALID_CONFIG', INVALID);
    if (options.signal?.aborted) return fail('CANCELLED', CANCELLED);

    let handle: AtomicOutputHandleV2 | undefined;
    let temporary: string | undefined;
    for (let index = 0; index < attempts; index += 1) {
      const candidate = join(realParent, `.${basename(output)}.tmp-${index}`);
      try { handle = await openExclusive(candidate, host); temporary = candidate; break; }
      catch (error) { if (errorCode(error) !== 'EEXIST') return fail('OUTPUT_WRITE_FAILED', WRITE_FAILED); }
    }
    if (!handle || !temporary) return fail('OUTPUT_WRITE_FAILED', WRITE_FAILED);
    try {
      if (options.signal?.aborted) return fail('CANCELLED', CANCELLED);
      if (host.write) await host.write(temporary, bytes); else await handle.write(bytes);
      if (options.signal?.aborted) return fail('CANCELLED', CANCELLED);
      if (host.sync) await host.sync(temporary); else await handle.sync();
      await handle.close(); handle = undefined;
      if (options.signal?.aborted) return fail('CANCELLED', CANCELLED);
      await fsRename(temporary, safeOutput);
      temporary = undefined;
      return Object.freeze({ ok: true as const });
    } catch (error) {
      return errorCode(error) === 'ABORT_ERR' || options.signal?.aborted ? fail('CANCELLED', CANCELLED) : fail('OUTPUT_WRITE_FAILED', WRITE_FAILED);
    } finally {
      try { if (handle) await handle.close(); } catch { /* cleanup remains best effort */ }
      if (temporary) try { await fsUnlink(temporary); } catch { /* preserve the original failure */ }
    }
  } catch { return fail('OUTPUT_WRITE_FAILED', WRITE_FAILED); }
}

async function openExclusive(path: string, host: AtomicOutputHostV2): Promise<AtomicOutputHandleV2> {
  if (host.open) return host.open(path);
  const file = await open(path, 'wx');
  return fileHandle(file);
}
function fileHandle(file: FileHandle): AtomicOutputHandleV2 { return { write: async (bytes) => { await file.writeFile(bytes); }, sync: async () => { await file.sync(); }, close: async () => { await file.close(); } }; }
function stripVerbatim(pathValue: string): string {
  if (pathValue.startsWith('\\\\?\\UNC\\')) return `\\\\${pathValue.slice(8)}`;
  return pathValue.startsWith('\\\\?\\') ? pathValue.slice(4) : pathValue;
}
function withinResolvedRoot(root: string, candidate: string): boolean {
  const remainder = relative(stripVerbatim(root), stripVerbatim(candidate));
  return remainder === '' || (!isAbsolute(remainder) && remainder !== '..'
    && !remainder.startsWith(`..${sep}`) && !remainder.startsWith('../'));
}
async function directoryChainIsSafe(
  directory: string,
  check: (path: string) => Promise<AtomicOutputStatV2>,
  resolvePath: (path: string) => Promise<string>,
): Promise<boolean> {
  const pathRoot = parse(directory).root;
  let current = pathRoot;
  for (const part of relative(pathRoot, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = await check(current);
      if (stat.isSymbolicLink()) {
        const target = await check(await resolvePath(current));
        if (!target.isDirectory()) return false;
      } else if (!stat.isDirectory()) return false;
    } catch { return false; }
  }
  return true;
}
async function inputIdentities(inputs: readonly string[], base: string, check: (path: string) => Promise<AtomicOutputStatV2>, resolvePath: (path: string) => Promise<string>): Promise<Set<string> | undefined> {
  const result = new Set<string>();
  if (!Array.isArray(inputs)) return undefined;
  for (const raw of inputs) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096 || CONTROL.test(raw)) return undefined;
    const path = resolveInputPath(raw, base);
    if (!path || !(await directoryChainIsSafe(dirname(path), check, resolvePath))) return undefined;
    try {
      const stat = await check(path);
      if (!stat.isFile() && !stat.isSymbolicLink()) return undefined;
      const resolved = await resolvePath(path);
      const targetStat = await check(resolved);
      if (!targetStat.isFile()) return undefined;
      result.add(identity(resolved));
    } catch { return undefined; }
  }
  return result;
}
async function existingTarget(path: string, check: (path: string) => Promise<AtomicOutputStatV2>, resolvePath: (path: string) => Promise<string>): Promise<{ kind: 'directory' | 'special' | 'symlink' | 'file'; realPath?: string } | undefined> {
  try {
    const stat = await check(path);
    if (stat.isDirectory()) return { kind: 'directory' };
    if (stat.isSymbolicLink()) {
      try { return { kind: 'symlink', realPath: await resolvePath(path) }; } catch { return { kind: 'symlink' }; }
    }
    if (!stat.isFile()) return { kind: 'special' };
    return { kind: 'file', realPath: await resolvePath(path) };
  } catch (error) { return errorCode(error) === 'ENOENT' ? undefined : { kind: 'special' }; }
}
function normalizeTarget(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096 || CONTROL.test(raw)) return undefined;
  const normalized = raw.replaceAll('\\', '/'); if (ABSOLUTE.test(normalized)) return undefined;
  const parts: string[] = []; for (const part of normalized.split('/')) { if (!part || part === '.') continue; if (part === '..') { if (!parts.length) return undefined; parts.pop(); } else parts.push(part); }
  return parts.length ? parts.join('/') : undefined;
}
function encodeText(value: string): Uint8Array | undefined { try { if (/[\ud800-\udfff]/.test(value) && !/^(?:[\u0000-\ud7ff\ue000-\uffff]|[\ud800-\udbff][\udc00-\udfff])*$/.test(value)) return undefined; return new TextEncoder().encode(value); } catch { return undefined; } }
function validOptions(options: AtomicOutputOptionsV2, attempts: number): boolean { return options !== null && typeof options === 'object' && Number.isSafeInteger(attempts) && attempts > 0 && attempts <= 64 && (options.baseDirectory === undefined || typeof options.baseDirectory === 'string' && options.baseDirectory.length > 0 && !CONTROL.test(options.baseDirectory)) && (options.inputPaths === undefined || Array.isArray(options.inputPaths)); }
function resolveInputPath(raw: string, base: string): string | undefined {
  const normalized = raw.replaceAll('\\', '/');
  if (ABSOLUTE.test(normalized)) return /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(raw) ? resolve(raw) : undefined;
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return undefined; parts.pop(); } else parts.push(part);
  }
  return parts.length ? resolve(base, parts.join('/')) : undefined;
}
function identity(value: string): string { const normalized = value.replaceAll('\\', '/'); return process.platform === 'win32' ? normalized.toLowerCase() : normalized; }
function errorCode(error: unknown): string | undefined { return error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined; }
function fail(code: AtomicOutputFailureCodeV2, message: string): AtomicOutputResultV2 { return Object.freeze({ ok: false as const, code, message }); }
