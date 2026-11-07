/**
 * ReDoS gate (P3.2). Extracts every regex the scanner can compile — literal
 * `/pattern/flags`, `new RegExp('string literal', flags)`, and the `body:`
 * string entries in provider-token-patterns.ts that `classifierPattern` and
 * `redactionPattern` wrap into a `RegExp` — from the scanner's non-test
 * source, and runs each pattern's source text through
 * `detectCatastrophicPatterns` (see regex-safety-detector.mjs). A workflow
 * pasted into the scanner is untrusted, attacker-controlled text with no
 * execution timeout in the Web Worker; one catastrophically-backtracking
 * pattern turns "paste a workflow" into "hang the tab".
 *
 * Scope matches check-scanner-import-boundary.mjs's scanner surface plus the
 * CLI package: app/src/scanner is the app-local adapter under migration onto
 * @hub/scanner-core and shares its rule surface. `app/src/workflow` held the
 * app-local parser until packet 5.2c deleted it (scanner-core is now the only
 * parser authority); the entry stays so a reintroduced layer is still scanned.
 *
 * Usage: node scripts/check-regex-safety.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectCatastrophicPatterns } from './regex-safety-detector.mjs';

const ROOT_DIRECTORIES = Object.freeze([
  'packages/scanner-core/src',
  'packages/scanner-cli/src',
  'app/src/scanner',
  'app/src/workflow',
]);
// .tsx excluded: verified zero regex usage in this scope's JSX components, and
// this tokenizer cannot tell a `</tag>` slash from a regex literal.
const SOURCE_EXTENSIONS = new Set(['.ts', '.mjs', '.cjs', '.js']);

function isTestOrFixture(relativePath) {
  const filename = relativePath.split('/').at(-1) ?? '';
  return relativePath.split('/').some((part) => part === '__fixtures__' || part === 'fixtures')
    || /\.(?:test|spec)\.[^.]+$/.test(filename);
}

function collectFiles(directory, root, files) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) { collectFiles(full, root, files); continue; }
    const relativePath = relative(root, full).replace(/\\/g, '/');
    if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !isTestOrFixture(relativePath)) files.push(full);
  }
}

export function collectScannerSourceFiles(root) {
  const files = [];
  for (const directory of ROOT_DIRECTORIES) collectFiles(join(root, directory), root, files);
  return files.sort();
}

// Division-vs-regex-literal disambiguation: a `/` starts a regex unless the
// previous significant token was a value (identifier/number/string/`)`/`]`),
// in which case it is division. `return`, `typeof`, and friends are keywords,
// not values, so `return /x/` still reads as a regex — same rule engines use.
const VALUE_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

function extractLiterals(source) {
  const found = [];
  let i = 0;
  let prevToken = '';
  let prevIsValue = false;
  const lineAt = (index) => source.slice(0, index).split('\n').length;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') { const end = source.indexOf('\n', i); i = end === -1 ? source.length : end; continue; }
    if (ch === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 2; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch; let j = i + 1;
      while (j < source.length && source[j] !== quote) j += source[j] === '\\' ? 2 : 1;
      i = j + 1; prevToken = quote; prevIsValue = true; continue;
    }
    if (ch === '`') {
      let j = i + 1; let depth = 0;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '`' && depth === 0) { j += 1; break; }
        if (source[j] === '$' && source[j + 1] === '{') { depth += 1; j += 2; continue; }
        if (source[j] === '}' && depth > 0) { depth -= 1; j += 1; continue; }
        j += 1;
      }
      i = j; prevToken = '`'; prevIsValue = true; continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i; while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
      const word = source.slice(i, j); i = j;
      prevToken = word; prevIsValue = !VALUE_KEYWORDS.has(word); continue;
    }
    if (ch === '/') {
      if (prevIsValue || prevToken === ')' || prevToken === ']' || prevToken === '}') { i += 1; prevToken = '/'; prevIsValue = false; continue; }
      let j = i + 1; let inClass = false; let closed = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') break;
        if (c === '[') { inClass = true; j += 1; continue; }
        if (c === ']') { inClass = false; j += 1; continue; }
        if (c === '/' && !inClass) { closed = true; j += 1; break; }
        j += 1;
      }
      if (closed) {
        let k = j; while (k < source.length && /[a-z]/i.test(source[k])) k += 1;
        found.push({ line: lineAt(i), pattern: source.slice(i + 1, j - 1), flags: source.slice(j, k), kind: 'literal' });
        i = k; prevToken = ')'; prevIsValue = true; continue;
      }
      i += 1; prevToken = '/'; continue;
    }
    if (!/\s/.test(ch)) { prevToken = ch; prevIsValue = false; }
    i += 1;
  }
  return found;
}

const STRING_LITERAL = "(['\"])((?:\\\\.|(?!\\1).)*)\\1";
const NEW_REGEXP_RE = new RegExp(`\\bnew\\s+RegExp\\(\\s*${STRING_LITERAL}(?:\\s*,\\s*${STRING_LITERAL})?\\s*\\)`, 'g');
const BODY_LITERAL_RE = new RegExp(`\\bbody\\s*:\\s*${STRING_LITERAL}`, 'g');
const FLAGS_LITERAL_RE = new RegExp(`\\bflags\\s*:\\s*${STRING_LITERAL}`);

function unescape(text) { return text.replace(/\\(.)/g, '$1'); }
function lineAt(source, index) { return source.slice(0, index).split('\n').length; }

function extractNewRegExpCalls(source) {
  return [...source.matchAll(NEW_REGEXP_RE)].map((match) => ({
    line: lineAt(source, match.index ?? 0),
    pattern: unescape(match[2]),
    flags: match[4] !== undefined ? unescape(match[4]) : '',
    kind: 'new RegExp',
  }));
}

// Provider-token-pattern-shaped object literals (`{ body: '...', flags: '...' }`)
// get compiled through classifierPattern/redactionPattern in provider-token-patterns.ts —
// the `body:` string is a regex source even though it never appears inside `/.../`.
function extractBodyLiterals(source) {
  return [...source.matchAll(BODY_LITERAL_RE)].map((match) => {
    const tail = source.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 300);
    const flagsMatch = FLAGS_LITERAL_RE.exec(tail.slice(0, tail.indexOf('}') === -1 ? tail.length : tail.indexOf('}') + 1));
    return {
      line: lineAt(source, match.index ?? 0),
      pattern: unescape(match[2]),
      flags: flagsMatch ? unescape(flagsMatch[2]) : '',
      kind: 'body',
    };
  });
}

/** Every regex source (literal, `new RegExp`, provider-token `body:`) in a single file's text, in source order. Line 1 is skipped when it is a `#!` shebang — not valid JS to a regex literal but matched divide-then-regex by the tokenizer above. */
export function extractRegexCandidates(source, file) {
  const withoutShebang = source.startsWith('#!') ? `//${source.slice(2)}` : source;
  const all = [
    ...extractLiterals(withoutShebang),
    ...extractNewRegExpCalls(withoutShebang),
    ...extractBodyLiterals(withoutShebang),
  ];
  return all
    .map((candidate) => ({ file, line: candidate.line, pattern: candidate.pattern, flags: candidate.flags, kind: candidate.kind }))
    .sort((a, b) => a.line - b.line);
}

