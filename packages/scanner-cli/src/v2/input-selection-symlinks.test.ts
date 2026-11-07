import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectInputs, type InputSelectionHost, type HostEntry } from './input-selection';

function makeMockHost(fs: Record<string, { type: 'file' | 'dir' | 'symlink'; target?: string }>): InputSelectionHost {
  const normFs: Record<string, { type: 'file' | 'dir' | 'symlink'; target?: string }> = {};
  for (const [k, v] of Object.entries(fs)) normFs[k.replaceAll('\\', '/')] = v;
  const isImplicit = (norm: string) => norm === '.' || norm === '' || Object.keys(normFs).some((k) => k.startsWith(`${norm}/`));

  return {
    readdir: async (p: string) => {
      const norm = p.replaceAll('\\', '/').replace(/\/+$/, '');
      const entries: HostEntry[] = [];
      const prefix = norm === '.' || norm === '' ? '' : `${norm}/`;
      const seen = new Set<string>();
      for (const key of Object.keys(normFs)) {
        if (prefix === '' ? true : key.startsWith(prefix)) {
          const rest = prefix === '' ? key : key.slice(prefix.length);
          const slash = rest.indexOf('/');
          const name = slash === -1 ? rest : rest.slice(0, slash);
          if (name && !seen.has(name)) {
            seen.add(name);
            const isDir = slash !== -1 || normFs[prefix ? `${prefix}${name}` : name]?.type === 'dir';
            const item = normFs[prefix ? `${prefix}${name}` : name];
            entries.push({ name, isDirectory: () => isDir, isFile: () => !isDir && item?.type === 'file', isSymbolicLink: () => item?.type === 'symlink' });
          }
        }
      }
      return entries;
    },
    lstat: async (p: string) => {
      const norm = p.replaceAll('\\', '/').replace(/\/+$/, '');
      if (isImplicit(norm) && !normFs[norm]) return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
      const item = normFs[norm];
      if (!item) throw new Error(`ENOENT: ${p}`);
      return { isDirectory: () => item.type === 'dir', isFile: () => item.type === 'file', isSymbolicLink: () => item.type === 'symlink' };
    },
    stat: async (p: string) => {
      let norm = p.replaceAll('\\', '/').replace(/\/+$/, '');
      if (isImplicit(norm) && !normFs[norm]) return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
      let item = normFs[norm];
      if (!item) throw new Error(`ENOENT: ${p}`);
      while (item?.type === 'symlink') { norm = item.target!; item = normFs[norm]; if (!item) throw new Error(`ENOENT target: ${norm}`); }
      return { isDirectory: () => item.type === 'dir', isFile: () => item.type === 'file', isSymbolicLink: () => false };
    },
    realpath: async (p: string) => {
      let norm = p.replaceAll('\\', '/').replace(/\/+$/, '');
      let item = normFs[norm];
      if (!item && !isImplicit(norm)) throw new Error(`ENOENT: ${p}`);
      while (item?.type === 'symlink') { norm = item.target!; item = normFs[norm]; }
      return `/mock-root/${norm}`;
    },
  };
}

