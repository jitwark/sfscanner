import { cp, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const fail = (message) => { throw new Error(message); };
const exists = async (file) => lstat(file).catch(() => null);

async function readManifest(file, label) {
  const info = await exists(file);
  if (!info) fail(`${label} is missing`);
  if (!info.isFile()) fail(`${label} must be a regular file`);
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must contain a JSON object`);
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.includes('must contain')) throw error;
    fail(`${label} is not valid JSON`);
  }
}

async function validateTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`release data contains a symlink: ${entry.name}`);
    if (entry.isDirectory()) await validateTree(child);
    else if (!entry.isFile()) fail(`release data contains an unsupported filesystem entry: ${entry.name}`);
  }
}

export async function promoteStagedData({ root, staging, target, replace, backup, move = rename }) {
  const current = await exists(target);
  if (current) {
    if (current.isSymbolicLink()) fail('existing data/ is a symlink; refusing to replace it');
    if (!current.isDirectory()) fail('existing data/ is not a directory; refusing to replace it');
    if (!replace) fail(`data/ already exists. Pass --replace only when a rollback backup is intended: ${target}`);
  }

  let movedCurrent = false;
  try {
    if (current) {
      await mkdir(join(root, '_backups'), { recursive: true });
      await move(target, backup);
      movedCurrent = true;
    }
    await move(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (movedCurrent && !(await exists(target))) {
      try { await move(backup, target); } catch (restoreError) {
        throw new Error(`release data promotion failed and previous data restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
    }
    throw new Error(`release data promotion failed; previous data restored: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const root = resolve(import.meta.dirname, '..');
  const sourceInput = process.argv[2] || process.env.COMMUNITY_HUB_RELEASE_DATA || '';
  const source = sourceInput ? resolve(sourceInput) : '';
  const target = join(root, 'data');
  const replace = process.argv.includes('--replace');
  const sourceInfo = source && await exists(source);
  if (!source || source === root || !sourceInfo?.isDirectory()) fail('Release data restore requires a regular directory argument or COMMUNITY_HUB_RELEASE_DATA.');

  await readManifest(join(source, 'manifest.json'), `release data source manifest (${source})`);
  await validateTree(source);
  const staging = join(root, `.release-data-restore-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true });
    const manifest = await readManifest(join(staging, 'manifest.json'), 'staged release manifest');
    await validateTree(staging);
    const backup = join(root, '_backups', `community-hub-data-before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
    await promoteStagedData({ root, staging, target, replace, backup });
    console.log(`Restored release corpus ${manifest.metadata?.corpusId ?? 'unknown'} (${manifest.totalEntries} entries).`);
    if (await exists(backup)) console.log(`Moved existing data/ to ${backup}`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(`Release data restore refused: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
