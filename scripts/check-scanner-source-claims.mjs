import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditScannerV2Docs } from './check-scanner-v2-docs.mjs';

const ROOT = resolve(import.meta.dirname, '..');
export const AUTHORITATIVE_DOCS = Object.freeze([
  'docs/scanner/README.md', 'docs/scanner/architecture-v2.md', 'docs/scanner/contracts-v2.md',
  'docs/scanner/normalization-v2.md', 'docs/scanner/semantic-catalogue.md', 'docs/scanner/migration-v1-v2.md',
  'docs/scanner/rule-authoring-v2.md', 'docs/scanner/security-and-disclosure.md', 'docs/scanner/release-runbook.md',
  'docs/scanner/key-rotation.md', 'docs/scanner/deprecation.md', 'docs/scanner/limitations.md', 'docs/scanner/threat-model.md',
]);
export const GENERATED_DOCS = Object.freeze(['rules.md', 'diagnostics.md', 'limits.md', 'schemas.md', 'cli.md', 'examples.md']);
const PATH_TOKEN = /^(?:\.\.?\/|(?:packages|contracts|schemas|examples|docs|scripts|app|pipeline|data)\/)/;
const METADATA_LABELS = ['Status', 'Last verified', 'Owner', 'Source of truth'];
const MAX_READ_BYTES = 1_048_576;

