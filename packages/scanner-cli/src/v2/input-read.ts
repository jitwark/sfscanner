import { open } from 'node:fs/promises';
import type { SelectedInputV2 } from './input-selection';
import { toFsPathV2 } from './path-admission.js';

export const DEFAULT_MAX_INPUT_BYTES = 1_536_000;
export type CliStdin = string | Uint8Array | AsyncIterable<Uint8Array | string>;
export type InputReadHost = Readonly<{ readFile: (path: string, maxBytes?: number) => Promise<Uint8Array> }>;

export const defaultInputReadHost: InputReadHost = Object.freeze({
  readFile: async (p: string, maxBytes = DEFAULT_MAX_INPUT_BYTES) => {
    let handle;
    try {
      handle = await open(p, 'r');
      const st = await handle.stat();
      if (!st.isFile()) throw new Error('NOT_REGULAR_FILE');
      if (st.size > maxBytes) throw new RangeError('OVERSIZED');
      const alloc = st.size > 0 ? Math.min(st.size, maxBytes + 1) : Math.min(65536, maxBytes + 1);
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total <= maxBytes) {
        const buf = new Uint8Array(alloc);
        const { bytesRead } = await handle.read(buf, 0, alloc, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) throw new RangeError('OVERSIZED');
        chunks.push(buf.subarray(0, bytesRead));
      }
      if (chunks.length === 1) return chunks[0]!;
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
      return out;
    } finally {
      if (handle) await handle.close();
    }
  },
});

export type ReadInputOptions = Readonly<{ stdin?: CliStdin; maxBytes?: number; baseDirectory?: string; host?: InputReadHost }>;
export type ReadInputSuccess = Readonly<{ ok: true; bytes: Uint8Array; label: string }>;
export type ReadInputFailure = Readonly<{ ok: false; code: 'WORKFLOW_TOO_LARGE' | 'INPUT_READ_FAILED' | 'INVALID_CONFIG'; message: string; label: string }>;
export type ReadInputResult = ReadInputSuccess | ReadInputFailure;

function isValidSelectedInput(input: unknown): input is SelectedInputV2 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const obj = input as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k !== 'label' && k !== 'isStdin' && k !== 'realPath') return false;
  }
  if (typeof obj.label !== 'string' || typeof obj.isStdin !== 'boolean') return false;
  if (obj.isStdin) {
    if (obj.label !== '-' || obj.realPath !== undefined) return false;
  } else if (obj.realPath !== undefined && typeof obj.realPath !== 'string') {
    return false;
  }
  return true;
}

export async function readInputBytes(input: SelectedInputV2 | string, options: ReadInputOptions = {}): Promise<ReadInputResult> {
  const isString = typeof input === 'string';
  if (!isString && !isValidSelectedInput(input)) {
    return Object.freeze({ ok: false, code: 'INVALID_CONFIG', message: 'Input configuration is invalid.', label: 'input' });
  }
  const isStdin = isString ? input === '-' : input.isStdin;
  const safeLabel = isString ? (input === '-' ? '-' : sanitizeLabel(input)) : sanitizeLabel(input.label);
  const rawMax = options.maxBytes ?? DEFAULT_MAX_INPUT_BYTES;
  if (typeof rawMax !== 'number' || !Number.isSafeInteger(rawMax) || rawMax < 0) {
    return Object.freeze({ ok: false, code: 'INVALID_CONFIG', message: 'Byte limit is invalid.', label: safeLabel });
  }
  const maxBytes = rawMax;
  if (isStdin) return readStdinBytes(options.stdin ?? process.stdin, maxBytes);

  const baseDir = (options.baseDirectory ?? '.').replaceAll('\\', '/');
  let targetFsPath: string;

  if (isString) {
    const valid = validateReadPath(input);
    if (!valid.ok) return Object.freeze({ ok: false, code: 'INVALID_CONFIG', message: 'Input path is not admitted.', label: 'input' });
    targetFsPath = toFsPathV2(baseDir, valid.normalized);
  } else {
    const validLabel = validateReadPath(input.label);
    if (!validLabel.ok) return Object.freeze({ ok: false, code: 'INVALID_CONFIG', message: 'Input path is not admitted.', label: 'input' });
    if (input.realPath !== undefined) {
      const validReal = validateRealPath(input.realPath);
      if (!validReal.ok) return Object.freeze({ ok: false, code: 'INVALID_CONFIG', message: 'Input path is not admitted.', label: 'input' });
    }
    // A validated `realPath` is the selected file identity; the label is display data.
    targetFsPath = typeof input.realPath === 'string' ? input.realPath : toFsPathV2(baseDir, validLabel.normalized);
  }

  const host = options.host ?? defaultInputReadHost;
  let rawBytes: Uint8Array;
  try {
    rawBytes = await host.readFile(targetFsPath, maxBytes);
  } catch (err: unknown) {
    if (err instanceof RangeError && err.message === 'OVERSIZED') {
      return Object.freeze({ ok: false, code: 'WORKFLOW_TOO_LARGE', message: 'Workflow exceeds maximum byte limit.', label: safeLabel });
    }
    return Object.freeze({ ok: false, code: 'INPUT_READ_FAILED', message: 'Failed to read input.', label: safeLabel });
  }

  if (rawBytes.byteLength > maxBytes) {
    return Object.freeze({ ok: false, code: 'WORKFLOW_TOO_LARGE', message: 'Workflow exceeds maximum byte limit.', label: safeLabel });
  }

  const bytes = new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  return Object.freeze({ ok: true, bytes, label: safeLabel });
}

