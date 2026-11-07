import { readdir, stat, lstat, realpath } from 'node:fs/promises';
import { admittedLabelV2, isAdmittedLocalPath, isAdmittedRelativePath, normalizeAdmittedPathV2, toFsPathV2 } from './path-admission.js';

export type HostEntry = Readonly<{ name: string; isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean }>;
export type InputSelectionHost = Readonly<{ readdir: (path: string) => Promise<readonly HostEntry[]>; stat: (path: string) => Promise<Pick<HostEntry, 'isDirectory' | 'isFile' | 'isSymbolicLink'>>; lstat: (path: string) => Promise<Pick<HostEntry, 'isDirectory' | 'isFile' | 'isSymbolicLink'>>; realpath: (path: string) => Promise<string>; }>;
export const defaultInputSelectionHost: InputSelectionHost = Object.freeze({ readdir: async (p) => (await readdir(p, { withFileTypes: true })) as unknown as readonly HostEntry[], stat: async (p) => stat(p), lstat: async (p) => lstat(p), realpath: async (p) => realpath(p) });

export type CollectInputsOptions = Readonly<{ inputs: readonly string[]; include?: readonly string[]; exclude?: readonly string[]; baseDirectory?: string; outputPath?: string; host?: InputSelectionHost; signal?: AbortSignal }>;
export type SelectedInputV2 = Readonly<{ label: string; realPath?: string; isStdin: boolean }>;
export type CollectInputsResult = Readonly<{ ok: true; inputs: readonly SelectedInputV2[] }> | Readonly<{ ok: false; code: 'INVALID_CONFIG' | 'INPUT_READ_FAILED' | 'CANCELLED'; message: string }>;

const fail = <C extends 'INVALID_CONFIG' | 'INPUT_READ_FAILED' | 'CANCELLED'>(code: C, message: string): Readonly<{ ok: false; code: C; message: string }> => Object.freeze({ ok: false, code, message });

function sameIdentity(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const aObj = a as Record<string, unknown>, bObj = b as Record<string, unknown>;
  return (!('ino' in aObj && 'ino' in bObj) || aObj.ino === bObj.ino) && (!('dev' in aObj && 'dev' in bObj) || aObj.dev === bObj.dev);
}

