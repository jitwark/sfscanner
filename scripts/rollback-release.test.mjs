import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { replacePointer } from './rollback-release.mjs';

const script = path.resolve(import.meta.dirname, 'rollback-release.mjs');
const pointerName = 'active-release.json';
const ledgerName = 'trusted-release-ledger.json';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function bundleHash(files) {
  const digest = createHash('sha256');
  for (const file of [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    digest.update(file.path);
    digest.update('\0');
    digest.update(file.bytes);
    digest.update('\0');
  }
  return digest.digest('hex');
}

function artifactRecords(files) {
  return [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0).map((file) => ({
    path: file.path,
    byteSize: file.bytes.length,
    sha256: sha256(file.bytes),
  }));
}

async function createRelease(root, releaseId, sequence) {
  const releaseRoot = path.join(root, 'releases', releaseId);
  const siteFiles = [
    { path: 'index.html', bytes: Buffer.from(`<html>${releaseId}</html>`) },
    { path: 'app.js', bytes: Buffer.from(`globalThis.release = '${releaseId}';`) },
  ];
  const dataFiles = [
    { path: 'manifest.json', bytes: Buffer.from(JSON.stringify({ releaseId, sequence })) },
    { path: 'catalogue-0.json', bytes: Buffer.from(JSON.stringify([{ id: `${releaseId}-entry` }])) },
  ];

  for (const [directory, files] of [['site', siteFiles], ['data', dataFiles]]) {
    for (const file of files) {
      await mkdir(path.dirname(path.join(releaseRoot, directory, file.path)), { recursive: true });
      await writeFile(path.join(releaseRoot, directory, file.path), file.bytes);
    }
  }

  const record = {
    schemaVersion: 'fixture-release-v1',
    releaseId,
    sequence,
    verified: true,
    verification: {
      status: 'verified',
      method: 'fixture-hashes-v1',
      evidence: 'trusted-release-ledger.json',
    },
    artifactSchemaVersion: 'fixture-artifact-v1',
    site: {
      schemaVersion: 'fixture-artifact-v1',
      sha256: bundleHash(siteFiles),
      artifacts: artifactRecords(siteFiles),
    },
    data: {
      schemaVersion: 'fixture-artifact-v1',
      sha256: bundleHash(dataFiles),
      artifacts: artifactRecords(dataFiles),
    },
  };
  const releaseBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  await writeFile(path.join(releaseRoot, 'release.json'), releaseBytes);
  return { ...record, releaseJsonSha256: sha256(releaseBytes) };
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hub-rollback-'));
  await writeJson(path.join(root, 'fixture.json'), {
    schemaVersion: 'rollback-fixture-v1',
    scope: 'fixture-only',
  });
  const releaseN = await createRelease(root, 'N', 1);
  const releaseN1 = await createRelease(root, 'N+1', 2);
  await writeJson(path.join(root, ledgerName), {
    schemaVersion: 'fixture-trusted-release-ledger-v1',
    releases: [releaseN, releaseN1].map((release) => ({
      releaseId: release.releaseId,
      sequence: release.sequence,
      releaseJsonSha256: release.releaseJsonSha256,
      siteSha256: release.site.sha256,
      dataSha256: release.data.sha256,
    })),
  });
  await writeJson(path.join(root, pointerName), {
    schemaVersion: 'fixture-active-release-pointer-v1',
    releaseId: 'N+1',
  });
  return { root, releaseN, releaseN1 };
}

function run(root, releaseId) {
  return spawnSync(process.execPath, [script, '--fixture-root', root, '--release-id', releaseId], {
    encoding: 'utf8',
    env: { ...process.env },
  });
}

async function snapshotFiles(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot = [];
  for (const entry of entries) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) snapshot.push(...await snapshotFiles(root, child));
    else snapshot.push([child.replaceAll(path.sep, '/'), (await readFile(path.join(root, child))).toString('base64')]);
  }
  return snapshot.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

async function readPointer(root) {
  return readFile(path.join(root, pointerName), 'utf8');
}