export function findRegexSafetyViolations(root) {
  const absoluteRoot = resolve(root);
  const violations = [];
  for (const file of collectScannerSourceFiles(absoluteRoot)) {
    const relativeFile = relative(absoluteRoot, file).replace(/\\/g, '/');
    const source = readFileSync(file, 'utf8');
    for (const candidate of extractRegexCandidates(source, relativeFile)) {
      const reasons = detectCatastrophicPatterns(candidate.pattern);
      if (reasons.length > 0) violations.push({ ...candidate, reasons });
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function countRegexCandidates(root) {
  const absoluteRoot = resolve(root);
  let total = 0;
  for (const file of collectScannerSourceFiles(absoluteRoot)) {
    total += extractRegexCandidates(readFileSync(file, 'utf8'), file).length;
  }
  return total;
}

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = findRegexSafetyViolations(projectRoot);
  const total = countRegexCandidates(projectRoot);
  if (violations.length > 0) {
    console.error(`Regex safety gate failed: ${violations.length} catastrophically-backtracking pattern(s) found:`);
    for (const v of violations) console.error(`  - ${v.file}:${v.line} [${v.kind}] /${v.pattern}/${v.flags}\n    ${v.reasons.join('\n    ')}`);
    process.exitCode = 1;
  } else {
    console.log(`Regex safety gate passed (${total} regex source(s) checked across ${collectScannerSourceFiles(projectRoot).length} file(s); 0 catastrophic-backtracking patterns).`);
  }
}