export async function collectInputs(options: CollectInputsOptions): Promise<CollectInputsResult> {
  const host = options.host ?? defaultInputSelectionHost, baseDir = (options.baseDirectory ?? '.').replaceAll('\\', '/'), inputs = options.inputs ?? [], signal = options.signal;
  if (signal?.aborted) return fail('CANCELLED', 'Scan was cancelled.');
  if (options.outputPath !== undefined) {
    if (options.outputPath === '') return fail('INVALID_CONFIG', 'Output path is not admitted.');
    if (options.outputPath !== '-') { const c = validatePath(options.outputPath, 'output'); if (!c.ok) return c; }
  }
  if (inputs.length === 0) return fail('INVALID_CONFIG', 'At least one workflow input is required.');
  if (inputs.includes('-')) return inputs.length > 1 ? fail('INVALID_CONFIG', 'Standard input cannot be combined with file inputs.') : Object.freeze({ ok: true, inputs: Object.freeze([{ label: '-', isStdin: true }]) });

  const inc = (options.include !== undefined ? options.include : ['**/*.json']).map(compilePosixGlob);
  const exc = (options.exclude !== undefined ? options.exclude : ['.git/**', 'node_modules/**']).map(compilePosixGlob);
  const collected: Array<{ label: string; realPath: string }> = [], budget = { entries: 0, files: 0 };

  for (const raw of inputs) {
    if (signal?.aborted) return fail('CANCELLED', 'Scan was cancelled.');
    if (++budget.entries > 100_000) return fail('INPUT_READ_FAILED', 'Directory entry limit exceeded.');
    const check = validatePath(raw, 'input');
    if (!check.ok) return check;
    const norm = check.normalized, fsPath = toFsPathV2(baseDir, norm), label = admittedLabelV2(norm, baseDir);

    let lst: Pick<HostEntry, 'isDirectory' | 'isFile' | 'isSymbolicLink'>;
    try { lst = await host.lstat(fsPath); } catch { return fail('INPUT_READ_FAILED', 'Input path does not exist or cannot be accessed.'); }

    if (lst.isSymbolicLink()) {
      let tgt: Pick<HostEntry, 'isDirectory' | 'isFile' | 'isSymbolicLink'>;
      try { tgt = await host.stat(fsPath); } catch { return fail('INPUT_READ_FAILED', 'Direct symlink could not be resolved.'); }
      if (tgt.isDirectory() || !tgt.isFile()) return fail('INVALID_CONFIG', 'Direct symlink must resolve to a regular file.');
      try { const r = await host.lstat(fsPath); if (!r.isSymbolicLink() || !sameIdentity(lst, r)) return fail('INPUT_READ_FAILED', 'File modified during scan.'); } catch { return fail('INPUT_READ_FAILED', 'Input path does not exist or cannot be accessed.'); }
      let real: string;
      try { real = (await host.realpath(fsPath)).replaceAll('\\', '/'); } catch { return fail('INPUT_READ_FAILED', 'Failed to resolve input path.'); }
      try { const t2 = await host.stat(fsPath); if (!t2.isFile() || t2.isDirectory() || !sameIdentity(tgt, t2)) return fail('INPUT_READ_FAILED', 'File modified during scan.'); } catch { return fail('INPUT_READ_FAILED', 'File modified during scan.'); }
      if (inc.some((re) => re.test(label)) && !exc.some((re) => re.test(label))) {
        if (++budget.files > 10_000) return fail('INPUT_READ_FAILED', 'File limit exceeded.');
        collected.push({ label, realPath: real });
      }
      continue;
    }
    if (lst.isFile()) {
      try { const r = await host.lstat(fsPath); if (r.isSymbolicLink() || !r.isFile() || !sameIdentity(lst, r)) return fail('INPUT_READ_FAILED', 'File modified during scan.'); } catch { return fail('INPUT_READ_FAILED', 'Input path does not exist or cannot be accessed.'); }
      let real: string;
      try { real = (await host.realpath(fsPath)).replaceAll('\\', '/'); } catch { return fail('INPUT_READ_FAILED', 'Failed to resolve input path.'); }
      try { const r2 = await host.lstat(fsPath); if (r2.isSymbolicLink() || !r2.isFile() || !sameIdentity(lst, r2)) return fail('INPUT_READ_FAILED', 'File modified during scan.'); } catch { return fail('INPUT_READ_FAILED', 'Failed to read directory.'); }
      if (inc.some((re) => re.test(label)) && !exc.some((re) => re.test(label))) {
        if (++budget.files > 10_000) return fail('INPUT_READ_FAILED', 'File limit exceeded.');
        collected.push({ label, realPath: real });
      }
      continue;
    }
    if (lst.isDirectory()) {
      const walk = await walkDir(fsPath, label, host, inc, exc, 0, budget, signal);
      if (!walk.ok) return walk;
      collected.push(...walk.files);
      continue;
    }
    return fail('INVALID_CONFIG', 'Input must be a regular file or directory.');
  }

  const byPath = new Map<string, { label: string; realPath: string }>();
  for (const item of collected) {
    const prev = byPath.get(item.realPath);
    if (!prev || item.label < prev.label) byPath.set(item.realPath, item);
  }
  const sorted = Array.from(byPath.values()).sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  if (signal?.aborted) return fail('CANCELLED', 'Scan was cancelled.');
  const result = sorted.map((item) => Object.freeze({ label: item.label, realPath: item.realPath, isStdin: false }));
  if (result.length === 0) return fail('INVALID_CONFIG', 'No matching workflow inputs found.');

  if (options.outputPath && options.outputPath !== '-') {
    const checkOut = validatePath(options.outputPath, 'output');
    if (!checkOut.ok) return checkOut;
    const collision = await detectOutputCollision(options.outputPath, result, host, baseDir, signal);
    if (signal?.aborted) return fail('CANCELLED', 'Scan was cancelled.');
    if (collision) return fail('INVALID_CONFIG', 'Output path collides with an input file.');
  }
  return Object.freeze({ ok: true, inputs: Object.freeze(result) });
}

