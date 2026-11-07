import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { GENERATED_DOCS, loadScannerReferenceSources, renderScannerReference } from './lib/scanner-reference-generators.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = 'docs/scanner/generated';

function readCommitted(root, name) {
  try { return readFileSync(resolve(root, OUTPUT, name), 'utf8'); }
  catch { return undefined; }
}

export function generateScannerReference(root = ROOT, { check = false } = {}) {
  const model = loadScannerReferenceSources(root);
  const rendered = renderScannerReference(model);
  const failures = [];
  for (const name of GENERATED_DOCS) {
    const current = readCommitted(root, name);
    if (check) {
      if (current === undefined) failures.push(`${name}: missing`);
      else if (current !== rendered[name]) failures.push(`${name}: byte drift`);
    } else {
      mkdirSync(resolve(root, OUTPUT), { recursive: true });
      writeFileSync(resolve(root, OUTPUT, name), rendered[name], 'utf8');
    }
  }
  if (failures.length) throw new Error(`Scanner reference check failed: ${failures.join('; ')}`);
  return rendered;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check')) throw new Error('Usage: node scripts/generate-scanner-reference.mjs [--check]');
  const check = args.includes('--check');
  const output = generateScannerReference(ROOT, { check });
  console.log(check ? `Scanner reference is reproducible: ${GENERATED_DOCS.length} files.` : `Generated ${Object.keys(output).length} scanner reference files.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
