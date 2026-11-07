import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { describeSection } from './release-artifacts.mjs';

/**
 * A release section is hashed from regular files only, so one directory symlink must stop the
 * walk instead of being followed out of the tree. A Windows junction is the same case — a
 * reparse point that `readdir` reports as a symbolic link — so the fixture uses whichever of
 * the two this platform can create and asserts the refusal through `describeSection`, the
 * entry point both the writer and the verifier use.
 */
it('rejects a directory symlink or junction inside a release section', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-artifacts-link-'));
  const tree = path.join(root, 'tree');
  const target = path.join(root, 'target');
  const link = path.join(tree, 'linked');
  try {
    await mkdir(tree);
    await mkdir(target);
    await writeFile(path.join(tree, 'index.html'), '<html></html>');
    await writeFile(path.join(target, 'outside.txt'), 'outside the section\n');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(describeSection(tree, 'fixture-artifact-v1'))
      .rejects.toThrow('symlink is not allowed in release artifacts: linked');
  } finally {
    // The link goes before the recursive delete: the junction points at a sibling of the
    // described tree, and cleanup must never be able to walk through it.
    await unlink(link).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
  expect(existsSync(root)).toBe(false);
});
