import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const sourceScript = path.resolve(import.meta.dirname, 'prepare-release-data.mjs');

async function createSandbox(manifest) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hub-release-data-'));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(sourceScript, path.join(root, 'scripts', 'prepare-release-data.mjs'));
  await mkdir(path.join(root, 'data'), { recursive: true });
  await writeFile(path.join(root, 'data', 'current.txt'), 'previous verified data', 'utf8');
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'manifest.json'), manifest, 'utf8');
  await writeFile(path.join(source, 'next.txt'), 'candidate data', 'utf8');
  return { root, source };
}

function run(root, source) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'prepare-release-data.mjs'), source, '--replace'], {
    cwd: root, encoding: 'utf8', env: { ...process.env },
  });
}

test('rejects malformed staged manifest before moving the current data', async () => {
  const { root, source } = await createSandbox('{ malformed');
  try {
    const result = run(root, source);

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /manifest|json/i);
    const previousData = await readFile(path.join(root, 'data', 'current.txt'), 'utf8').catch(() => null);
    assert.equal(previousData, 'previous verified data');
    assert.equal((await readdir(root)).some((name) => name.startsWith('_backups')), false);
    assert.equal((await readdir(root)).some((name) => name.startsWith('.release-data-restore-')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
