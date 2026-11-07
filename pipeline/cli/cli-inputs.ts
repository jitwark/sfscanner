import * as nodeFs from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SCANNER_LIMITS } from '@hub/contracts';

export type CliInputErrorCode =
  | 'DIRECTORY_READ_FAILED' | 'FILE_READ_FAILED' | 'INVALID_UTF8' | 'NO_INPUTS'
  | 'NOT_A_FILE' | 'UNSUPPORTED_INPUT' | 'WORKFLOW_TOO_LARGE';
export type CliInputError = { kind: 'input'; code: CliInputErrorCode; message: string };
export type CliSource =
  | { kind: 'file'; input: string; absolutePath: string }
  | { kind: 'stdin'; input: '-' }
  | { kind: 'error'; input: string; error: CliInputError };
export type CliStdin = string | Uint8Array | AsyncIterable<string | Uint8Array>;
export type CliSourceReadResult = { ok: true; text: string } | { ok: false; error: CliInputError };

const MAX_BYTES = DEFAULT_SCANNER_LIMITS.maxBytes;

export async function collectCliSources(
  inputSpecs: readonly string[], cwd: string,
  options: { include?: string[]; exclude?: string[] } = {},
): Promise<CliSource[]> {
  const sources = new Map<string, CliSource>();
  const specs = inputSpecs.length > 0 ? inputSpecs : ['-'];
  for (const spec of specs) {
    if (spec === '-') { sources.set('-', { kind: 'stdin', input: '-' }); continue; }
    if (spec.length === 0) { addError(sources, '(empty)', 'UNSUPPORTED_INPUT', 'Input path must not be empty.'); continue; }
    await collectPath(path.resolve(cwd, spec), cwd, sources, options, path.resolve(cwd, spec));
  }
  return [...sources.values()].sort((left, right) => compareStrings(left.input, right.input));
}

export async function readCliSource(source: CliSource, stdin?: CliStdin): Promise<CliSourceReadResult> {
  if (source.kind === 'error') return { ok: false, error: source.error };
  let bytes: Uint8Array;
  try {
    bytes = source.kind === 'stdin' ? await readStdin(stdin ?? process.stdin as unknown as AsyncIterable<Uint8Array>) : await nodeFs.readFile(source.absolutePath);
  } catch { return readFailure('FILE_READ_FAILED', 'Unable to read input.'); }
  if (bytes.byteLength > MAX_BYTES) return readFailure('WORKFLOW_TOO_LARGE', 'Input exceeds the scanner payload limit.');
  try { return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
  catch { return readFailure('INVALID_UTF8', 'Input is not valid UTF-8.'); }
}

export function normalizeCliPath(absolutePath: string, cwd: string): string {
  const relative = path.relative(cwd, absolutePath);
  const display = relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) ? relative : absolutePath;
  const normalized = display.replaceAll('\\', '/');
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

async function collectPath(
  absolutePath: string, cwd: string, sources: Map<string, CliSource>,
  options: { include?: string[]; exclude?: string[] }, root: string,
): Promise<void> {
  let stat: Stats;
  try { stat = await nodeFs.lstat(absolutePath); }
  catch { addError(sources, normalizeCliPath(absolutePath, cwd), 'FILE_READ_FAILED', 'Unable to read input path.'); return; }
  const display = normalizeCliPath(absolutePath, cwd);
  if (stat.isSymbolicLink()) { addError(sources, display, 'UNSUPPORTED_INPUT', 'Symbolic links are not followed.'); return; }
  if (stat.isFile()) { sources.set(`file:${display}`, { kind: 'file', input: display, absolutePath }); return; }
  if (!stat.isDirectory()) { addError(sources, display, 'NOT_A_FILE', 'Input path is not a regular file.'); return; }

  let entries: Dirent[];
  try { entries = await nodeFs.readdir(absolutePath, { withFileTypes: true }); }
  catch { addError(sources, display, 'DIRECTORY_READ_FAILED', 'Unable to read input directory.'); return; }
  entries.sort((left, right) => compareStrings(left.name.replaceAll('\\', '/'), right.name.replaceAll('\\', '/')));
  const before = sources.size;
  for (const entry of entries) {
    const child = path.join(absolutePath, entry.name);
    if (entry.isDirectory()) await collectPath(child, cwd, sources, options, root);
    else if (entry.isSymbolicLink()) addError(sources, normalizeCliPath(child, cwd), 'UNSUPPORTED_INPUT', 'Symbolic links are not followed.');
    else if (entry.isFile() && matchGlobs(path.relative(root, child), options.include ?? [], options.exclude ?? [])) {
      sources.set(`file:${normalizeCliPath(child, cwd)}`, { kind: 'file', input: normalizeCliPath(child, cwd), absolutePath: child });
    }
  }
  if (sources.size === before) addError(sources, display, 'NO_INPUTS', 'No workflow JSON files matched the directory.');
}

async function readStdin(input: CliStdin): Promise<Uint8Array> {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    total += bytes.byteLength;
    if (total > MAX_BYTES) return new Uint8Array(MAX_BYTES + 1);
    chunks.push(bytes);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function matchGlobs(filePath: string, include: string[], exclude: string[]): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  const includes = include.length > 0 ? include : ['**/*.json'];
  return includes.some((glob) => globToRegExp(glob).test(normalized)) && !exclude.some((glob) => globToRegExp(glob).test(normalized));
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll('\\', '/');
  let source = '';
  for (let index = 0; index < normalized.length;) {
    if (normalized.startsWith('**/', index)) { source += '(?:.*/|^)'; index += 3; continue; }
    const character = normalized[index]!;
    source += character === '*' ? '[^/]*' : character === '?' ? '[^/]' : /[.\+^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
    index += 1;
  }
  return new RegExp(`^${source}$`);
}

function addError(sources: Map<string, CliSource>, input: string, code: CliInputErrorCode, message: string): void {
  sources.set(`error:${input}`, { kind: 'error', input, error: { kind: 'input', code, message } });
}
function readFailure(code: CliInputErrorCode, message: string): CliSourceReadResult { return { ok: false, error: { kind: 'input', code, message } }; }
function compareStrings(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1; }
