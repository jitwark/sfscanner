import { describe, expect, it } from 'vitest';
import {
  admitFixTarget,
  type FixPathAdmissionHostV1,
  type FixPathAdmissionResultV1,
  type FixPathDetailV1,
  type FixPathStatV1,
} from './fix-path-admission';

// Every fact below is injected. These tests never touch a real filesystem: no temp
// directory is created, no file is written and no os path is resolved.
type Entry = Readonly<{
  kind: 'file' | 'directory' | 'symlink' | 'other';
  nlink?: number;
  dev?: number;
  ino?: number;
  reparseTag?: number;
}>;

type Facts = Readonly<{
  entries?: Readonly<Record<string, Entry>>;
  realpaths?: Readonly<Record<string, string>>;
  unreadable?: readonly string[];
}>;

const DIRECTORY: Entry = Object.freeze({ kind: 'directory' });
const FILE: Entry = Object.freeze({ kind: 'file', nlink: 1, dev: 7, ino: 42 });
const ROOT = 'D:/root';
const TARGET = 'D:/root/a.json';

function statOf(entry: Entry): FixPathStatV1 {
  return {
    isFile: () => entry.kind === 'file',
    isDirectory: () => entry.kind === 'directory',
    isSymbolicLink: () => entry.kind === 'symlink',
    ...(entry.nlink === undefined ? {} : { nlink: entry.nlink }),
    ...(entry.dev === undefined ? {} : { dev: entry.dev }),
    ...(entry.ino === undefined ? {} : { ino: entry.ino }),
    ...(entry.reparseTag === undefined ? {} : { reparseTag: entry.reparseTag }),
  };
}

