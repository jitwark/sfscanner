/**
 * Enforces the app/pipeline one-way-import rule (P1.6, `scanner-contract-and-
 * calibration`). `contracts/` is the shared layer both may depend on; direct
 * `app/` <-> `pipeline/` imports are not.
 *
 * This is an allowlist, not a blanket ban: every current violation is real,
 * named, and was confirmed by direct inspection (P0.3's interface inventory,
 * extended here to catch the dynamic imports and dev script that inventory's
 * static grep missed). New violations fail the gate; fixing a listed one means
 * deleting its allowlist entry, not leaving it to rot as unclaimed slack.
 *
 * Usage: node scripts/check-import-boundary.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// [filePath, importedPath, reason] — importedPath is matched as a substring of
// the import specifier, so a partial path like '../app/src/scanner/engine' is
// enough to identify the exact statement being allowed.
const ALLOWED_PIPELINE_TO_APP = [
];

const ALLOWED_APP_TO_PIPELINE = [];

const IMPORT_RE = /(?:\b(?:from|import)\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\))/g;

export function extractImportSpecifiers(source) {
  return [...source.matchAll(IMPORT_RE)].map((match) => match[1] ?? match[2]);
}

function listFiles(dir, exclude) {
  const out = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (exclude.some((pattern) => pattern.test(item.name))) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...listFiles(full, exclude));
    else if (/\.(ts|tsx)$/.test(item.name) && !item.name.endsWith('.test.ts') && !item.name.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

function findViolations(files, targetPrefix, allowed) {
  const violations = [];
  for (const file of files) {
    const relFile = path.relative(root, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    for (const spec of extractImportSpecifiers(text)) {
      if (!spec.includes(targetPrefix)) continue;
      const isAllowed = allowed.some(([f, imp]) => f === relFile && spec.includes(imp));
      if (!isAllowed) violations.push(`${relFile}: imports '${spec}'`);
    }
  }
  return violations;
}

function findStaleAllowlistEntries(files, allowed) {
  const stale = [];
  for (const [relFile, importedPath] of allowed) {
    const absFile = path.join(root, relFile);
    if (!fs.existsSync(absFile)) { stale.push(`${relFile}: file no longer exists`); continue; }
    const text = fs.readFileSync(absFile, 'utf8');
    const stillImports = extractImportSpecifiers(text).some((spec) => spec.includes(importedPath));
    if (!stillImports) stale.push(`${relFile}: no longer imports '${importedPath}' — remove this allowlist entry`);
  }
  void files;
  return stale;
}

const appFiles = listFiles(path.join(root, 'app', 'src'), [/^__fixtures__$/, /^node_modules$/]);
const pipelineFiles = listFiles(path.join(root, 'pipeline'), [/^__fixtures__$/, /^node_modules$/, /^\.work$/]);

const appToPipeline = findViolations(appFiles, '/pipeline/', ALLOWED_APP_TO_PIPELINE);
// Pipeline's tsconfig maps `@/*` to `../app/*`, so an alias import is just as
// much a pipeline→app dependency as a relative `../../app/src/...` import.
const pipelineToApp = [
  ...findViolations(pipelineFiles, '/app/src/', ALLOWED_PIPELINE_TO_APP),
  ...findViolations(pipelineFiles, '@/src/', ALLOWED_PIPELINE_TO_APP),
];
const stale = [
  ...findStaleAllowlistEntries(appFiles, ALLOWED_APP_TO_PIPELINE),
  ...findStaleAllowlistEntries(pipelineFiles, ALLOWED_PIPELINE_TO_APP),
];

const problems = [...appToPipeline, ...pipelineToApp, ...stale];
if (problems.length > 0) {
  console.error('Import boundary gate failed:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  console.error(
    '\nA new app<->pipeline import needs either a contracts/ migration or an explicit,\n' +
      'reasoned allowlist entry in scripts/check-import-boundary.mjs — never a silent pass.',
  );
  process.exit(1);
}

console.log(
  `Import boundary gate passed (${appFiles.length} app files, ${pipelineFiles.length} pipeline files; ` +
    `${ALLOWED_APP_TO_PIPELINE.length} app->pipeline and ${ALLOWED_PIPELINE_TO_APP.length} pipeline->app allowlisted).`,
);
