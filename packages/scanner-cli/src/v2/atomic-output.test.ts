import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomicBytesV2, writeAtomicUtf8V2, type AtomicOutputHostV2 } from './atomic-output';

const directories: string[] = [];
let directory = '';
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'wc0807-')); directories.push(directory); });
afterEach(async () => { await Promise.all(directories.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

const target = (name = 'output.json') => join('reports', name);
const setup = async (name = 'output.json') => { await mkdir(join(directory, 'reports'), { recursive: true }); return target(name); };

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

describe('atomic output v2', () => {
  it('rejects an output ancestor that resolves outside the base without touching it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'wc0807-out-'));
    directories.push(outside);
    await symlink(outside, join(directory, 'reports'), linkType);
    await writeFile(join(outside, 'output.json'), 'prior');
    expect(await writeAtomicUtf8V2(target(), 'new', { baseDirectory: directory }))
      .toEqual({ ok: false, code: 'INVALID_CONFIG', message: 'Output path is not admitted.' });
    expect(await readFile(join(outside, 'output.json'), 'utf8')).toBe('prior');
    expect((await readdir(outside)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect((await writeAtomicUtf8V2(target('fresh.json'), 'new', { baseDirectory: directory })).ok).toBe(false);
    expect(await readdir(outside)).toEqual(['output.json']);
    await mkdir(join(directory, 'a'));
    await symlink(outside, join(directory, 'a', 'b'), linkType);
    expect((await writeAtomicUtf8V2(join('a', 'b', 'nested.json'), 'new', { baseDirectory: directory })).ok).toBe(false);
    expect(await readdir(outside)).toEqual(['output.json']);
  });

  it('allows a symlinked base and an in-base ancestor link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wc0807-link-'));
    directories.push(root);
    const realBase = join(root, 'real-base');
    const baseLink = join(root, 'base');
    await mkdir(realBase);
    await mkdir(join(realBase, 'real'));
    await symlink(realBase, baseLink, linkType);
    await symlink(join(realBase, 'real'), join(realBase, 'link'), linkType);
    expect(await writeAtomicUtf8V2(join('link', 'out.json'), '{}\n', { baseDirectory: baseLink })).toMatchObject({ ok: true });
    expect(await readFile(join(realBase, 'real', 'out.json'), 'utf8')).toBe('{}\n');
  });

  it('replaces a prior file with UTF-8 and byte content without partial output', async () => {
    const output = await setup();
    await writeFile(join(directory, 'reports', 'output.json'), 'prior', 'utf8');
    expect(await writeAtomicUtf8V2(output, 'héllo ✓', { baseDirectory: directory })).toMatchObject({ ok: true });
    expect(await readFile(join(directory, 'reports', 'output.json'), 'utf8')).toBe('héllo ✓');
    expect(await writeAtomicBytesV2(output, new Uint8Array([0, 255, 1]), { baseDirectory: directory })).toMatchObject({ ok: true });
    expect([...await readFile(join(directory, 'reports', 'output.json'))]).toEqual([0, 255, 1]);
    expect((await readdir(join(directory, 'reports'))).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('preserves prior output on write, rename, and interruption failures', async () => {
    const output = await setup();
    const file = join(directory, 'reports', 'output.json');
    await writeFile(file, 'prior', 'utf8');
    const failWrite: AtomicOutputHostV2 = { write: async () => { throw new Error('private write failure'); } };
    expect(await writeAtomicUtf8V2(output, 'next', { baseDirectory: directory, host: failWrite })).toMatchObject({ ok: false, code: 'OUTPUT_WRITE_FAILED' });
    expect(await readFile(file, 'utf8')).toBe('prior');
    const failRename: AtomicOutputHostV2 = { rename: async () => { throw new Error('private rename failure'); } };
    expect(await writeAtomicUtf8V2(output, 'next', { baseDirectory: directory, host: failRename })).toMatchObject({ ok: false, code: 'OUTPUT_WRITE_FAILED' });
    expect(await readFile(file, 'utf8')).toBe('prior');
    const controller = new AbortController();
    controller.abort();
    expect(await writeAtomicUtf8V2(output, 'next', { baseDirectory: directory, signal: controller.signal })).toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(await readFile(file, 'utf8')).toBe('prior');
    expect(JSON.stringify(await writeAtomicUtf8V2(output, 'next', { baseDirectory: directory, host: failWrite }))).not.toContain('private');
  });

  it('rejects input collisions, resolved symlink collisions, directories, and unsafe targets before writing', async () => {
    const output = await setup();
    const input = join(directory, 'input.json');
    await writeFile(input, 'input', 'utf8');
    expect(await writeAtomicUtf8V2('input.json', 'new', { baseDirectory: directory, inputPaths: ['input.json'] })).toMatchObject({ ok: false, code: 'INVALID_CONFIG' });
    const link = join(directory, 'reports', 'alias.json');
    try {
      await symlink(input, link);
      expect(await writeAtomicUtf8V2('reports/alias.json', 'new', { baseDirectory: directory, inputPaths: ['input.json'] })).toMatchObject({ ok: false, code: 'INVALID_CONFIG' });
    } catch { /* symlink creation can be unavailable on Windows */ }
    expect(await writeAtomicUtf8V2('reports', 'new', { baseDirectory: directory })).toMatchObject({ ok: false, code: 'INVALID_CONFIG' });
    for (const unsafe of ['', '../escape.json', '/absolute.json', 'C:/absolute.json', 'file:output.json']) {
      expect(await writeAtomicUtf8V2(unsafe, 'new', { baseDirectory: directory })).toMatchObject({ ok: false, code: 'INVALID_CONFIG' });
    }
    expect(await readFile(input, 'utf8')).toBe('input');
    expect(await readdir(join(directory, 'reports'))).not.toContain('.output.json.tmp-0');
  });

  it('uses bounded deterministic exclusive temporary names and cleans only its own file', async () => {
    const output = await setup();
    await writeFile(join(directory, 'reports', '.output.json.tmp-0'), 'occupied');
    const result = await writeAtomicUtf8V2(output, 'new', { baseDirectory: directory, maxTempAttempts: 2 });
    expect(result).toMatchObject({ ok: true });
    expect(await readFile(join(directory, 'reports', 'output.json'), 'utf8')).toBe('new');
    expect(await readFile(join(directory, 'reports', '.output.json.tmp-0'), 'utf8')).toBe('occupied');
  });

  it('supports deterministic injected write failure without leaving a partial target', async () => {
    const output = await setup();
    const write = vi.fn(async (_path: string, bytes: Uint8Array) => { expect(bytes).toEqual(new TextEncoder().encode('payload')); throw new Error('write failed'); });
    const result = await writeAtomicUtf8V2(output, 'payload', { baseDirectory: directory, host: { write } });
    expect(result.ok).toBe(false);
    expect(await readdir(join(directory, 'reports'))).not.toContain('output.json');
  });
});