async function readStdinBytes(stdin: CliStdin, maxBytes: number): Promise<ReadInputResult> {
  if (stdin instanceof Uint8Array) {
    if (stdin.byteLength > maxBytes) return Object.freeze({ ok: false, code: 'WORKFLOW_TOO_LARGE', message: 'Workflow exceeds maximum byte limit.', label: '-' });
    return Object.freeze({ ok: true, bytes: new Uint8Array(stdin.buffer, stdin.byteOffset, stdin.byteLength), label: '-' });
  }

  if (typeof stdin === 'string') {
    const encoded = new TextEncoder().encode(stdin);
    if (encoded.byteLength > maxBytes) return Object.freeze({ ok: false, code: 'WORKFLOW_TOO_LARGE', message: 'Workflow exceeds maximum byte limit.', label: '-' });
    return Object.freeze({ ok: true, bytes: encoded, label: '-' });
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const encoder = new TextEncoder();
  try {
    for await (const chunk of stdin) {
      const b = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
      total += b.byteLength;
      if (total > maxBytes) return Object.freeze({ ok: false, code: 'WORKFLOW_TOO_LARGE', message: 'Workflow exceeds maximum byte limit.', label: '-' });
      chunks.push(b);
    }
  } catch {
    return Object.freeze({ ok: false, code: 'INPUT_READ_FAILED', message: 'Failed to read input.', label: '-' });
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return Object.freeze({ ok: true, bytes: combined, label: '-' });
}

function sanitizeLabel(raw: string): string {
  const norm = raw.replaceAll('\\', '/').replace(/[\u0000-\u001f\u007f]/g, '');
  const parts: string[] = [];
  for (const p of norm.split('/')) {
    if (!p || p === '.') continue;
    parts.push(p);
  }
  return parts.length === 0 ? '.' : parts.join('/').slice(0, 4096);
}

function validateReadPath(raw: string): { ok: true; normalized: string } | { ok: false } {
  if (!raw || raw.length === 0 || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) return { ok: false };
  const norm = raw.replaceAll('\\', '/');
  if (/^(?:[a-z][a-z\d+.-]*:|\/|[a-z]:|\\\\)/i.test(norm) || norm.startsWith('//')) return { ok: false };
  const parts: string[] = [];
  for (const p of norm.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') {
      if (parts.length === 0) return { ok: false };
      parts.pop();
      continue;
    }
    parts.push(p);
  }
  return { ok: true, normalized: parts.length === 0 ? '.' : parts.join('/') };
}

function validateRealPath(raw: string): { ok: true; normalized: string } | { ok: false } {
  if (!raw || raw.length === 0 || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) return { ok: false };
  const norm = raw.replaceAll('\\', '/');
  if (norm.startsWith('//') || norm.startsWith('\\\\')) return { ok: false };
  if (/^[a-z][a-z\d+.-]*:/i.test(norm) && !/^[a-z]:\//i.test(norm)) return { ok: false };
  const parts = norm.split('/');
  for (const p of parts) {
    if (p === '..' || p === '.') return { ok: false };
  }
  return { ok: true, normalized: norm };
}
