import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseOfficialBodyFileName } from '../official-map/body-map.js';
import { RECEIPT_FILE, emitBodyFiles, parseArgs } from './emit-body-files.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

type Provenance = { url: string; fetchedAt: string; httpStatus: number; reason: 'ok' | 'gone' | 'failed' };

function record(templateId: number, name: string | null, provenance: Provenance, withBody = true): string {
  const workflow = withBody ? { name, nodes: [], connections: {}, settings: {} } : null;
  return JSON.stringify({ templateId, workflow, provenance });
}

function ok(id: number, name: string): string {
  return record(id, name, { url: `https://api.n8n.io/api/templates/workflows/${id}`, fetchedAt: '2026-09-28T00:00:00.000Z', httpStatus: 200, reason: 'ok' });
}

async function store(lines: string[]): Promise<string> {
  const dir = await tempDir('emit-jsonl-');
  const file = path.join(dir, 'official-ids-workflows.jsonl');
  await writeFile(file, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  return file;
}

type Receipt = Record<string, unknown>;

async function receipts(out: string): Promise<Receipt[]> {
  const text = await readFile(path.join(out, RECEIPT_FILE), 'utf8');
  return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line) as Receipt) : [];
}

describe('emitBodyFiles', () => {
  it('writes one body file per ok id and a receipt hashing exactly those bytes', async () => {
    const jsonl = await store([ok(11, 'Eleven Thing'), ok(12, 'Twelve Thing')]);
    const out = await tempDir('emit-out-');

    const summary = await emitBodyFiles({ jsonl, out });

    expect(summary).toMatchObject({ bodies: 2, gone: 0, failed: 0 });
    const files = (await readdir(out)).filter((name) => name.endsWith('.json')).sort();
    expect(files).toEqual(['official__11_eleven-thing.json', 'official__12_twelve-thing.json']);
    for (const name of files) expect(parseOfficialBodyFileName(name)).not.toBeNull();

    const raw = await readFile(path.join(out, 'official__11_eleven-thing.json'));
    const row = (await receipts(out)).find((entry) => entry.templateId === 11) as Receipt;
    expect(row).toMatchObject({
      url: 'https://api.n8n.io/api/templates/workflows/11',
      fetchedAt: '2026-09-28T00:00:00.000Z',
      httpStatus: 200,
      state: 'fetched',
      file: 'official__11_eleven-thing.json',
      bytes: raw.byteLength,
      sha256: createHash('sha256').update(raw).digest('hex'),
    });
    expect(JSON.parse(raw.toString('utf8'))).toMatchObject({ name: 'Eleven Thing' });
  });

  it('records a 404 as gone: a receipt, and no body file at all', async () => {
    const jsonl = await store([
      ok(21, 'Twenty one'),
      record(22, null, { url: 'https://api.n8n.io/api/templates/workflows/22', fetchedAt: '2026-09-28T00:00:00.000Z', httpStatus: 404, reason: 'gone' }, false),
    ]);
    const out = await tempDir('emit-out-');

    const summary = await emitBodyFiles({ jsonl, out });

    expect(summary).toMatchObject({ bodies: 1, gone: 1, failed: 0 });
    const files = await readdir(out);
    expect(files.filter((name) => name.includes('__22_'))).toEqual([]);
    const gone = (await receipts(out)).find((entry) => entry.templateId === 22) as Receipt;
    expect(gone).toMatchObject({ httpStatus: 404, state: 'gone', sha256: null, bytes: null });
  });

  it('records a 400 "Not found" as gone too', async () => {
    const jsonl = await store([
      record(31, null, { url: 'https://api.n8n.io/api/templates/workflows/31', fetchedAt: '2026-09-28T00:00:00.000Z', httpStatus: 400, reason: 'gone' }, false),
    ]);
    const out = await tempDir('emit-out-');

    const summary = await emitBodyFiles({ jsonl, out });

    expect(summary).toMatchObject({ gone: 1, failed: 0, bodies: 0 });
    expect((await receipts(out))[0]).toMatchObject({ httpStatus: 400, state: 'gone' });
  });

  it('records an unreachable id as failed, not as gone, and emits no body', async () => {
    const jsonl = await store([
      record(41, null, { url: 'https://api.n8n.io/api/templates/workflows/41', fetchedAt: '2026-09-28T00:00:00.000Z', httpStatus: 503, reason: 'failed' }, false),
    ]);
    const out = await tempDir('emit-out-');

    const summary = await emitBodyFiles({ jsonl, out });

    expect(summary).toMatchObject({ gone: 0, failed: 1, bodies: 0 });
    expect((await receipts(out))[0]).toMatchObject({ httpStatus: 503, state: 'failed' });
  });

  it('emits a filename with no character a filesystem refuses', async () => {
    const jsonl = await store([ok(51, 'ACME / ops: "sales" <24/7> | *?* — Fritz’s ✓ Ünïcode\tTab')]);
    const out = await tempDir('emit-out-');

    await emitBodyFiles({ jsonl, out });

    const name = (await readdir(out)).find((entry) => entry.startsWith('official__51_')) as string;
    expect(name).toMatch(/^official__51_[a-z0-9-]+\.json$/);
    expect(name).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/);
    expect(parseOfficialBodyFileName(name)).toEqual({ templateId: 51, slug: name.slice('official__51_'.length, -'.json'.length) });
  });

  it('caps the slug so a long title cannot blow past the curated naming ceiling', async () => {
    const jsonl = await store([ok(61, 'long title '.repeat(40))]);
    const out = await tempDir('emit-out-');

    await emitBodyFiles({ jsonl, out });

    const name = (await readdir(out)).find((entry) => entry.startsWith('official__61_')) as string;
    expect(name.length - 'official__61_'.length - '.json'.length).toBeLessThanOrEqual(80);
    expect(parseOfficialBodyFileName(name)?.templateId).toBe(61);
  });

  it('falls back to a slug when the body carries no usable name', async () => {
    const jsonl = await store([ok(71, '' as unknown as string)]);
    const out = await tempDir('emit-out-');

    await emitBodyFiles({ jsonl, out });

    expect(await readdir(out)).toContain('official__71_workflow.json');
  });

  it('lets the later record for an id win, so a resumed run cannot double-emit', async () => {
    const jsonl = await store([ok(81, 'First Name'), ok(81, 'Second Name')]);
    const out = await tempDir('emit-out-');

    const summary = await emitBodyFiles({ jsonl, out });

    expect(summary).toMatchObject({ bodies: 1 });
    expect((await readdir(out)).filter((name) => name.startsWith('official__81_'))).toEqual(['official__81_second-name.json']);
    expect((await receipts(out)).filter((entry) => entry.templateId === 81)).toHaveLength(1);
  });

  it('is byte-identical across repeated runs on the same store', async () => {
    const jsonl = await store([ok(91, 'Deterministic'), ok(92, 'Also')]);
    const first = await tempDir('emit-out-');
    const second = await tempDir('emit-out-');

    await emitBodyFiles({ jsonl, out: first });
    await emitBodyFiles({ jsonl, out: second });

    for (const name of await readdir(first)) {
      expect((await readFile(path.join(second, name))).equals(await readFile(path.join(first, name)))).toBe(true);
    }
  });

  it('creates the output folder when run and writes nothing for an empty store', async () => {
    const jsonl = await store([]);
    const parent = await tempDir('emit-parent-');
    const out = path.join(parent, 'created-by-the-emitter');

    const summary = await emitBodyFiles({ jsonl, out });

    expect(summary).toMatchObject({ bodies: 0, gone: 0, failed: 0 });
    expect(await receipts(out)).toEqual([]);
  });

  it('refuses a store row whose provenance the receipts cannot describe', async () => {
    const jsonl = await store([JSON.stringify({ templateId: 99, workflow: { name: 'x' } })]);
    const out = await tempDir('emit-out-');
    await expect(emitBodyFiles({ jsonl, out })).rejects.toThrow(/provenance/i);
  });
});

describe('parseArgs', () => {
  it('requires an explicit output folder', () => {
    expect(() => parseArgs(['--jsonl', 'in.jsonl'])).toThrow(/--out/);
  });

  it('requires the store to read', () => {
    expect(() => parseArgs(['--out', 'somewhere'])).toThrow(/--jsonl/);
  });

  it('takes both paths as given', () => {
    expect(parseArgs(['--jsonl', 'in.jsonl', '--out', 'somewhere'])).toEqual({ jsonl: 'in.jsonl', out: 'somewhere' });
  });
});