export async function detectOutputCollision(outputPath: string, inputs: readonly SelectedInputV2[], host: InputSelectionHost = defaultInputSelectionHost, baseDir = '.', signal?: AbortSignal): Promise<boolean> {
  if (!outputPath || outputPath === '-' || signal?.aborted) return false;
  const check = validatePath(outputPath, 'output');
  if (!check.ok) return false;
  let outReal: string | undefined;
  try { outReal = (await host.realpath(toFsPathV2(baseDir, check.normalized))).replaceAll('\\', '/'); } catch { /* ignore absent */ }
  if (signal?.aborted) return false;
  return inputs.some((item) => (outReal && item.realPath && outReal === item.realPath) || item.label === check.normalized);
}

async function walkDir(
  dirFsPath: string, dirLabel: string, host: InputSelectionHost, inc: readonly RegExp[], exc: readonly RegExp[], depth: number, budget: { entries: number; files: number }, signal?: AbortSignal,
): Promise<{ ok: true; files: Array<{ label: string; realPath: string }> } | { ok: false; code: 'INPUT_READ_FAILED' | 'CANCELLED'; message: string }> {
  if (signal?.aborted) return fail('CANCELLED', 'Scan was cancelled.');
  if (depth > 64) return fail('INPUT_READ_FAILED', 'Directory recursion limit exceeded.');
  let chk: Pick<HostEntry, 'isDirectory' | 'isFile' | 'isSymbolicLink'>;
  try { chk = await host.lstat(dirFsPath); } catch { return fail('INPUT_READ_FAILED', 'Failed to read directory.'); }
  if (chk.isSymbolicLink() || !chk.isDirectory()) return fail('INPUT_READ_FAILED', 'Directory structure modified during scan.');

  let entries: readonly HostEntry[];
  try { entries = await host.readdir(dirFsPath); } catch { return fail('INPUT_READ_FAILED', 'Failed to read directory.'); }
  if (entries.length > 50_000 || budget.entries + entries.length > 100_000) return fail('INPUT_READ_FAILED', 'Directory entry limit exceeded.');

  let afterReaddir: Pick<HostEntry, 'isDirectory' | 'isFile' | 'isSymbolicLink'>;
  try { afterReaddir = await host.lstat(dirFsPath); } catch { return fail('INPUT_READ_FAILED', 'Failed to read directory.'); }
  if (afterReaddir.isSymbolicLink() || !afterReaddir.isDirectory() || !sameIdentity(chk, afterReaddir)) return fail('INPUT_READ_FAILED', 'Directory structure modified during scan.');

  const files: Array<{ label: string; realPath: string }> = [];
  if (signal?.aborted) return fail('CANCELLED', 'Scan was cancelled.');
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of sorted) {
    if (++budget.entries > 100_000) return fail('INPUT_READ_FAILED', 'Directory entry limit exceeded.');
    if (/[\/\\\u0000-\u001f\u007f]/.test(entry.name) || entry.name === '.' || entry.name === '..') continue;
    const childFs = toFsPathV2(dirFsPath, entry.name), childLabel = dirLabel === '.' || dirLabel === '' ? entry.name : `${dirLabel}/${entry.name}`;
    if (childLabel.length > 4096) return fail('INPUT_READ_FAILED', 'Input label exceeds maximum length.');

    if (entry.isSymbolicLink()) {
      let tgt: Pick<HostEntry, 'isDirectory' | 'isFile' | 'isSymbolicLink'>;
      try { tgt = await host.stat(childFs); } catch { continue; }
      if (tgt.isDirectory()) continue;
      if (tgt.isFile() && inc.some((re) => re.test(childLabel)) && !exc.some((re) => re.test(childLabel))) {
        if (++budget.files > 10_000) return fail('INPUT_READ_FAILED', 'File limit exceeded.');
        try { const r = await host.lstat(childFs); if (!r.isSymbolicLink() || !sameIdentity(entry, r)) return fail('INPUT_READ_FAILED', 'File modified during scan.'); } catch { continue; }
        let real: string;
        try { real = (await host.realpath(childFs)).replaceAll('\\', '/'); } catch { return fail('INPUT_READ_FAILED', 'Failed to resolve input path.'); }
        try { const t2 = await host.stat(childFs); if (!t2.isFile() || t2.isDirectory() || !sameIdentity(tgt, t2)) return fail('INPUT_READ_FAILED', 'File modified during scan.'); } catch { continue; }
        files.push({ label: childLabel, realPath: real });
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (exc.some((re) => re.test(`${childLabel}/`) || re.test(childLabel))) continue;
      let checkLst: Pick<HostEntry, 'isDirectory' | 'isFile' | 'isSymbolicLink'>;
      try { checkLst = await host.lstat(childFs); } catch { return fail('INPUT_READ_FAILED', 'Failed to read directory.'); }
      if (checkLst.isSymbolicLink() || !checkLst.isDirectory() || !sameIdentity(entry, checkLst)) return fail('INPUT_READ_FAILED', 'Directory structure modified during scan.');
      const sub = await walkDir(childFs, childLabel, host, inc, exc, depth + 1, budget, signal);
      if (!sub.ok) return sub;
      files.push(...sub.files);
      continue;
    }
    if (entry.isFile() && inc.some((re) => re.test(childLabel)) && !exc.some((re) => re.test(childLabel))) {
      if (++budget.files > 10_000) return fail('INPUT_READ_FAILED', 'File limit exceeded.');
      try { const r = await host.lstat(childFs); if (r.isSymbolicLink() || !r.isFile() || !sameIdentity(entry, r)) return fail('INPUT_READ_FAILED', 'File modified during scan.'); } catch { return fail('INPUT_READ_FAILED', 'Failed to read directory.'); }
      let real: string;
      try { real = (await host.realpath(childFs)).replaceAll('\\', '/'); } catch { return fail('INPUT_READ_FAILED', 'Failed to resolve input path.'); }
      try { const r2 = await host.lstat(childFs); if (r2.isSymbolicLink() || !r2.isFile() || !sameIdentity(entry, r2)) return fail('INPUT_READ_FAILED', 'File modified during scan.'); } catch { return fail('INPUT_READ_FAILED', 'Failed to read directory.'); }
      files.push({ label: childLabel, realPath: real });
    }
  }
  return { ok: true, files };
}

