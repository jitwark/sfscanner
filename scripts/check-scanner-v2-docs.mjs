import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { computeSourceDigest, GENERATED_DOCS, loadScannerReferenceSources, renderScannerReference, REFERENCE_SCHEMA_VERSION } from './lib/scanner-reference-generators.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = 'docs/scanner/generated';
const GROUPS = Object.freeze({ rules: 'rules.md', diagnostics: 'diagnostics.md', limits: 'limits.md', schemas: 'schemas.md', cli: 'cli.md', examples: 'examples.md' });

function readDocs(root) {
  const docs = {};
  for (const name of GENERATED_DOCS) {
    try { docs[name] = readFileSync(resolve(root, OUTPUT, name), 'utf8'); }
    catch { /* reported below */ }
  }
  return docs;
}
function metadata(content, name, errors) {
  if (typeof content !== 'string') { errors.push(`${name}: missing generated file`); return undefined; }
  if (content.includes('\r')) errors.push(`${name}: output must use LF line endings`);
  if (!content.startsWith('# ') || !content.includes('DO NOT EDIT')) errors.push(`${name}: generated do-not-edit header is missing`);
  const version = content.match(/scanner-reference:version=([^\s]+)\s*-->/)?.[1];
  const sourceText = content.match(/scanner-reference:sources=([^\s]+)\s*-->/)?.[1];
  const sourceDigest = content.match(/scanner-reference:digest=([^\s]+)\s*-->/)?.[1];
  if (version !== REFERENCE_SCHEMA_VERSION) errors.push(`${name}: invalid reference schema version`);
  if (!sourceText || !sourceDigest) { errors.push(`${name}: source metadata is missing`); return undefined; }
  const sources = sourceText.split(',').filter(Boolean);
  if (!sources.length || !/^[0-9a-f]{64}$/.test(sourceDigest)) errors.push(`${name}: invalid source metadata`);
  return { sources, digest: sourceDigest };
}
function linkErrors(root, name, content, errors) {
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#', 1)[0];
    if (!target) continue;
    if (/^(?:\/|\\\\|[A-Za-z]:)/.test(target)) { errors.push(`${name}: generated link is an absolute path: ${target}`); continue; }
    if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    try { readFileSync(resolve(root, 'docs/scanner/generated', target)); }
    catch { errors.push(`${name}: generated link does not resolve: ${target}`); }
  }
  for (const match of content.matchAll(/`([^`]+)`/g)) {
    const target = match[1];
    if (/^(?:\/|\\\\|[A-Za-z]:)/.test(target)) { errors.push(`${name}: generated output contains an absolute path: ${target}`); continue; }
    if (!/^(?:packages|contracts|schemas|examples)\//.test(target)) continue;
    try { readFileSync(resolve(root, target)); }
    catch { errors.push(`${name}: generated path does not resolve: ${target}`); }
  }
}
function safeErrors(name, content, errors) {
  if (/(?:[A-Z]:\\|\\\\|\/(?:Users|home|private|mnt)\b|(?:password|secret|token|api[_-]?key|credential|authorization|cookie|bearer)\s*[:=]\s*['"][^'"]+)/i.test(content)) errors.push(`${name}: generated output contains a private path or secret-like value`);
}

export function auditScannerV2Docs(root = ROOT, options = {}) {
  const resolved = resolve(root);
  const errors = [];
  let model;
  try { model = loadScannerReferenceSources(resolved); }
  catch (error) { errors.push(`scanner reference source is invalid: ${error instanceof Error ? error.message : String(error)}`); return { errors, docs: options.docs ?? {}, expected: undefined }; }
  const docs = options.docs ?? readDocs(resolved);
  const expected = renderScannerReference(model);
  for (const name of Object.keys(docs)) if (!GENERATED_DOCS.includes(name)) errors.push(`generated docs contain unsupported file: ${name}`);
  const entriesByGroup = model.sources;
  for (const name of GENERATED_DOCS) {
    const content = docs[name];
    const meta = metadata(content, name, errors);
    if (!content || !meta) continue;
    const group = Object.entries(GROUPS).find(([, file]) => file === name)?.[0];
    const entries = group ? entriesByGroup[group] : undefined;
    if (!entries) { errors.push(`${name}: no source group registered`); continue; }
    const paths = entries.map(({ path }) => path);
    if (JSON.stringify(meta.sources) !== JSON.stringify(paths)) errors.push(`${name}: source list differs from generator authority`);
    if (meta.digest !== computeSourceDigest(entries)) errors.push(`${name}: source digest mismatch`);
    if (content !== expected[name]) errors.push(`${name}: byte drift; regenerate scanner reference docs`);
    linkErrors(resolved, name, content, errors);
    safeErrors(name, content, errors);
  }
  try {
    const actual = readdirSync(resolve(resolved, OUTPUT)).sort();
    for (const name of actual) if (!GENERATED_DOCS.includes(name)) errors.push(`generated directory contains unsupported file: ${name}`);
  } catch { errors.push('generated directory is missing'); }
  return { errors, docs, expected };
}

function main() {
  const result = auditScannerV2Docs();
  if (result.errors.length) { console.error(`Scanner v2 generated docs failed (${result.errors.length} error(s))`); for (const error of result.errors) console.error(`- ${error}`); process.exitCode = 1; }
  else console.log(`Scanner v2 generated docs passed: ${GENERATED_DOCS.length} files.`);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
