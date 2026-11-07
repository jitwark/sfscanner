import { describe, expect, it } from 'vitest';
import { collectInputs, compilePosixGlob, type InputSelectionHost, type HostEntry } from './input-selection';

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

describe('compilePosixGlob', () => {
  it('matches single-segment and double-star globs correctly', () => {
    const jsonGlob = compilePosixGlob('**/*.json');
    expect(jsonGlob.test('workflow.json')).toBe(true);
    expect(jsonGlob.test('nested/dir/workflow.json')).toBe(true);
    expect(jsonGlob.test('workflow.txt')).toBe(false);

    const gitGlob = compilePosixGlob('.git/**');
    expect(gitGlob.test('.git/config')).toBe(true);
    expect(gitGlob.test('.git/objects/abc')).toBe(true);
    expect(gitGlob.test('sub/.git/config')).toBe(false);
  });

  it('handles malformed glob syntax safely without throwing', () => {
    expect(() => compilePosixGlob('test[unclosed')).not.toThrow();
    expect(compilePosixGlob('test[unclosed') instanceof RegExp).toBe(true);
    expect(() => compilePosixGlob('test[z-a]')).not.toThrow();
  });
});

describe('collectInputs core selection', () => {
  it('collects files deterministically with lexical ordering', async () => {
    const host = makeMockHost({ 'dir/z.json': { type: 'file' }, 'dir/a.json': { type: 'file' }, 'dir/m.json': { type: 'file' }, 'dir': { type: 'dir' } });
    const res = await collectInputs({ inputs: ['dir'], host });
    expect(res.ok && res.inputs.map((i) => i.label)).toEqual(['dir/a.json', 'dir/m.json', 'dir/z.json']);
  });

  it('fails with INVALID_CONFIG when directory has no matching workflow inputs', async () => {
    const host = makeMockHost({ 'empty-dir': { type: 'dir' }, 'empty-dir/notes.txt': { type: 'file' } });
    const res = await collectInputs({ inputs: ['empty-dir'], host });
    expect(res).toEqual({ ok: false, code: 'INVALID_CONFIG', message: 'No matching workflow inputs found.' });
  });

  it('isolates stdin and rejects combination with files', async () => {
    const host = makeMockHost({ 'flow.json': { type: 'file' } });
    expect(await collectInputs({ inputs: ['-'], host })).toEqual({ ok: true, inputs: [{ label: '-', isStdin: true }] });
    expect(await collectInputs({ inputs: ['-', 'flow.json'], host })).toEqual({ ok: false, code: 'INVALID_CONFIG', message: 'Standard input cannot be combined with file inputs.' });
  });

  it('rejects empty inputs with INVALID_CONFIG', async () => {
    expect(await collectInputs({ inputs: [] })).toEqual({ ok: false, code: 'INVALID_CONFIG', message: 'At least one workflow input is required.' });
  });

  it('rejects remote, UNC, and traversal inputs but admits a local absolute path', async () => {
    const bad = ['https://e.com/f.json', '\\\\server\\share\\f.json', '../outside.json', 'dir/\0bad.json'];
    for (const p of bad) {
      const res = await collectInputs({ inputs: [p] });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).not.toContain(p);
    }
    const host = makeMockHost({ 'C:/work/flow.json': { type: 'file' } });
    const absolute = await collectInputs({ inputs: ['C:\\work\\flow.json'], baseDirectory: 'C:/work', host });
    expect(absolute).toEqual({ ok: true, inputs: [{ label: 'flow.json', realPath: '/mock-root/C:/work/flow.json', isStdin: false }] });
    const missing = await collectInputs({ inputs: ['C:/work/missing.json'], baseDirectory: 'C:/work', host });
    expect(missing).toEqual({ ok: false, code: 'INPUT_READ_FAILED', message: 'Input path does not exist or cannot be accessed.' });
  });

  it('rejects invalid outputPath with INVALID_CONFIG before collision check', async () => {
    const host = makeMockHost({ 'real.json': { type: 'file' } });
    const badOutputs = ['https://evil.com/out.json', '/etc/shadow', 'C:/out.json', '../escape.json', '\\\\srv\\sh\\out.json'];
    for (const out of badOutputs) {
      const res = await collectInputs({ inputs: ['real.json'], outputPath: out, host });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('INVALID_CONFIG');
        expect(res.message).not.toContain(out);
      }
    }
  });

  it('does not fall back to defaults when include or exclude is explicitly empty array', async () => {
    const host = makeMockHost({ 'test.json': { type: 'file' }, 'test.txt': { type: 'file' } });
    expect(await collectInputs({ inputs: ['.'], include: [], host })).toEqual({ ok: false, code: 'INVALID_CONFIG', message: 'No matching workflow inputs found.' });

    const hostWithGit = makeMockHost({ '.git': { type: 'dir' }, '.git/config.json': { type: 'file' } });
    const resEmptyExc = await collectInputs({ inputs: ['.'], exclude: [], host: hostWithGit });
    expect(resEmptyExc.ok && resEmptyExc.inputs.map((i) => i.label)).toEqual(['.git/config.json']);
  });

  it('enforces shared traversal budget across multiple roots', async () => {
    const fs: Record<string, { type: 'file' | 'dir' }> = {};
    for (let i = 0; i < 60; i++) {
      fs[`root1/dir${i}/flow.json`] = { type: 'file' };
      fs[`root2/dir${i}/flow.json`] = { type: 'file' };
    }
    const host = makeMockHost(fs);
    expect((await collectInputs({ inputs: ['root1', 'root2'], host })).ok).toBe(true);
  });

  it('safely rejects deeply nested labels exceeding length bound', async () => {
    const longName = 'a'.repeat(4090);
    const host = makeMockHost({ [`dir/${longName}.json`]: { type: 'file' } });
    const res = await collectInputs({ inputs: ['dir'], host });
    expect(res).toEqual({ ok: false, code: 'INPUT_READ_FAILED', message: 'Input label exceeds maximum length.' });
  });
});
