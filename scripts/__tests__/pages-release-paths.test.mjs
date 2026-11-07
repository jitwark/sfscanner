import { afterEach, expect, it } from 'vitest';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  accounting,
  confinedPath,
  PAGES_LIMITS,
  safeRelative,
  sourceFiles,
} from '../pages-release-paths.mjs';
import { createArchive } from '../pages-release-tar.mjs';

const temporaryRoots = [];

function fixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pages-release-paths-'));
  temporaryRoots.push(root);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

it('safeRelative rejects hostile paths and upload-excluded metadata trees', () => {
  for (const name of [
    '../escape',
    '/absolute',
    'a\\b',
    'C:/drive',
    'a//b',
    'a/./b',
    'a/../b',
    'a./b',
    'CON.txt',
    'line\nbreak',
    '.git/config',
    '.github/workflows/deploy.yml',
    'assets/.git/config',
    'assets/.GitHub/workflow.yml',
  ]) {
    expect(() => safeRelative(name), name).toThrow(/unsafe archive path/u);
  }
  expect(safeRelative('assets/app.js')).toBe('assets/app.js');
  expect(safeRelative('.nojekyll')).toBe('.nojekyll');
});

it('accounting counts uppercase HTML and rejects all raw or workflow data', () => {
  const html = accounting();
  expect(
    () => html.add('LARGE.HTML', PAGES_LIMITS.htmlBytes + 1),
  ).toThrow(/static host budget exceeded/u);

  for (const name of [
    'data/raw/private.yaml',
    'data/raw/private.json.txt',
    'data/raw/private.json.bak',
    'data/raw/renamed',
    'data/workflow/private.txt',
    'data/workflows/private.yaml',
  ]) {
    const budget = accounting();
    expect(() => budget.add(name, 1), name).toThrow(/raw workflow data is forbidden/u);
  }
});

it('createArchive refuses an output inside source across Windows case variants', async () => {
  const fixture = fixtureRoot();
  const source = path.join(fixture.root, 'case-source');
  mkdirSync(source);
  writeFileSync(path.join(source, 'index.html'), 'index');
  writeFileSync(path.join(source, '.nojekyll'), '');
  const caseVariant = process.platform === 'win32'
    ? `${source[0].toLowerCase()}${source.slice(1)}`
    : source;
  await expect(
    createArchive(source, path.join(caseVariant, 'nested.tar')),
  ).rejects.toThrow(/archive must be outside source/u);
});

it('source scanning and confinement reject links on every fixture platform', async (context) => {
  const fixture = fixtureRoot();
  for (const name of ['linked-source', 'linked-target', 'hardlink-source']) {
    mkdirSync(path.join(fixture.root, name));
  }
  const source = path.join(fixture.root, 'linked-source');
  const target = path.join(fixture.root, 'linked-target');
  writeFileSync(path.join(source, 'index.html'), 'index');
  writeFileSync(path.join(source, '.nojekyll'), '');
  writeFileSync(path.join(target, 'secret.txt'), 'secret');
  try {
    symlinkSync(target, path.join(source, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    context.skip(`junction creation unavailable: ${error.code}`);
    return;
  }
  await expect(sourceFiles(source)).rejects.toThrow(/source symlink\/junction is forbidden/u);
  await expect(
    confinedPath(path.join(source, 'link', 'secret.txt')),
  ).rejects.toThrow(/symlink\/junction path is forbidden/u);

  const hardlinkSource = path.join(fixture.root, 'hardlink-source');
  writeFileSync(path.join(hardlinkSource, 'index.html'), 'index');
  writeFileSync(path.join(hardlinkSource, '.nojekyll'), '');
  linkSync(path.join(hardlinkSource, 'index.html'), path.join(hardlinkSource, 'copy.html'));
  await expect(sourceFiles(hardlinkSource)).rejects.toThrow(/hard link is forbidden/u);
});
