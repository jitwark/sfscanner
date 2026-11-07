import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHORITATIVE_DOCS } from './check-scanner-source-claims.mjs';

const ROOT = resolve(import.meta.dirname, '..');
// Reuse the community shipped-doc authority instead of a second, narrower list. Both modules guard
// `main()` on `process.argv[1]`, so importing the exported list is side-effect free. DOC_SCOPE adds
// the consumer-facing docs that authority does not carry; it never removes one.
export const ROOT_DOCS = Object.freeze([
  'README.md',
  'packages/scanner-cli/README.md',
  'docs/CLI.md',
  'docs/scanner/cli-v2.md',
  'docs/scanner/generated/cli.md',
]);
export const DOC_SCOPE = Object.freeze([...new Set([...AUTHORITATIVE_DOCS, ...ROOT_DOCS])]);
const MAX_BYTES = 1_048_576;

// Each pattern states the shipped behavior, not a phrase list: an affirmative claim that contradicts
// the binary or leaks a private location. A documented negative ("require is not supported") cannot
// match an affirmative pattern, which is why the negation is tested by REQUIRED below.
export const FORBIDDEN = Object.freeze([
  { pattern: /Default:\s*`?HIGH`?/u, message: 'default fail-on is INFO' },
  { pattern: /`?beta-hardened`?\s+(?:adds|runs|parses|tracks|executes|includes)\b/iu, message: 'unadmitted profile capability is promised' },
  { pattern: /`?beta-hardened`?\s+keeps\b[^\n]{0,120}\badds\b/iu, message: 'unadmitted profile capability is promised' },
  { pattern: /`?beta-hardened`?-only\s+(?:active|enabled|available|selectable)\b/iu, message: 'unadmitted profile is described as active' },
  { pattern: /\b(?:CJS|CommonJS)\s+(?:is|are)\s+(?:also\s+)?(?:fully\s+)?(?:supported|available)\b/iu, message: 'the package ships no CommonJS surface' },
  { pattern: /\brequire\(\s*['"]sfscanner['"]\s*\)\s+(?:also\s+)?(?:works|is\s+supported|is\s+available)\b/iu, message: 'require() is unsupported; the package is ESM-only' },
  { pattern: /d:\/projects\//iu, message: 'private absolute local path' },
  { pattern: /\b[A-Za-z]:\\+projects\\+/iu, message: 'private absolute local path' },
  { pattern: /github\.com\/jitwark\/n8n-community/iu, message: 'private clone URL' },
  { pattern: /\/absolute\/path\/to\b/iu, message: 'absolute example path instead of an install path' },
  { pattern: /\.\/node_modules\/sfscanner\/dist\/mcp\.js/u, message: 'MCP example is working-directory relative; use the installed module path' },
  { pattern: /absolute form is refused/iu, message: 'absolute inputs are admitted in v2' },
  { pattern: /must be a \*\*local relative path\*\*/iu, message: 'v2 admits absolute inputs; only metadata paths stay relative' },
  { pattern: /Deep scan also adds/iu, message: 'unadmitted deep scan is promised' },
]);

export const REQUIRED = Object.freeze([
  { file: 'packages/scanner-cli/README.md', pattern: /ESM-only/u, message: 'module support statement is missing' },
  { file: 'packages/scanner-cli/README.md', pattern: /Default: `INFO`/u, message: 'fail-on default is not INFO' },
  { file: 'packages/scanner-cli/README.md', pattern: /require\(\s*['"]sfscanner['"]\s*\)`?\s+is not supported/u, message: 'unsupported require() is not stated' },
  { file: 'packages/scanner-cli/README.md', pattern: /no CommonJS artifact is shipped/u, message: 'shipped CommonJS absence is not stated' },
  { file: 'packages/scanner-cli/README.md', pattern: /<npm-root>\/sfscanner\/dist\/mcp\.js/u, message: 'MCP example is not the installed module path' },
  { file: 'packages/scanner-cli/README.md', pattern: /npm root -g/u, message: '<npm-root> is not defined' },
  { file: 'docs/scanner/cli-v2.md', pattern: /local\s+absolute\s+path/u, message: 'absolute-input admission is not documented' },
  { file: 'README.md', pattern: /--schema v2 scan \.n8n --format sarif/u, message: 'CI directory example does not use --schema v2' },
  { file: 'docs/scanner/contracts-v2.md', pattern: /`DORMANT` \(2\)/u, message: 'limit-state classification is not documented' },
  { file: 'docs/scanner/contracts-v2.md', pattern: /MEASURED_LIMIT_IDS/u, message: 'measured-row basis is not documented' },
  { file: 'docs/CLI.md', pattern: /Validate locations with your SARIF consumer/u, message: 'SARIF upload claim is unconditional' },
  { file: 'README.md', pattern: /beta-hardened[\s\S]{0,320}not\s+admitted/u, message: 'hardened profile admission state is missing' },
  { file: 'docs/scanner/threat-model.md', pattern: /beta-hardened[\s\S]{0,320}not\s+admitted/u, message: 'hardened profile admission state is missing' },
  { file: 'docs/scanner/limitations.md', pattern: /beta-hardened[\s\S]{0,320}not\s+admitted/u, message: 'hardened profile admission state is missing' },
]);

const SARIF_SCAN = /\b(?:sfscanner|n8n-scan)\b[^\n]*\bscan\b[^\n]*--format[= ]sarif/u;

function lineAt(text, index) { return text.slice(0, index).split('\n').length; }

// A directory scan example is only true on v2. Single-document examples keep the v1 form, and
// `npm run scan:cli` drives the pipeline adapter, which is a different grammar.
export function scanExampleErrors(file, text) {
  const errors = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!SARIF_SCAN.test(line) || /npm run scan:cli/u.test(line)) continue;
    const after = line.replace(/^.*?\b(?:sfscanner|n8n-scan)\b/u, '').trim().split(/\s+/u);
    const target = after[after.indexOf('scan') + 1];
    if (after.includes('--schema') || !target || target === '-' || target.endsWith('.json')) continue;
    errors.push(`${file}:${index + 1}: directory scan example needs --schema v2`);
  }
  return errors;
}

export function auditScannerDocClaims(root = ROOT, options = {}) {
  const resolved = resolve(root);
  const documents = [...(options.documents ?? DOC_SCOPE)];
  const errors = [];
  for (const file of documents) {
    const absolute = resolve(resolved, file);
    if (!existsSync(absolute) || statSync(absolute).size > MAX_BYTES) {
      errors.push(`${file}:1: shipped document is missing or exceeds the ${MAX_BYTES}-byte read bound`);
      continue;
    }
    const text = readFileSync(absolute, 'utf8');
    for (const { pattern, message } of FORBIDDEN) {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
        errors.push(`${file}:${lineAt(text, match.index ?? 0)}: ${message}`);
      }
    }
    errors.push(...scanExampleErrors(file, text));
  }
  for (const { file, pattern, message } of REQUIRED) {
    const absolute = resolve(resolved, file);
    if (existsSync(absolute) && !pattern.test(readFileSync(absolute, 'utf8'))) errors.push(`${file}:1: ${message}`);
  }
  errors.sort();
  return { errors, documents };
}

function main() {
  const result = auditScannerDocClaims(ROOT);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(`check-scanner-doc-claims: ${result.documents.length} shipped documents clean.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
