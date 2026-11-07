import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  downloadRelease,
  releaseIdentity,
  selectReleaseAsset,
} from '../pages-release-download.mjs';
import { pagesRelease } from '../pages-release.mjs';
import { createArchive } from '../pages-release-tar.mjs';

const temporaryRoots = [];

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

it('release identity and asset selection reject ambiguous or unsafe delivery identities', () => {
  const sha256 = 'a'.repeat(64);
  const identity = releaseIdentity({
    repository: 'owner/sfscanner',
    tag: 'v0.2.1',
    asset: 'pages.tar',
    sha256,
  });
  const release = {
    tag_name: 'v0.2.1',
    draft: false,
    assets: [{
      id: 42,
      name: 'pages.tar',
      state: 'uploaded',
      size: 4096,
      digest: `sha256:${sha256}`,
    }],
  };
  expect(selectReleaseAsset(release, identity)).toEqual({ id: 42, size: 4096 });
  expect(
    selectReleaseAsset({ ...release, assets: [{ ...release.assets[0], digest: undefined }] }, identity),
  ).toEqual({ id: 42, size: 4096 });
  for (const [candidate, pattern] of [
    [{ ...release, tag_name: 'v9' }, /identity mismatch/u],
    [{ ...release, draft: true }, /identity mismatch or draft/u],
    [{ ...release, assets: [release.assets[0], { ...release.assets[0], id: 43 }] }, /exactly one/u],
    [{ ...release, assets: [{ ...release.assets[0], state: 'new' }] }, /unsafe release asset/u],
    [{ ...release, assets: [{ ...release.assets[0], id: 0 }] }, /unsafe release asset/u],
    [{ ...release, assets: [{ ...release.assets[0], size: 1023 }] }, /unsafe release asset/u],
    [{ ...release, assets: [{ ...release.assets[0], digest: `sha256:${'0'.repeat(64)}` }] }, /digest mismatch/u],
  ]) {
    expect(() => selectReleaseAsset(candidate, identity)).toThrow(pattern);
  }
});

it('downloadRelease writes only the selected asset and verifies its exact bytes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pages-release-download-'));
  temporaryRoots.push(root);
  const source = path.join(root, 'source');
  mkdirSync(source);
  writeFileSync(path.join(source, 'index.html'), 'index');
  writeFileSync(path.join(source, '.nojekyll'), '');
  const expectedArchive = path.join(root, 'expected.tar');
  const expected = await createArchive(source, expectedArchive);
  const archiveBytes = readFileSync(expectedArchive);
  const output = path.join(root, 'downloaded.tar');
  let calls = 0;
  const run = (command, args, options) => {
    expect(command).toBe('gh');
    calls++;
    if (args[1].includes('/releases/tags/')) {
      return {
        status: 0,
        stdout: JSON.stringify({
          tag_name: 'v0.2.1',
          draft: false,
          assets: [{
            id: 42,
            name: 'pages.tar',
            state: 'uploaded',
            size: archiveBytes.length,
            digest: `sha256:${expected.sha256}`,
          }],
        }),
        stderr: '',
      };
    }
    expect(args[1]).toMatch(/\/releases\/assets\/42$/u);
    writeSync(options.stdio[1], archiveBytes);
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = await downloadRelease({
    repository: 'owner/sfscanner',
    tag: 'v0.2.1',
    asset: 'pages.tar',
    sha256: expected.sha256,
    archive: output,
  }, run);
  expect(calls).toBe(2);
  expect(result.sha256).toBe(expected.sha256);
  expect(createHash('sha256').update(readFileSync(output)).digest('hex')).toBe(expected.sha256);
});

it('CLI rejects missing, unknown, duplicate, and uppercase arguments', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pages-release-cli-'));
  temporaryRoots.push(root);
  const source = path.join(root, 'source');
  mkdirSync(source);
  writeFileSync(path.join(source, 'index.html'), 'index');
  writeFileSync(path.join(source, '.nojekyll'), '');
  const archive = path.join(root, 'pages.tar');
  const manifestPath = path.join(root, 'readback.json');
  const created = await createArchive(source, archive);
  expect(await pagesRelease(['verify', '--archive', archive, '--sha256', created.sha256])).toEqual(created);
  const manifest = await pagesRelease([
    'manifest', '--source', source, '--output', manifestPath, '--sha256', created.sha256,
  ]);
  expect(manifest.files).toBe(2);
  expect(manifest.bytes).toBe(5);
  await expect(pagesRelease(['verify', '--archive', archive])).rejects.toThrow(/missing arguments/u);
  await expect(
    pagesRelease(['verify', '--archive', archive, '--sha256', created.sha256, '--extra', 'x']),
  ).rejects.toThrow(/missing arguments/u);
  await expect(
    pagesRelease(['verify', '--archive', archive, '--archive', archive]),
  ).rejects.toThrow(/duplicate argument/u);
  await expect(
    pagesRelease(['verify', '--archive', archive, '--sha256', created.sha256.toUpperCase()]),
  ).rejects.toThrow(/exact lowercase SHA256/u);
  await expect(pagesRelease([
    'readback', '--page-url', 'https://owner.github.io/sfscanner/',
    '--manifest', manifestPath, '--sha256', 'b'.repeat(64),
  ])).rejects.toThrow(/archive identity mismatch/u);
});

it('deploy workflow uses immutable direct artifact actions and anonymous readback', () => {
  const workflow = readFileSync(path.resolve('.github/workflows/deploy.yml'), 'utf8');
  const deployJob = workflow.slice(workflow.indexOf('\n  deploy:'));
  const deployPermissions = deployJob.slice(
    deployJob.indexOf('    permissions:'), deployJob.indexOf('    steps:'),
  );
  expect(deployPermissions).toMatch(/actions: read/u);
  expect(deployPermissions).toMatch(/contents: read/u);
  expect(deployPermissions).toMatch(/pages: write/u);
  expect(deployPermissions).toMatch(/id-token: write/u);
  expect(workflow).not.toMatch(/actions\/upload-pages-artifact@/u);
  expect(workflow).toMatch(/actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/u);
  expect(workflow).toMatch(/actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/u);
  expect(workflow).toMatch(/name:\s*github-pages/u);
  expect(workflow).toMatch(/name:\s*pages-readback-manifest/u);
  expect(workflow).toMatch(/scripts\/pages-release\.mjs readback/u);
  expect(workflow).toMatch(/steps\.deployment\.outputs\.page_url/u);
  const readback = workflow.slice(workflow.indexOf('scripts/pages-release.mjs readback'));
  expect(readback).not.toMatch(/GH_TOKEN|Authorization/iu);
});
