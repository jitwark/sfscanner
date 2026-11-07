import fs from 'node:fs';
import path from 'node:path';
import { listFilesRecursively } from './lib/walk.mjs';
import { validateSpecPackage } from './lib/spec-validate.mjs';

const root = process.cwd();
const changesDir = path.join(root, 'openspec', 'changes');

if (!fs.existsSync(changesDir)) {
  console.error(`Specification gate failed: ${path.relative(root, changesDir)} does not exist.`);
  process.exit(1);
}

const activeChangeIds = fs
  .readdirSync(changesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
  .map((entry) => entry.name)
  .sort();

if (activeChangeIds.length === 0) {
  console.error('Specification gate failed: no active openspec/changes/<id> packages found.');
  process.exit(1);
}

const errors = [];
const warnings = [];

for (const id of activeChangeIds) {
  const changeRoot = path.join(changesDir, id);
  const files = (await listFilesRecursively(changeRoot))
    .filter((relativePath) => relativePath.endsWith('.md'))
    .map((relativePath) => ({
      path: relativePath,
      lines: fs.readFileSync(path.join(changeRoot, relativePath), 'utf8').split(/\r?\n/).length,
    }));

  const result = validateSpecPackage({ id, files });
  errors.push(...result.errors);
  warnings.push(...result.warnings);
}

for (const warning of warnings) {
  console.log(`warning: ${warning}`);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`error: ${error}`);
  }
  console.error(`\n${errors.length} spec violation(s) across ${activeChangeIds.length} active package(s).`);
  process.exit(1);
}

console.log(`Specification gate passed (${activeChangeIds.length} active package(s), 0 violations).`);
