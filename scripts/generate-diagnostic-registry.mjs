import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDiagnosticRegistry } from './lib/diagnostic-registry.mjs';
import { renderDiagnosticRegistryArtifacts } from './lib/diagnostic-registry-generators.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function readCommitted(root, path) {
  try {
    return readFileSync(resolve(root, path), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Writes the artifacts projected from the registry table, or with `--check` fails when a
 * committed artifact is missing or has drifted from it.
 */
export function generateDiagnosticRegistry(root = ROOT, { check = false } = {}) {
  const rendered = renderDiagnosticRegistryArtifacts(loadDiagnosticRegistry(root));
  const failures = [];
  for (const [path, text] of Object.entries(rendered)) {
    const current = readCommitted(root, path);
    if (check) {
      if (current === undefined) failures.push(`${path}: missing`);
      else if (current !== text) failures.push(`${path}: byte drift`);
    } else {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      writeFileSync(resolve(root, path), text, 'utf8');
    }
  }
  if (failures.length) throw new Error(`Diagnostic registry check failed: ${failures.join('; ')}`);
  return rendered;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check')) throw new Error('Usage: node scripts/generate-diagnostic-registry.mjs [--check]');
  const check = args.includes('--check');
  const output = generateDiagnosticRegistry(ROOT, { check });
  console.log(check
    ? `Diagnostic registry is reproducible: ${Object.keys(output).length} artifacts.`
    : `Generated ${Object.keys(output).join(', ')} from the diagnostic registry table.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
