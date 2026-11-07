import { describe, expect, it } from 'vitest';
import { collectInputs, type HostEntry, type InputSelectionHost } from './input-selection';

const fileEntry = (name: string, ino = 1): HostEntry & { ino: number } => ({
  name,
  ino,
  isDirectory: () => false,
  isFile: () => true,
  isSymbolicLink: () => false,
});

function oneFileHost(fileName: string): InputSelectionHost {
  return {
    readdir: async () => [],
    lstat: async (path) => {
      if (path === fileName) return fileEntry(fileName);
      throw new Error('missing');
    },
    stat: async (path) => {
      if (path === fileName) return fileEntry(fileName);
      throw new Error('missing');
    },
    realpath: async (path) => `/mock-root/${path}`,
  };
}

describe('collectInputs security boundaries', () => {
  it('validates output before returning stdin and rejects explicit empty output', async () => {
    const host: InputSelectionHost = {
      readdir: async () => { throw new Error('must not traverse'); },
      lstat: async () => { throw new Error('must not stat'); },
      stat: async () => { throw new Error('must not stat'); },
      realpath: async () => { throw new Error('must not resolve'); },
    };

    for (const outputPath of ['', 'file:out.json', 'http:out.json', 'C:out.json', '/tmp/out.json']) {
      const result = await collectInputs({ inputs: ['-'], outputPath, host });
      expect(result).toEqual({ ok: false, code: 'INVALID_CONFIG', message: 'Output path is not admitted.' });
    }
    expect(await collectInputs({ inputs: ['-'], outputPath: '-', host })).toEqual({ ok: true, inputs: [{ label: '-', isStdin: true }] });
  });

  it('rejects schemes and drive-relative paths without echoing them', async () => {
    for (const input of ['file:workflow.json', 'http:workflow.json', 'C:workflow.json', 'file://host/workflow.json', '\\\\server\\share\\workflow.json']) {
      const result = await collectInputs({ inputs: [input], host: oneFileHost(input) });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_CONFIG');
        expect(result.message).not.toContain(input);
      }
    }
  });

  it('fails closed when a root changes identity after directory enumeration', async () => {
    let rootChecks = 0;
    const host: InputSelectionHost = {
      readdir: async () => [],
      lstat: async (path) => {
        if (path !== 'root') throw new Error('missing');
        rootChecks += 1;
        return {
          ino: rootChecks < 3 ? 1 : 2,
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        };
      },
      stat: async () => { throw new Error('unused'); },
      realpath: async (path) => `/mock-root/${path}`,
    };

    expect(await collectInputs({ inputs: ['root'], host })).toEqual({
      ok: false,
      code: 'INPUT_READ_FAILED',
      message: 'Directory structure modified during scan.',
    });
  });

  it('fails closed when a regular file changes identity during selection', async () => {
    let checks = 0;
    const host: InputSelectionHost = {
      readdir: async () => [],
      lstat: async (path) => {
        checks += 1;
        return {
          ino: checks === 1 ? 1 : 2,
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        };
      },
      stat: async () => { throw new Error('unused'); },
      realpath: async (path) => `/mock-root/${path}`,
    };

    expect(await collectInputs({ inputs: ['workflow.json'], host })).toEqual({
      ok: false,
      code: 'INPUT_READ_FAILED',
      message: 'File modified during scan.',
    });
  });

  it('enforces the file budget across direct roots', async () => {
    const inputs = Array.from({ length: 10_001 }, (_, index) => `root-${index}.json`);
    const host: InputSelectionHost = {
      readdir: async () => [],
      lstat: async () => ({ isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }),
      stat: async () => { throw new Error('unused'); },
      realpath: async (path) => `/mock-root/${path}`,
    };

    expect((await collectInputs({ inputs, host })).ok).toBe(false);
  });

  it('fails closed when a direct symlink changes target identity during selection', async () => {
    let statCount = 0;
    const host: InputSelectionHost = {
      readdir: async () => [],
      lstat: async () => ({ ino: 1, isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true }),
      stat: async () => {
        statCount += 1;
        return { ino: statCount === 1 ? 10 : 20, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
      },
      realpath: async (path) => `/mock-root/${path}`,
    };
    const res = await collectInputs({ inputs: ['link.json'], host });
    expect(res).toEqual({ ok: false, code: 'INPUT_READ_FAILED', message: 'File modified during scan.' });
  });

  it('enforces entry budget checked before readdir copy/sort across roots', async () => {
    const host: InputSelectionHost = {
      readdir: async () => Array.from({ length: 50_001 }, (_, i) => ({ name: `f${i}.json`, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false })),
      lstat: async () => ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }),
      stat: async () => ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }),
      realpath: async (path) => `/mock-root/${path}`,
    };
    const res = await collectInputs({ inputs: ['dir'], host });
    expect(res).toEqual({ ok: false, code: 'INPUT_READ_FAILED', message: 'Directory entry limit exceeded.' });
  });

  it('refuses recursive directory symlinks while preserving direct file symlink acceptance', async () => {
    const host: InputSelectionHost = {
      readdir: async (p) => {
        if (p === 'dir') return [{ name: 'symdir', isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true }];
        return [];
      },
      lstat: async (p) => ({
        isDirectory: () => p === 'dir',
        isFile: () => false,
        isSymbolicLink: () => p.endsWith('symdir'),
      }),
      stat: async (p) => ({
        isDirectory: () => p.endsWith('symdir'),
        isFile: () => false,
        isSymbolicLink: () => false,
      }),
      realpath: async (p) => `/mock-root/${p}`,
    };
    const res = await collectInputs({ inputs: ['dir'], host });
    expect(res).toEqual({ ok: false, code: 'INVALID_CONFIG', message: 'No matching workflow inputs found.' });
  });
});