function validatePath(raw: string, kind: 'input' | 'output' = 'input'): { ok: true; normalized: string } | { ok: false; code: 'INVALID_CONFIG'; message: string } {
  const message = kind === 'output' ? 'Output path is not admitted.' : 'Input path is not admitted.';
  const admitted = kind === 'output' ? isAdmittedRelativePath(raw) : isAdmittedLocalPath(raw);
  if (!admitted) return fail('INVALID_CONFIG', message);
  const normalized = normalizeAdmittedPathV2(raw, kind === 'output');
  if (normalized === undefined) return fail('INVALID_CONFIG', message);
  return { ok: true, normalized };
}

export function compilePosixGlob(pattern: string): RegExp {
  let s = '^', i = 0; const p = pattern.replaceAll('\\', '/');
  while (i < p.length) {
    if (p.startsWith('**/', i)) { s += '(?:.+/)?'; i += 3; }
    else if (p.startsWith('/**', i)) { s += '(?:/.*)?'; i += 3; }
    else if (p.startsWith('**', i)) { s += '.*'; i += 2; }
    else if (p[i] === '*') { s += '[^/]*'; i += 1; }
    else if (p[i] === '?') { s += '[^/]'; i += 1; }
    else if (p[i] === '[') {
      const close = p.indexOf(']', i + 1);
      if (close > i) { const inside = p.slice(i + 1, close); s += `[${inside.startsWith('!') ? '^' + inside.slice(1) : inside}]`; i = close + 1; }
      else { s += '\\['; i += 1; }
    } else { s += '()+{}.^$|\\'.includes(p[i]!) ? '\\' + p[i] : p[i]; i += 1; }
  }
  try { return new RegExp(`${s}$`); } catch { return /$^/; }
}
