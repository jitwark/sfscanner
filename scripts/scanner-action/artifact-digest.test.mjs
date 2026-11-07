import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectArtifactEntries, compareArtifactSets, hashRegularFile, resolveInside } from './artifact-digest.mjs';

const roots = [];

function candidate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-digest-'));
  roots.push(root);
  const dist = path.join(root, 'packages/scanner-cli/dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.js'), 'index\n');
  fs.writeFileSync(path.join(dist, 'main.js'), 'main\n');
  fs.writeFileSync(path.join(dist, 'scan-worker.js'), 'worker\n');
  return root;
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('artifact digest adapter', () => {
  it('refuses linked ancestors even when dist itself is a regular directory', () => {
    const root = candidate();
    const moved = path.join(root, 'moved-packages');
    fs.renameSync(path.join(root, 'packages'), moved);
    fs.symlinkSync(moved, path.join(root, 'packages'), 'junction');
    expect(() => collectArtifactEntries(root)).toThrow('SYMLINK_REFUSED');
  });

  it('refuses hardlinked artifact bytes', () => {
    const root = candidate();
    fs.linkSync(path.join(root, 'packages/scanner-cli/dist/main.js'), path.join(root, 'alias.js'));
    expect(() => collectArtifactEntries(root)).toThrow('HARDLINK_REFUSED');
  });
  it('hashes the complete sorted dist artifact set', () => {
    const root = candidate();
    const result = collectArtifactEntries(root);
    expect(result.artifacts.map(({ path: file }) => file)).toEqual([
      'packages/scanner-cli/dist/index.js',
      'packages/scanner-cli/dist/main.js',
      'packages/scanner-cli/dist/scan-worker.js',
    ]);
    expect(result.artifactSetSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(compareArtifactSets(result, result.artifacts)).toMatchObject({ ok: true, artifactCount: 3 });
  });

  it('detects a same-size artifact mutation by digest', () => {
    const root = candidate();
    const expected = collectArtifactEntries(root).artifacts;
    fs.writeFileSync(path.join(root, 'packages/scanner-cli/dist/main.js'), 'MAIN\n');
    const actual = collectArtifactEntries(root);
    expect(compareArtifactSets(actual, expected)).toMatchObject({ ok: false, code: 'ARTIFACT_DIGEST_MISMATCH', file: 'packages/scanner-cli/dist/main.js' });
  });

  it('detects missing and extra executable artifacts', () => {
    const root = candidate();
    const expected = collectArtifactEntries(root).artifacts;
    fs.rmSync(path.join(root, 'packages/scanner-cli/dist/index.js'));
    expect(compareArtifactSets(collectArtifactEntries(root), expected)).toMatchObject({ ok: false, code: 'ARTIFACT_SET_SIZE_MISMATCH' });

    const second = candidate();
    const baseline = collectArtifactEntries(second).artifacts;
    fs.writeFileSync(path.join(second, 'packages/scanner-cli/dist/extra.js'), 'extra\n');
    expect(compareArtifactSets(collectArtifactEntries(second), baseline)).toMatchObject({ ok: false, code: 'ARTIFACT_SET_SIZE_MISMATCH' });
  });

  it('refuses traversal and links inside the artifact tree', () => {
    const root = candidate();
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'outside\n');
    expect(() => resolveInside(root, '../outside.txt')).toThrow('PATH_INVALID');
    try {
      fs.symlinkSync(outside, path.join(root, 'packages/scanner-cli/dist/link.js'), 'file');
      expect(() => collectArtifactEntries(root)).toThrow('SYMLINK_REFUSED');
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
    }
  });

  it('rejects a non-regular file rather than hashing it', () => {
    const root = candidate();
    expect(() => hashRegularFile(path.join(root, 'packages/scanner-cli/dist'), 'directory')).toThrow('NOT_REGULAR_FILE');
  });
});
