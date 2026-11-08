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
import yaml from 'js-yaml';
import {
  downloadRelease,
  releaseIdentity,
  selectReleaseAsset,
} from '../pages-release-download.mjs';
import { pagesRelease } from '../pages-release.mjs';
import { createArchive } from '../pages-release-tar.mjs';

const temporaryRoots = [];
const WORKFLOW_PATH = path.resolve('.github/workflows/deploy.yml');
const PAGES_UPLOAD_PIN =
  'actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9';
const ARTIFACT_UPLOAD_PIN =
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';
const ARTIFACT_DOWNLOAD_PIN =
  'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093';
const PAGES_DEPLOY_PIN =
  'actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e';

function workflowDocument() {
  return yaml.load(readFileSync(WORKFLOW_PATH, 'utf8'));
}

function findStep(job, predicate) {
  const step = job.steps.find(predicate);
  expect(step, 'expected workflow step').toBeDefined();
  return step;
}

function findRun(job, fragment) {
  return findStep(job, (step) => step.run?.includes(fragment));
}

function stepIndex(job, step) {
  return job.steps.indexOf(step);
}

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

it('deploy workflow uses the exact official Pages action and proves anonymous byte delivery', () => {
  const workflow = workflowDocument();
  const inputs = workflow.on.workflow_dispatch.inputs;
  const artifact = workflow.jobs.artifact;
  const deploy = workflow.jobs.deploy;

  expect(Object.keys(inputs).sort()).toEqual(['asset_name', 'release_tag', 'sha256']);
  for (const input of Object.values(inputs)) {
    expect(input).toMatchObject({ required: true, type: 'string' });
  }
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(artifact.if).toMatch(
    /github\.ref\s*==\s*format\('refs\/heads\/\{0\}',\s*github\.event\.repository\.default_branch\)/u,
  );
  expect(artifact.permissions).toEqual({ contents: 'read' });
  expect(deploy.needs).toBe('artifact');
  expect(deploy.permissions).toEqual({
    actions: 'read',
    contents: 'read',
    pages: 'write',
    'id-token': 'write',
  });
  expect(deploy.environment).toEqual({
    name: 'github-pages',
    url: '${{ steps.deployment.outputs.page_url }}',
  });

  for (const job of [artifact, deploy]) {
    const checkouts = job.steps.filter((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].with).toEqual({ 'persist-credentials': false });
    expect(
      job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'))?.with,
    ).toEqual({ 'node-version': '22.x' });
    for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
    }
  }

  const download = findRun(artifact, 'pages-release.mjs download');
  expect(download.env).toEqual({
    GH_TOKEN: '${{ github.token }}',
    RELEASE_REPOSITORY: '${{ github.repository }}',
    RELEASE_TAG: '${{ inputs.release_tag }}',
    RELEASE_ASSET: '${{ inputs.asset_name }}',
    RELEASE_SHA256: '${{ inputs.sha256 }}',
  });
  expect(download.run).toContain('--archive "$RUNNER_TEMP/qualified-pages.tar"');

  const extract = findRun(artifact, 'pages-release.mjs extract');
  expect(extract.env).toEqual({ RELEASE_SHA256: '${{ inputs.sha256 }}' });
  for (const fragment of [
    '--archive "$RUNNER_TEMP/qualified-pages.tar"',
    '--sha256 "$RELEASE_SHA256"',
    '--destination "$RUNNER_TEMP/qualified-pages"',
  ]) expect(extract.run).toContain(fragment);

  const before = findStep(
    artifact,
    (step) => step.run?.includes('pages-release.mjs manifest')
      && step.run.includes('--output "$RUNNER_TEMP/pages-readback.json"'),
  );
  const after = findStep(
    artifact,
    (step) => step.run?.includes('pages-release.mjs manifest')
      && step.run.includes('--output "$RUNNER_TEMP/pages-readback-after.json"'),
  );
  expect(before).not.toBe(after);
  for (const manifest of [before, after]) {
    expect(manifest.env).toEqual({ RELEASE_SHA256: '${{ inputs.sha256 }}' });
    expect(manifest.run).toContain('--source "$RUNNER_TEMP/qualified-pages"');
    expect(manifest.run).toContain('--sha256 "$RELEASE_SHA256"');
  }

  const packagingSteps = artifact.steps.filter(
    (step) => step.uses?.startsWith('actions/upload-pages-artifact@'),
  );
  expect(packagingSteps).toHaveLength(1);
  const packaging = packagingSteps[0];
  expect(packaging.uses).toBe(PAGES_UPLOAD_PIN);
  expect(packaging.with).toEqual({
    name: 'github-pages',
    path: '${{ runner.temp }}/qualified-pages',
    'include-hidden-files': true,
    'retention-days': 1,
  });
  expect(artifact.steps.some((step) => step.run?.includes('pages-release.mjs create'))).toBe(false);

  const comparison = findStep(
    artifact,
    (step) => step.run?.includes('cmp "$RUNNER_TEMP/pages-readback.json"'),
  );
  expect(comparison.run).toContain(
    'cmp "$RUNNER_TEMP/pages-readback.json" "$RUNNER_TEMP/pages-readback-after.json"',
  );
  expect(comparison.run).toContain(
    'sha256sum "$RUNNER_TEMP/pages-readback.json" "$RUNNER_TEMP/pages-readback-after.json"',
  );

  const uploadManifest = findStep(artifact, (step) => step.uses === ARTIFACT_UPLOAD_PIN);
  expect(uploadManifest.with).toMatchObject({
    name: 'pages-readback-manifest',
    'retention-days': 1,
    'if-no-files-found': 'error',
  });
  expect(uploadManifest.with.path).toContain('${{ runner.temp }}/pages-readback.json');
  expect(uploadManifest.with.path).toContain('${{ runner.temp }}/pages-readback-after.json');

  for (const [earlier, later] of [
    [download, extract],
    [extract, before],
    [before, packaging],
    [packaging, after],
    [after, comparison],
    [comparison, uploadManifest],
  ]) {
    expect(stepIndex(artifact, earlier)).toBeLessThan(stepIndex(artifact, later));
  }

  const deployDownload = findStep(deploy, (step) => step.uses === ARTIFACT_DOWNLOAD_PIN);
  expect(deployDownload.with).toEqual({
    name: 'pages-readback-manifest',
    path: '${{ runner.temp }}/pages-readback-manifest',
  });
  const deployment = findStep(deploy, (step) => step.uses === PAGES_DEPLOY_PIN);
  expect(deployment.id).toBe('deployment');
  const readback = findRun(deploy, 'pages-release.mjs readback');
  expect(readback.env).toEqual({
    PAGES_URL: '${{ steps.deployment.outputs.page_url }}',
    RELEASE_SHA256: '${{ inputs.sha256 }}',
  });
  for (const fragment of [
    '--page-url "$PAGES_URL"',
    '--manifest "$RUNNER_TEMP/pages-readback-manifest/pages-readback.json"',
    '--sha256 "$RELEASE_SHA256"',
  ]) expect(readback.run).toContain(fragment);
  expect(stepIndex(deploy, deployment)).toBeLessThan(stepIndex(deploy, readback));
  expect(JSON.stringify(deploy)).not.toMatch(/GH_TOKEN|Authorization|Bearer|Cookie/u);
});
