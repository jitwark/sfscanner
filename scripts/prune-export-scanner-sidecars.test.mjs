import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';

const sourceScript = path.resolve(import.meta.dirname, 'prune-export-scanner-sidecars.mjs');

async function sandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hub-sidecar-prune-'));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(sourceScript, path.join(root, 'scripts', 'prune-export-scanner-sidecars.mjs'));
  return root;
}

async function canonicalData(root, relative) {
  const data = path.join(root, relative, 'data');
  await mkdir(path.join(data, 'scanner'), { recursive: true });
  await writeFile(path.join(data, 'manifest.json'), JSON.stringify({ artifacts: [{ path: 'scanner/keep.json' }] }), 'utf8');
  await writeFile(path.join(data, 'scanner', 'keep.json'), '{"keep":true}', 'utf8');
  return { data, manifest: path.join(data, 'manifest.json'), sentinel: path.join(data, 'scanner', 'keep.json') };
}

function run(root, target) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'prune-export-scanner-sidecars.mjs'), target], {
    cwd: root, encoding: 'utf8', env: { ...process.env },
  });
}

for (const target of ['.', 'app/public']) {
  test(`refuses the canonical checkout path ${target}`, async () => {
    const root = await sandbox();
    try {
      const paths = await canonicalData(root, target);
      const beforeManifest = await readFile(paths.manifest, 'utf8');
      const beforeSentinel = await readFile(paths.sentinel, 'utf8');

      const result = run(root, target);

      assert.notEqual(result.status, 0, result.stdout);
      assert.match(`${result.stdout}${result.stderr}`, /refus|protected|canonical/i);
      assert.equal(await readFile(paths.manifest, 'utf8'), beforeManifest);
      assert.equal(await readFile(paths.sentinel, 'utf8'), beforeSentinel);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('prunes scanner sidecars from a synthetic export and is idempotent', async () => {
  const root = await sandbox();
  try {
    const out = path.join(root, 'app', 'out');
    const data = path.join(out, 'data');
    await mkdir(path.join(data, 'scanner'), { recursive: true });
    await writeFile(path.join(data, 'manifest.json'), JSON.stringify({ artifacts: [
      { path: 'facets.json', byteSize: 13 },
      { path: 'scanner/private.ndjson', byteSize: 7 },
    ] }), 'utf8');
    await writeFile(path.join(data, 'facets.json'), '{"facets":[]}', 'utf8');
    await writeFile(path.join(data, 'scanner', 'private.ndjson'), 'PRIVATE', 'utf8');

    const first = run(root, path.join('app', 'out'));
    assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
    const manifest = JSON.parse(await readFile(path.join(data, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.artifacts.map((artifact) => artifact.path), ['facets.json']);
    assert.equal(await readFile(path.join(data, 'facets.json'), 'utf8'), '{"facets":[]}');
    assert.deepEqual((await readdir(data)).toSorted(), ['facets.json', 'manifest.json']);

    const second = run(root, path.join('app', 'out'));
    assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
    assert.equal(
      await readFile(path.join(data, 'manifest.json'), 'utf8'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