test('rolls back N+1 to N and preserves N site/data hashes exactly', async () => {
  const { root, releaseN, releaseN1 } = await createFixture();
  try {
    assert.notEqual(releaseN.site.sha256, releaseN1.site.sha256);
    assert.notEqual(releaseN.data.sha256, releaseN1.data.sha256);

    const result = run(root, 'N');

    assert.equal(result.status, 0, result.stderr);
    const pointer = JSON.parse(await readPointer(root));
    const active = JSON.parse(await readFile(path.join(root, 'releases', pointer.releaseId, 'release.json'), 'utf8'));
    assert.equal(pointer.releaseId, 'N');
    assert.equal(active.site.sha256, releaseN.site.sha256);
    assert.equal(active.data.sha256, releaseN.data.sha256);
    assert.deepEqual(active.site.artifacts, releaseN.site.artifacts);
    assert.deepEqual(active.data.artifacts, releaseN.data.artifacts);
    const actualSite = [
      { path: 'index.html', bytes: await readFile(path.join(root, 'releases', 'N', 'site', 'index.html')) },
      { path: 'app.js', bytes: await readFile(path.join(root, 'releases', 'N', 'site', 'app.js')) },
    ];
    const actualData = [
      { path: 'manifest.json', bytes: await readFile(path.join(root, 'releases', 'N', 'data', 'manifest.json')) },
      { path: 'catalogue-0.json', bytes: await readFile(path.join(root, 'releases', 'N', 'data', 'catalogue-0.json')) },
    ];
    assert.equal(bundleHash(actualSite), active.site.sha256);
    assert.equal(bundleHash(actualData), active.data.sha256);
    assert.match(result.stdout, /release N/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rollback changes only the active pointer', async () => {
  const { root } = await createFixture();
  try {
    const before = await snapshotFiles(root);
    const result = run(root, 'N');
    assert.equal(result.status, 0, result.stderr);
    const after = await snapshotFiles(root);
    const changed = after.filter(([file, bytes], index) => before[index]?.[0] !== file || before[index]?.[1] !== bytes).map(([file]) => file);
    assert.deepEqual(changed, [pointerName]);
    assert.ok(after.every(([file]) => !file.includes('.tmp-')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const rejectionCases = [
  {
    name: 'missing release',
    target: 'missing',
    reason: /missing|not found/i,
  },
  {
    name: 'corrupt release artifact',
    target: 'N',
    reason: /hash|corrupt/i,
    mutate: async (root) => writeFile(path.join(root, 'releases', 'N', 'site', 'index.html'), 'tampered'),
  },
  {
    name: 'mixed-schema release',
    target: 'N',
    reason: /schema/i,
    mutate: async (root) => {
      const file = path.join(root, 'releases', 'N', 'release.json');
      const record = JSON.parse(await readFile(file, 'utf8'));
      record.data.schemaVersion = 'fixture-artifact-v2';
      await writeJson(file, record);
    },
  },
  {
    name: 'unverified release',
    target: 'N',
    reason: /verif/i,
    mutate: async (root) => {
      const file = path.join(root, 'releases', 'N', 'release.json');
      const record = JSON.parse(await readFile(file, 'utf8'));
      record.verified = false;
      record.verification.status = 'unverified';
      await writeJson(file, record);
    },
  },
  {
    name: 'release.json without a trusted ledger binding',
    target: 'N',
    reason: /identity|ledger|digest|binding/i,
    mutate: async (root) => {
      const file = path.join(root, 'releases', 'N', 'release.json');
      const record = JSON.parse(await readFile(file, 'utf8'));
      record.verification.evidence = 'different-evidence';
      await writeJson(file, record);
    },
  },
  {
    name: 'verified status without concrete method and evidence',
    target: 'N',
    reason: /verif/i,
    mutate: async (root) => {
      const file = path.join(root, 'releases', 'N', 'release.json');
      const record = JSON.parse(await readFile(file, 'utf8'));
      record.verification = { status: 'verified' };
      await writeJson(file, record);
    },
  },
];

for (const rejection of rejectionCases) {
  test(`rejects ${rejection.name} and leaves the active pointer unchanged`, async () => {
    const { root } = await createFixture();
    try {
      if (rejection.mutate) await rejection.mutate(root);
      const before = await readPointer(root);

      const result = run(root, rejection.target);

      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, rejection.reason);
      assert.equal(await readPointer(root), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('refuses an unmarked fixture root without creating a pointer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hub-not-a-fixture-'));
  try {
    const result = run(root, 'N');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /fixture/i);
    await assert.rejects(readFile(path.join(root, pointerName)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a traversal release ID without touching the pointer', async () => {
  const { root } = await createFixture();
  try {
    const before = await readPointer(root);
    const result = run(root, '../N');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid|release ID/i);
    assert.equal(await readPointer(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an outside-the-temporary-directory fixture root', async () => {
  const result = run(path.resolve(os.tmpdir(), '..'), 'N');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /temporary|fixture root/i);
});

test('rejects discovered filesystem names containing backslashes', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows cannot create a filename containing a backslash');
    return;
  }
  const { root } = await createFixture();
  try {
    const extra = Buffer.from('unexpected');
    const file = path.join(root, 'releases', 'N', 'site', 'bad\\name.js');
    await writeFile(file, extra);
    const releaseFile = path.join(root, 'releases', 'N', 'release.json');
    const record = JSON.parse(await readFile(releaseFile, 'utf8'));
    const files = [
      { path: 'app.js', bytes: await readFile(path.join(root, 'releases', 'N', 'site', 'app.js')) },
      { path: 'bad/name.js', bytes: extra },
      { path: 'index.html', bytes: await readFile(path.join(root, 'releases', 'N', 'site', 'index.html')) },
    ];
    record.site.artifacts = artifactRecords(files);
    record.site.sha256 = bundleHash(files);
    await writeJson(releaseFile, record);
    const before = await readPointer(root);
    const result = run(root, 'N');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /backslash|filesystem name/i);
    assert.equal(await readPointer(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects symlinks in fixture release artifacts when supported', async (t) => {
  const { root } = await createFixture();
  try {
    try {
      await symlink('index.html', path.join(root, 'releases', 'N', 'site', 'linked.html'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const before = await readPointer(root);
    const result = run(root, 'N');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink/i);
    assert.equal(await readPointer(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects directory junctions in fixture release artifacts when supported', async (t) => {
  const { root } = await createFixture();
  try {
    try {
      await symlink(path.join(root, 'releases', 'N', 'data'), path.join(root, 'releases', 'N', 'site', 'linked-data'), 'junction');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error?.code)) {
        t.skip(`junction creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const before = await readPointer(root);
    const result = run(root, 'N');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink|junction/i);
    assert.equal(await readPointer(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleans up staged pointer bytes when atomic replacement is interrupted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hub-pointer-interrupted-'));
  try {
    const pointerPath = path.join(root, pointerName);
    await writeFile(pointerPath, 'old-pointer');
    await assert.rejects(
      replacePointer(pointerPath, 'new-pointer', async () => { throw new Error('interrupted'); }),
      /atomic fixture pointer replacement failed/i,
    );
    assert.equal(await readFile(pointerPath, 'utf8'), 'old-pointer');
    assert.equal((await readdir(root)).some((name) => name.includes('.tmp-')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
