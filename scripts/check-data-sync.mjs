import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(process.argv[2] || join(root, 'data'));
const destination = resolve(process.argv[3] || join(root, 'app', 'public', 'data'));

async function filesUnder(directory, prefix = '') {
  const result = new Map();
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const rel = join(prefix, item.name);
    const absolute = join(directory, item.name);
    if (item.isDirectory()) {
      for (const [child, hash] of await filesUnder(absolute, rel)) result.set(child, hash);
    } else {
      const bytes = await readFile(absolute);
      result.set(rel, createHash('sha256').update(bytes).digest('hex'));
    }
  }
  return result;
}

const [sourceExists, destinationExists] = await Promise.all([stat(source).catch(() => null), stat(destination).catch(() => null)]);
if (!sourceExists?.isDirectory() || !destinationExists?.isDirectory()) {
  console.error(`Data sync failed: both directories must exist (${source} and ${destination}).`);
  process.exit(1);
}
const [left, right] = await Promise.all([filesUnder(source), filesUnder(destination)]);
const manifestPath = join(source, 'manifest.json');
let expectedNames;
try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  expectedNames = new Set([...(manifest.artifacts ?? []).map((artifact) => artifact.path.replace(/\\/g, '/')), 'manifest.json']);
} catch (error) {
  console.error(`Data sync failed: ${manifestPath} is missing or invalid (${error instanceof Error ? error.message : String(error)}).`);
  process.exit(1);
}
for (const [label, files] of [['source', left], ['destination', right]]) {
  const normalizedNames = new Set([...files.keys()].map((name) => name.replace(/\\/g, '/')));
  const extras = [...normalizedNames].filter((name) => !expectedNames.has(name));
  const missing = [...expectedNames].filter((name) => !normalizedNames.has(name));
  if (extras.length || missing.length) {
    console.error(`Data sync failed: ${label} does not match manifest ownership.`);
    for (const name of extras.slice(0, 20)) console.error(`- extra ${name}`);
    for (const name of missing.slice(0, 20)) console.error(`- missing ${name}`);
    process.exit(1);
  }
}
const names = new Set([...left.keys(), ...right.keys()]);
const differences = [...names].filter((name) => left.get(name) !== right.get(name));
if (differences.length > 0) {
  console.error(`Data sync failed: ${differences.length} file(s) differ.`);
  for (const name of differences.slice(0, 20)) console.error(`- ${relative(root, join(source, name))}`);
  process.exit(1);
}
console.log(`Data sync passed: ${left.size} files match byte-for-byte.`);