function lineAt(text, index) { return text.slice(0, index).split('\n').length; }
function add(errors, file, line, message) { errors.push(`${file}:${line}: ${message}`); }
function readBounded(root, file, errors, line = 1) {
  const absolute = resolve(root, file);
  try {
    if (statSync(absolute).size > MAX_READ_BYTES) { add(errors, file, line, `file exceeds ${MAX_READ_BYTES}-byte read bound`); return undefined; }
    return readFileSync(absolute, 'utf8');
  } catch { add(errors, file, line, 'authoritative document is missing'); return undefined; }
}
function fields(text, label) {
  const result = [];
  const lines = text.split('\n').slice(0, 12);
  for (const [index, line] of lines.entries()) {
    const marker = new RegExp(`(?:^|>\\s*|\\s)${label}:\\s*`, 'i').exec(line);
    if (!marker) continue;
    const start = (marker.index ?? 0) + marker[0].length;
    const rest = line.slice(start);
    const next = new RegExp(`\\s+(?:${METADATA_LABELS.filter((item) => item !== label).join('|')}):`, 'i').exec(rest);
    result.push({ value: (next ? rest.slice(0, next.index) : rest).trim(), line: index + 1 });
  }
  return result;
}
function slug(value) {
  return value.replace(/<[^>]*>/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}
function headingSlugs(text) { return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1].trim()))); }
function localTarget(root, file, raw, errors, line, rootRelative = false) {
  let target = raw.trim().split(/\s+/)[0].replace(/^<|>$/g, '');
  let fragment = '';
  try { target = decodeURIComponent(target); } catch { add(errors, file, line, `malformed link target: ${raw}`); return; }
  const hash = target.indexOf('#');
  if (hash >= 0) { fragment = target.slice(hash + 1); target = target.slice(0, hash); }
  if (!target) { if (fragment) { const current = readBounded(root, file, errors, line) ?? ''; if (!headingSlugs(current).has(slug(fragment))) add(errors, file, line, `missing anchor #${fragment}`); } return; }
  if (/^(?:[\\/]|[A-Za-z]:)/.test(target) || /^file:/i.test(target)) { add(errors, file, line, `absolute link path is forbidden: ${raw}`); return; }
  if (/(?:^|\/)archives?(?:\/|$)/i.test(target)) { add(errors, file, line, `archive link is forbidden for active docs: ${raw}`); return; }
  if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) return;
  if (!existsSync(resolve(root, 'openspec')) && (target.includes('openspec/') || target.includes('/audit/') || target.includes('/plans/'))) return;
  const candidate = resolve(rootRelative ? root : dirname(resolve(root, file)), target);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${requireSep()}`)) { add(errors, file, line, `link traversal escapes repository root: ${raw}`); return; }
  if (!existsSync(candidate)) { add(errors, file, line, `link target does not resolve: ${raw}`); return; }
  if (fragment) {
    const targetText = readBounded(root, candidate, errors, line) ?? '';
    if (!headingSlugs(targetText).has(slug(fragment))) add(errors, file, line, `anchor does not resolve: ${raw}`);
  }
}
function requireSep() { return process.platform === 'win32' ? '\\' : '/'; }
function auditLinks(root, file, text, errors) {
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) localTarget(root, file, match[1], errors, lineAt(text, match.index ?? 0));
  const sources = fields(text, 'Source of truth');
  for (const { value, line } of sources) {
    const tokens = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter((token) => PATH_TOKEN.test(token));
    const links = [...value.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)];
    if (!links.length && !tokens.length) add(errors, file, line, 'Source of truth has no local path reference');
    links.forEach((match) => localTarget(root, file, match[1], errors, line));
    tokens.forEach((token) => localTarget(root, file, token, errors, line, true));
  }
}
function placeholder(text) { return text.split('\n').map((line) => /\b(?:TODO|FIXME|TBD|WIP|PLACEHOLDER|COMING SOON)\b/i.test(line)); }
function dummyHash(text) { return text.split('\n').map((line) => /\b(?:0{64}|deadbeef){1,8}\b|YYYY-MM-DD/i.test(line)); }
function secret(text) { return text.split('\n').map((line) => /(?:password|passphrase|api[_-]?key|access[_-]?token|secret|credential|authorization|bearer)\s*[:=]\s*(?:"[^"]+"|'[^']+'|[A-Za-z0-9+/=_-]{6,})/i.test(line)); }
function unauthorizedClaim(text) {
  const gate = /\b(?:external\s+CI|CI|owner|legal|deployment|publication|release|signing|SARIF|TestSprite|certif(?:y|ied|ication))\b/i;
  const positive = /\b(?:passed|pass|successful|succeeded|approved|completed|complete|verified|green|published|deployed|certified|ready for deployment)\b/i;
  const negative = /\b(?:not|no|never|pending|deferred|unavailable|requires?|without|did not|does not|out of scope|unperformed|unpublished|private|HUMAN_REQUIRED|NOT READY|required|must|before|after|until|candidate|procedure|disposition|outside|local worktree|local evidence)\b/i;
  return text.split('\n').map((line, index, lines) => {
    const context = lines.slice(Math.max(0, index - 2), index + 1).join(' ');
    return gate.test(line) && positive.test(line) && !negative.test(context);
  });
}

export function auditScannerSourceClaims(root = ROOT, options = {}) {
  const resolved = resolve(root); const errors = [];
  const documents = options.documents ?? AUTHORITATIVE_DOCS;
  for (const file of documents) {
    const text = readBounded(resolved, file, errors);
    if (text === undefined) continue;
    const required = ['Status', 'Last verified', 'Owner', 'Source of truth'];
    for (const label of required) {
      const matches = fields(text, label);
      if (matches.length !== 1 || !matches[0].value) add(errors, file, matches[0]?.line ?? 1, `${label} metadata is missing or malformed`);
    }
    auditLinks(resolved, file, text, errors);
    for (const [index, flagged] of placeholder(text).entries()) if (flagged) add(errors, file, index + 1, 'placeholder token is present');
    for (const [index, flagged] of dummyHash(text).entries()) if (flagged) add(errors, file, index + 1, 'dummy hash is present');
    for (const [index, flagged] of secret(text).entries()) if (flagged) add(errors, file, index + 1, 'secret-like value is present');
    for (const [index, flagged] of unauthorizedClaim(text).entries()) if (flagged) add(errors, file, index + 1, 'unauthorized external-gate success/publication claim');
  }
  if (options.checkGenerated !== false) {
    const generated = auditScannerV2Docs(resolved, options.generatedDocs ? { docs: options.generatedDocs } : {});
    for (const message of generated.errors) {
      const name = message.match(/^([^:]+\.md):/)?.[1] ?? 'generated';
      add(errors, `docs/scanner/generated/${name}`, 1, message.replace(`${name}: `, ''));
    }
    try {
      for (const name of readdirSync(resolve(resolved, 'docs/scanner/generated'))) if (!GENERATED_DOCS.includes(name)) add(errors, `docs/scanner/generated/${name}`, 1, 'unsupported generated file');
    } catch { add(errors, 'docs/scanner/generated', 1, 'generated directory is missing'); }
  }
  errors.sort();
  return { errors, documents };
}

function main() {
  const result = auditScannerSourceClaims();
  if (result.errors.length) { console.error(`Scanner source claims failed (${result.errors.length} error(s))`); result.errors.forEach((error) => console.error(`- ${error}`)); process.exitCode = 1; }
  else console.log(`Scanner source claims passed: ${result.documents.length} authoritative documents.`);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