describe('collectInputs symlinks, TOCTOU, and deduplication', () => {
  it('refuses directory symlinks during recursive walk', async () => {
    const host = makeMockHost({
      'workflows': { type: 'dir' },
      'workflows/a.json': { type: 'file' },
      'workflows/symdir': { type: 'symlink', target: 'otherdir' },
      'otherdir': { type: 'dir' },
      'otherdir/b.json': { type: 'file' },
    });

    const res = await collectInputs({ inputs: ['workflows'], host });
    expect(res.ok && res.inputs.map((i) => i.label)).toEqual(['workflows/a.json']);
  });

  it('refuses direct directory symlinks with explicit error', async () => {
    const host = makeMockHost({ 'link-to-dir': { type: 'symlink', target: 'realdir' }, 'realdir': { type: 'dir' }, 'realdir/a.json': { type: 'file' } });
    const res = await collectInputs({ inputs: ['link-to-dir'], host });
    expect(res).toEqual({ ok: false, code: 'INVALID_CONFIG', message: 'Direct symlink must resolve to a regular file.' });
  });

  it('resolves direct file symlink and deduplicates by resolved identity', async () => {
    const host = makeMockHost({ 'real.json': { type: 'file' }, 'symlink.json': { type: 'symlink', target: 'real.json' } });
    const res = await collectInputs({ inputs: ['symlink.json', 'real.json'], host });
    expect(res.ok && res.inputs).toHaveLength(1);
    expect(res.ok && res.inputs[0]?.label).toBe('real.json');
  });

  it('deduplicates duplicate inputs deterministically', async () => {
    const host = makeMockHost({ 'flow.json': { type: 'file' } });
    const res = await collectInputs({ inputs: ['flow.json', 'flow.json'], host });
    expect(res.ok && res.inputs).toHaveLength(1);
    expect(res.ok && res.inputs[0]?.label).toBe('flow.json');
  });

  it('fails closed on TOCTOU directory symlink swap during recursion', async () => {
    const baseHost = makeMockHost({ 'parent': { type: 'dir' }, 'parent/child': { type: 'dir' }, 'parent/child/a.json': { type: 'file' } });
    let calls = 0;
    const toctouHost = {
      ...baseHost,
      lstat: async (p: string) => {
        calls += 1;
        if (p.includes('parent/child') && calls > 1) return { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true };
        return baseHost.lstat(p);
      },
    };
    const res = await collectInputs({ inputs: ['parent'], host: toctouHost });
    expect(res).toEqual({ ok: false, code: 'INPUT_READ_FAILED', message: 'Directory structure modified during scan.' });
  });

  it('fails closed on TOCTOU file swap during direct scan', async () => {
    const baseHost = makeMockHost({ 'file.json': { type: 'file' } });
    let lstatCount = 0;
    const toctouHost = {
      ...baseHost,
      lstat: async (p: string) => {
        lstatCount += 1;
        if (lstatCount > 1) return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
        return baseHost.lstat(p);
      },
    };
    const res = await collectInputs({ inputs: ['file.json'], host: toctouHost });
    expect(res).toEqual({ ok: false, code: 'INPUT_READ_FAILED', message: 'File modified during scan.' });
  });

  it('detects output collision with direct input or resolved symlink', async () => {
    const host = makeMockHost({
      'real.json': { type: 'file' },
      'symlink.json': { type: 'symlink', target: 'real.json' },
      'out.json': { type: 'symlink', target: 'real.json' },
    });

    const direct = await collectInputs({ inputs: ['real.json'], outputPath: 'real.json', host });
    expect(direct).toEqual({ ok: false, code: 'INVALID_CONFIG', message: 'Output path collides with an input file.' });

    const symlinkCol = await collectInputs({ inputs: ['symlink.json'], outputPath: 'out.json', host });
    expect(symlinkCol).toEqual({ ok: false, code: 'INVALID_CONFIG', message: 'Output path collides with an input file.' });

    const nonCol = await collectInputs({ inputs: ['real.json'], outputPath: 'other.json', host });
    expect(nonCol.ok).toBe(true);
  });
});

describe('collectInputs with real filesystem host', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), 'wc0803-test-')); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('traverses real directories and resolves real file symlinks', async () => {
    await mkdir(join(tempDir, 'sub'), { recursive: true });
    await writeFile(join(tempDir, 'sub', 'b.json'), '{}');
    await writeFile(join(tempDir, 'a.json'), '{}');
    try { await symlink(join(tempDir, 'a.json'), join(tempDir, 'sub', 'link_to_a.json')); } catch {}

    const res = await collectInputs({ inputs: ['.'], baseDirectory: tempDir });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.inputs.some((i) => i.label === 'a.json')).toBe(true);
    expect(res.inputs.some((i) => i.label === 'sub/b.json')).toBe(true);
    const realPaths = res.inputs.map((i) => i.realPath);
    expect(new Set(realPaths).size).toBe(realPaths.length);
  });
});