function codedError(code: string): Error {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

function makeHost(facts: Facts = {}): Readonly<{ host: FixPathAdmissionHostV1; calls: string[] }> {
  const calls: string[] = [];
  const entries = new Map(Object.entries(facts.entries ?? {}).map(([key, entry]) => [key.toLowerCase(), entry]));
  const realpaths = new Map(Object.entries(facts.realpaths ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const unreadable = new Set((facts.unreadable ?? []).map((key) => key.toLowerCase()));
  const host: FixPathAdmissionHostV1 = {
    lstat: async (path) => {
      calls.push(`lstat:${path}`);
      const key = path.toLowerCase();
      if (unreadable.has(key)) throw codedError('EACCES');
      const entry = entries.get(key);
      if (entry === undefined) throw codedError('ENOENT');
      return statOf(entry);
    },
    realpath: async (path) => {
      calls.push(`realpath:${path}`);
      return realpaths.get(path.toLowerCase()) ?? path;
    },
  };
  return { host, calls };
}

const refusal = (detail: FixPathDetailV1): FixPathAdmissionResultV1 => Object.freeze({
  ok: false as const,
  reason: 'UNSAFE_PATH' as const,
  detail,
});

const baseFacts = (overrides: Facts = {}): Facts => ({
  entries: { 'd:/root': DIRECTORY, 'd:/root/a.json': FILE, ...(overrides.entries ?? {}) },
  ...(overrides.realpaths === undefined ? {} : { realpaths: overrides.realpaths }),
  ...(overrides.unreadable === undefined ? {} : { unreadable: overrides.unreadable }),
});

async function refuse(input: Readonly<{ root: unknown; target: unknown; backup?: unknown }>, facts: Facts = baseFacts()) {
  const { host, calls } = makeHost(facts);
  const result = await admitFixTarget({
    root: input.root as string,
    target: input.target as string,
    ...(input.backup === undefined ? {} : { backup: input.backup as string }),
    host,
  });
  return { result, calls };
}

describe('fix path admission', () => {
  it('admits a regular file and binds the device/inode identity', async () => {
    const { result, calls } = await refuse({ root: ROOT, target: TARGET });
    expect(result).toEqual({
      ok: true,
      rootRealPath: 'D:/root',
      targetRealPath: 'D:/root/a.json',
      targetDirectory: 'D:/root',
      targetIdentity: 'inode:7:42',
      identityBasis: 'DEVICE_INODE',
    });
    expect(calls).toContain('lstat:D:/root/a.json');
  });

  it('falls back to the resolved path when the host reports no inode facts', async () => {
    const { result } = await refuse(
      { root: ROOT, target: TARGET },
      baseFacts({ entries: { 'd:/root': DIRECTORY, 'd:/root/a.json': { kind: 'file', nlink: 1 } } }),
    );
    expect(result).toMatchObject({
      ok: true,
      targetIdentity: 'path:D:/root/a.json',
      identityBasis: 'RESOLVED_PATH',
    });
  });

  it('refuses UNC and device-prefixed paths without consulting the host', async () => {
    for (const target of [
      String.raw`\\server\share\a.json`,
      String.raw`\\?\D:\root\a.json`,
      String.raw`\\.\D:\root\a.json`,
      '//server/share/a.json',
    ]) {
      const { result, calls } = await refuse({ root: ROOT, target });
      expect(result, target).toEqual(refusal('FORM'));
      expect(calls, target).toEqual([]);
    }
  });

  it('refuses alternate data streams before any filesystem fact', async () => {
    const { result, calls } = await refuse({ root: ROOT, target: 'D:/root/a.json:stream' });
    expect(result).toEqual(refusal('ADS'));
    expect(calls).toEqual([]);
  });

  it('refuses Windows device names and ambiguous trailing characters', async () => {
    for (const target of ['D:/root/CON.json', 'D:/root/com1', 'D:/root/nul', 'D:/root/a.json.', 'D:/root/a.json ']) {
      const { result, calls } = await refuse({ root: ROOT, target });
      expect(result).toEqual(refusal(target.endsWith('.') || target.endsWith(' ') ? 'FORM' : 'DEVICE'));
      expect(calls).toEqual([]);
    }
  });

  it('refuses relative, empty and parent-traversing paths', async () => {
    for (const [root, target] of [
      ['root', 'root/a.json'],
      ['D:/root', 'a.json'],
      ['', ''],
      ['D:/root', 'D:/root/../root/a.json'],
    ] as const) {
      const { result, calls } = await refuse({ root, target });
      expect(result).toEqual(refusal('FORM'));
      expect(calls).toEqual([]);
    }
  });

  it('refuses a target outside the explicit root lexically', async () => {
    const { result, calls } = await refuse({ root: ROOT, target: 'D:/other/a.json' });
    expect(result).toEqual(refusal('ESCAPE'));
    expect(calls).toEqual([]);
  });

  it('refuses a symlinked ancestor or target segment', async () => {
    const symlinked: readonly Readonly<Record<string, Entry>>[] = [
      { 'd:/root': { kind: 'symlink' } },
      { 'd:/root/a.json': { kind: 'symlink' } },
    ];
    for (const entries of symlinked) {
      const { result } = await refuse({ root: ROOT, target: TARGET }, baseFacts({ entries }));
      expect(result).toEqual(refusal('SYMLINK'));
    }
  });

  it('refuses a reparse point even when it reports as a directory', async () => {
    const { result } = await refuse(
      { root: ROOT, target: TARGET },
      baseFacts({ entries: { 'd:/root': { kind: 'directory', reparseTag: 0xa0000003 } } }),
    );
    expect(result).toEqual(refusal('REPARSE'));
  });

  it('refuses a non-regular target and a non-directory root', async () => {
    expect((await refuse({ root: ROOT, target: TARGET }, baseFacts({ entries: { 'd:/root/a.json': DIRECTORY } }))).result)
      .toEqual(refusal('NON_REGULAR'));
    expect((await refuse({ root: ROOT, target: TARGET }, baseFacts({ entries: { 'd:/root/a.json': { kind: 'other' } } }))).result)
      .toEqual(refusal('NON_REGULAR'));
    expect((await refuse({ root: ROOT, target: TARGET }, baseFacts({ entries: { 'd:/root': { kind: 'file', nlink: 1 } } }))).result)
      .toEqual(refusal('NON_REGULAR'));
  });

  it('refuses hard-linked targets when the link count is reported', async () => {
    const { result } = await refuse(
      { root: ROOT, target: TARGET },
      baseFacts({ entries: { 'd:/root/a.json': { ...FILE, nlink: 2 } } }),
    );
    expect(result).toEqual(refusal('HARDLINK'));
  });

  it('refuses unsafe identities such as a zero inode or half-reported facts', async () => {
    for (const entry of [
      { ...FILE, ino: 0 },
      { kind: 'file' as const, nlink: 1, dev: 7 },
      { kind: 'file' as const, nlink: 1, ino: 42 },
    ]) {
      const { result } = await refuse(
        { root: ROOT, target: TARGET },
        baseFacts({ entries: { 'd:/root/a.json': entry } }),
      );
      expect(result).toEqual(refusal('IDENTITY'));
    }
  });

  it('refuses unresolvable or unreadable targets', async () => {
    expect((await refuse({ root: ROOT, target: TARGET }, { entries: { 'd:/root': DIRECTORY } })).result)
      .toEqual(refusal('UNRESOLVABLE'));
    expect((await refuse({ root: ROOT, target: TARGET }, baseFacts({ unreadable: ['d:/root/a.json'] }))).result)
      .toEqual(refusal('UNRESOLVABLE'));
  });

  it('refuses a real path that escapes the resolved root', async () => {
    const { result } = await refuse(
      { root: ROOT, target: TARGET },
      baseFacts({ realpaths: { 'd:/root/a.json': 'D:/elsewhere/a.json' } }),
    );
    expect(result).toEqual(refusal('ESCAPE'));
  });

  it('refuses a real path the host cannot normalize', async () => {
    const { result } = await refuse(
      { root: ROOT, target: TARGET },
      baseFacts({ realpaths: { 'd:/root/a.json': 'relative/a.json' } }),
    );
    expect(result).toEqual(refusal('UNRESOLVABLE'));
  });

  it('refuses a backup equal to the target, elsewhere, or on another volume', async () => {
    expect((await refuse({ root: ROOT, target: TARGET, backup: 'D:/root/a.json' })).result)
      .toEqual(refusal('COLLISION'));
    expect((await refuse({ root: ROOT, target: TARGET, backup: 'D:/root/sub/other.bak' })).result)
      .toEqual(refusal('BACKUP'));
    expect((await refuse({ root: ROOT, target: TARGET, backup: 'E:/root/a.json.bak' })).result)
      .toEqual(refusal('CROSS_VOLUME'));
  });

  it('refuses a backup that escapes the root or carries a stream name', async () => {
    expect((await refuse({ root: ROOT, target: TARGET, backup: 'D:/elsewhere/a.json.bak' })).result)
      .toEqual(refusal('BACKUP'));
    expect((await refuse({ root: ROOT, target: TARGET, backup: 'D:/root/a.json.bak:stream' })).result)
      .toEqual(refusal('ADS'));
  });

  it('refuses a pre-existing backup instead of clobbering it', async () => {
    const { result, calls } = await refuse(
      { root: ROOT, target: TARGET, backup: 'D:/root/a.json.bak' },
      baseFacts({ entries: { 'd:/root/a.json.bak': { kind: 'file', nlink: 1, dev: 7, ino: 99 } } }),
    );
    expect(result).toEqual(refusal('COLLISION'));
    expect(calls).toContain('lstat:D:/root/a.json.bak');
  });

  it('treats an absent backup as safe and an unreadable backup path as unresolved', async () => {
    const safe = await refuse({ root: ROOT, target: TARGET, backup: 'D:/root/a.json.bak' });
    expect(safe.result).toMatchObject({ ok: true, targetIdentity: 'inode:7:42' });
    expect(safe.calls).toContain('lstat:D:/root/a.json.bak');
    const unsafe = await refuse(
      { root: ROOT, target: TARGET, backup: 'D:/root/a.json.bak' },
      baseFacts({ unreadable: ['d:/root/a.json.bak'] }),
    );
    expect(unsafe.result).toEqual(refusal('UNRESOLVABLE'));
  });
});
