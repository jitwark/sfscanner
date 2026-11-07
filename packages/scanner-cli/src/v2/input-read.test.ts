import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInputBytes, DEFAULT_MAX_INPUT_BYTES, type InputReadHost } from './input-read';
import type { SelectedInputV2 } from './input-selection';

describe('readInputBytes with mock host (pure)', () => {
  const makeMockHost = (files: Record<string, Uint8Array>): InputReadHost => ({
    readFile: async (p: string) => {
      const data = files[p.replaceAll('\\', '/')];
      if (!data) throw new Error(`ENOENT: ${p}`);
      return data;
    },
  });

  it('reads bytes within bounds and enforces N accepted, N+1 rejected', async () => {
    const host = makeMockHost({ 'exact.json': new Uint8Array(50), 'over.json': new Uint8Array(51) });
    const exact = await readInputBytes({ label: 'exact.json', realPath: 'exact.json', isStdin: false }, { host, maxBytes: 50 });
    expect(exact.ok).toBe(true);

    const over = await readInputBytes({ label: 'over.json', realPath: 'over.json', isStdin: false }, { host, maxBytes: 50 });
    expect(over).toEqual({ ok: false, code: 'WORKFLOW_TOO_LARGE', message: 'Workflow exceeds maximum byte limit.', label: 'over.json' });
  });

  it('rejects invalid maxBytes (NaN, negative, non-integer) before reading', async () => {
    for (const badMax of [NaN, -1, 1.5, Infinity]) {
      const res = await readInputBytes('file.json', { maxBytes: badMax });
      expect(res).toEqual({ ok: false, code: 'INVALID_CONFIG', message: 'Byte limit is invalid.', label: 'file.json' });
    }
  });

  it('preserves malformed UTF-8 bytes for downstream parser', async () => {
    const malformed = Uint8Array.of(0xff, 0xfe, 0xc0, 0xaf);
    const host = makeMockHost({ 'malformed.json': malformed });
    const res = await readInputBytes({ label: 'malformed.json', realPath: 'malformed.json', isStdin: false }, { host });
    expect(res.ok && res.bytes).toEqual(malformed);
  });

  it('returns INPUT_READ_FAILED on missing file without leaking paths', async () => {
    const host = makeMockHost({});
    const res = await readInputBytes({ label: 'missing.json', realPath: '/secret/missing.json', isStdin: false }, { host });
    expect(res).toEqual({ ok: false, code: 'INPUT_READ_FAILED', message: 'Failed to read input.', label: 'missing.json' });
  });

  it('reads stdin from string, Uint8Array, and async iterable stream', async () => {
    const strRes = await readInputBytes('-', { stdin: '{"stdin":true}' });
    expect(strRes.ok && new TextDecoder().decode(strRes.bytes)).toBe('{"stdin":true}');

    const raw = new TextEncoder().encode('{"stdin":123}');
    const rawRes = await readInputBytes('-', { stdin: raw });
    expect(rawRes.ok && rawRes.bytes).toEqual(raw);

    async function* makeChunks() { yield new TextEncoder().encode('{"chunk":'); yield new TextEncoder().encode('1}'); }
    const chunkRes = await readInputBytes('-', { stdin: makeChunks() });
    expect(chunkRes.ok && new TextDecoder().decode(chunkRes.bytes)).toBe('{"chunk":1}');
  });

  it('enforces byte bounds on stdin string without leaking content', async () => {
    const res = await readInputBytes('-', { stdin: 'SECRET_TOKEN_'.repeat(10), maxBytes: 20 });
    expect(res).toEqual({ ok: false, code: 'WORKFLOW_TOO_LARGE', message: 'Workflow exceeds maximum byte limit.', label: '-' });
  });

  it('enforces byte bounds on stdin chunked stream and aborts early', async () => {
    let chunks = 0;
    async function* infinite() { while (true) { chunks += 1; yield new TextEncoder().encode('1234567890'); } }
    const res = await readInputBytes('-', { stdin: infinite(), maxBytes: 25 });
    expect(res.ok).toBe(false);
    expect(chunks).toBeLessThanOrEqual(5);
  });

  it('rejects remote, UNC, drive, absolute, and traversal path strings and labels', async () => {
    const badPaths = ['https://x.com/f.json', 'C:/f.json', '\\\\srv\\sh\\f.json', '//srv/sh/f.json', '/etc/passwd', '../escape.json', 'f\0.json'];
    for (const bad of badPaths) {
      const resStr = await readInputBytes(bad);
      expect(resStr.ok).toBe(false);
      const resObj = await readInputBytes({ label: bad, realPath: bad, isStdin: false });
      expect(resObj.ok).toBe(false);
    }
  });

  it('validates exact runtime SelectedInput shape and returns neutral error label', async () => {
    const badShapes = [
      null, undefined, 42, true, [], {},
      { label: 'test.json' },
      { isStdin: false },
      { label: 'test.json', isStdin: false, extra: 'bad' },
      { label: 'test.json', isStdin: true, realPath: '/mock' },
      { label: 'test.json', isStdin: true },
      { label: 'test.json', isStdin: false, realPath: 123 },
    ];
    for (const bad of badShapes) {
      const res = await readInputBytes(bad as unknown as SelectedInputV2);
      expect(res).toEqual({ ok: false, code: 'INVALID_CONFIG', message: 'Input configuration is invalid.', label: 'input' });
    }
  });

  it('validates canonical realPath rejecting schemes, unnormalized traversal, and UNC', async () => {
    const badReals = ['file:target.json', 'http://target.json', 'C:rel.json', '//srv/sh/target.json', '\\\\srv\\sh\\target.json', '../outside.json', 'dir/./sub.json'];
    for (const bad of badReals) {
      const res = await readInputBytes({ label: 'valid.json', realPath: bad, isStdin: false });
      expect(res).toEqual({ ok: false, code: 'INVALID_CONFIG', message: 'Input path is not admitted.', label: 'input' });
    }
  });

  it('exports DEFAULT_MAX_INPUT_BYTES matching 1,536,000', () => {
    expect(DEFAULT_MAX_INPUT_BYTES).toBe(1_536_000);
  });
});

describe('readInputBytes with real filesystem host', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), 'wc0803-read-')); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('reads real file from disk using default host via SelectedInput and relative path', async () => {
    const filePath = join(tempDir, 'sample.json');
    await writeFile(filePath, '{"hello":"world"}');

    const res1 = await readInputBytes({ label: 'sample.json', realPath: filePath, isStdin: false });
    expect(res1.ok && new TextDecoder().decode(res1.bytes)).toBe('{"hello":"world"}');

    const res2 = await readInputBytes('sample.json', { baseDirectory: tempDir });
    expect(res2.ok && new TextDecoder().decode(res2.bytes)).toBe('{"hello":"world"}');
  });

  it('bounds real file reads when file exceeds limit', async () => {
    const filePath = join(tempDir, 'oversized.json');
    await writeFile(filePath, 'x'.repeat(100));

    const res = await readInputBytes({ label: 'oversized.json', realPath: filePath, isStdin: false }, { maxBytes: 50 });
    expect(res).toEqual({ ok: false, code: 'WORKFLOW_TOO_LARGE', message: 'Workflow exceeds maximum byte limit.', label: 'oversized.json' });
  });
});
