import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedRuntimePackages, checkExports } from './lib/scanner-core-package-audit.mjs';
import { checkSource, collectSourceFiles } from './lib/scanner-core-source-audit.mjs';

const packageRelativePath = join('packages', 'scanner-core');

export function auditScannerCore(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const errors = [];
  const packageRoot = join(root, packageRelativePath);
  const packagePath = join(packageRoot, 'package.json');
  const packageJson = readJson(packagePath, errors, 'scanner-core package.json');
  if (!packageJson) return { errors, sourceFiles: [] };

  checkExports(packageRoot, packageJson.exports, errors);
  const declaredDependencies = new Set();
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dependency of Object.keys(packageJson[field] ?? {})) {
      if (!allowedRuntimePackages.has(dependency)) {
        errors.push(`runtime dependency is not allowed in scanner-core: ${dependency}`);
      } else {
        declaredDependencies.add(dependency);
      }
    }
  }

  const sourceFiles = collectSourceFiles(join(packageRoot, 'src'))
    .filter((file) => !/\.test-support\.[^.]+$/.test(file));
  if (sourceFiles.length === 0) errors.push('scanner-core source directory is missing or empty');
  for (const file of sourceFiles) checkSource(file, packageRoot, declaredDependencies, errors);
  return { errors, sourceFiles };
}

function readJson(file, errors, label) {
  if (!existsSync(file)) {
    errors.push(`${label} is missing: ${relative(process.cwd(), file)}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    errors.push(`${label} is not valid JSON`);
    return null;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditScannerCore();
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`scanner-core boundary: ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`scanner-core boundary passed (${result.sourceFiles.length} source file(s))`);
  }
}
