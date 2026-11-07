import fs from 'node:fs';
import path from 'node:path';

// This script is intentionally self-contained: pipeline/sanitize/secret-patterns.ts
// is TypeScript and is not a safe Node-standard-library-only runtime dependency.
const SECRET_PATTERNS = [
  ['secret-pattern:openai-api-key', /(?<![A-Za-z0-9])sk-(?!ant-)[A-Za-z0-9_-]{20,}/g],
  ['secret-pattern:github-token', /(?:ghp|gho|ghu|github_pat|glpat)-?[A-Za-z0-9_]{12,}/g],
  ['secret-pattern:aws-access-key', /AKIA[0-9A-Z]{16}/g],
  ['secret-pattern:jwt-token', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['secret-pattern:basic-auth-url', /https?:\/\/[^\s:@]+:[^\s:@]+@[^\s/:]+/g],
  [
    'secret-pattern:generic-secret-assignment',
    /\b(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)\b\s*[:=]\s*(?:"[^"\r\n]{32,}"|'[^'\r\n]{32,}'|[A-Za-z0-9+/_=-]{32,})/gi,
  ],
];
const AUTHORIZATION_PATTERN = /\bAuthorization\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gi;
const CANARY_PATTERNS = [
  /canaryFakeSecretKey/gi,
  /canarySignature/gi,
  /canaryUser/gi,
  /canaryPass/gi,
  /sk-proj-canary/gi,
];
const TOKEN_LIKE_PATTERN = /[A-Za-z0-9][A-Za-z0-9+/_=-]{31,}[A-Za-z0-9]/g;
const PLACEHOLDER_PATTERNS = [
  /^YOUR_[A-Z0-9_]+_HERE$/,
  /^<redacted(?::[^>\r\n]*)?>$/i,
  /^\$\{[^}\r\n]{1,120}\}$/,
  /^REPLACE_ME$/,
];
const CREDENTIAL_FILENAME = /(?:^|[._-])(?:credential|credentials|secret|secrets|service-account|private[-_.]?key)(?:[._-]|$)/i;
const PRIVATE_KEY_EXTENSION = /\.(?:jks|key|keystore|pem|p12|pfx)$/i;
const DOCUMENT_EXTENSION = /\.(?:md|markdown|mdx|rst|txt)$/i;
const INTERNAL_DOCUMENT_PATH = /(?:^|\/)(?:docs\/(?:audit|legal|public-repository|recovery|research|superpowers)|openspec(?:\/changes)?)(?:\/|$)/i;
const INTERNAL_DOCUMENT_MARKERS = [
  /^\s*#.*\binternal\s+(?:audit|process|report)\b/i,
  /\bpre[- ]?decisional\b/i, /\b(?:confidential\s+(?:draft|report|memo|document|notes?|process)|internal[- ]only|internal use only)\b/i,
  /\bOWNER_TO_BE_CONFIRMED\b/i, /\b(?:active|incomplete)[- ]work ledger\b/i,
  /^\s*[-*]\s+\[(?: |b|!)\].*\b(?:open|blocked|pending|incomplete)\b/i,
];
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalPath(filePath) {
  return path.resolve(filePath).split(path.sep).join('/');
}
function isPlaceholder(value) {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function entropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function isHighEntropyToken(value) {
  return value.length >= 40 && new Set(value).size >= 12 && entropy(value) >= 4.1;
}

function isIntegrityHashValue(line, span, value) {
  if (!/^sha(?:256|384|512)-[A-Za-z0-9+/_=-]+$/i.test(value)) return false;
  return /\bintegrity\b["']?\s*[:=]\s*["']?\s*$/i.test(line.slice(0, span.start));
}

function hasSensitiveAssignmentContext(line) {
  return /\b(?:api[_-]?key|secret|password|passwd|token|bearer|authorization|credential|private[_-]?key|value)\b\s*[:=]/i.test(line)
    || /\b(?:Bearer|Basic|Token)\s+/i.test(line);
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

function findMatches(pattern, line) {
  pattern.lastIndex = 0;
  const matches = [];
  for (const match of line.matchAll(pattern)) {
    matches.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  pattern.lastIndex = 0;
  return matches;
}

function redactedSnippet(line, spans) {
  const merged = [...spans].sort((left, right) => left.start - right.start);
  let result = line;
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const span = merged[index];
    result = `${result.slice(0, span.start)}<redacted>${result.slice(span.end)}`;
  }
  if (result.length <= 120) return result;
  return `${result.slice(0, 58)}…${result.slice(-59)}`;
}

function finding(filePath, rule, line, column, snippet = null) {
  return {
    path: filePath,
    rule,
    line,
    column,
    message: rule === 'unreadable-file' ? 'Selected path could not be read as a regular file' : 'Potential sensitive content requires review',
    snippet,
  };
}

function hasCredentialFilename(filePath) {
  const basename = path.basename(filePath);
  const normalizedBasename = basename.toLowerCase();
  return normalizedBasename === '.env' || normalizedBasename.startsWith('.env.') || CREDENTIAL_FILENAME.test(basename) || PRIVATE_KEY_EXTENSION.test(basename);
}

// A marker inside a markdown code span is a *mention*: a document quoting
// another document's unresolved status token, or describing the rule itself.
// The scanner's own public disclosure page says the acknowledgement target is
// "recorded as `OWNER_TO_BE_CONFIRMED`" elsewhere and fails extraction without
// this. An unquoted `Owner: OWNER_TO_BE_CONFIRMED` still fires, which is the
// status line the marker exists to catch.
function isCodeSpanMention(line, index) {
  let backticks = 0;
  for (let cursor = 0; cursor < index; cursor += 1) if (line[cursor] === '`') backticks += 1;
  return backticks % 2 === 1;
}
const INTERNAL_DOCUMENT_MARKER_SCAN = INTERNAL_DOCUMENT_MARKERS.map(
  (pattern) => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
);

function internalDocumentFinding(filePath, content) {
  if (INTERNAL_DOCUMENT_PATH.test(filePath)) return finding(filePath, 'internal-document-marker', 0, 0);
  if (!DOCUMENT_EXTENSION.test(filePath)) return null;
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) for (const pattern of INTERNAL_DOCUMENT_MARKER_SCAN) {
      // `matchAll` scans a clone, so the shared global patterns never carry state.
      for (const match of lines[index].matchAll(pattern)) {
        if (isCodeSpanMention(lines[index], match.index)) continue;
        return finding(filePath, 'internal-document-marker', index + 1, match.index + 1);
      }
  }
  return null;
}

function lineFindings(filePath, line, lineNumber) {
  const detections = [];
  for (const [rule, pattern] of SECRET_PATTERNS) {
    for (const span of findMatches(pattern, line)) {
      if (!isPlaceholder(line.slice(span.start, span.end))) detections.push({ rule, ...span });
    }
  }
  for (const span of findMatches(AUTHORIZATION_PATTERN, line)) {
    const literal = line.slice(span.start, span.end).replace(/^.*?[:=]\s*/u, '').trim();
    if (!isPlaceholder(literal) && !isPlaceholder(literal.replace(/^(?:Bearer|Basic|Token)\s+/i, ''))) {
      detections.push({ rule: 'authorization-literal', ...span });
    }
  }
  for (const pattern of CANARY_PATTERNS) {
    for (const span of findMatches(pattern, line)) detections.push({ rule: 'canary-string', ...span });
  }
  const knownSpans = detections.map(({ start, end }) => ({ start, end }));
  for (const span of findMatches(TOKEN_LIKE_PATTERN, line)) {
    const value = line.slice(span.start, span.end);
    if (hasSensitiveAssignmentContext(line) && !isIntegrityHashValue(line, span, value) && isHighEntropyToken(value) && !isPlaceholder(value) && !knownSpans.some((known) => overlaps(known, span))) {
      detections.push({ rule: 'high-entropy-token', ...span });
    }
  }
  const allSpans = detections.map(({ start, end }) => ({ start, end }));
  return detections.map(({ rule, start }) => finding(filePath, rule, lineNumber, start + 1, redactedSnippet(line, allSpans)));
}

function auditFile(filePath) {
  const findings = [];
  let stats;
  try {
    stats = fs.lstatSync(filePath);
    if (!stats.isFile()) throw new Error('not a regular file');
  } catch {
    return [finding(filePath, 'unreadable-file', 0, 0)];
  }
  if (hasCredentialFilename(filePath)) findings.push(finding(filePath, 'credential-filename', 0, 0));
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [...findings, finding(filePath, 'unreadable-file', 0, 0)];
  }
  const documentFinding = internalDocumentFinding(filePath, content);
  if (documentFinding) findings.push(documentFinding);
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) findings.push(...lineFindings(filePath, lines[index], index + 1));
  return findings;
}

export function auditPublicRepoFiles(filePaths) {
  const inputs = Array.isArray(filePaths) ? filePaths : [filePaths];
  const paths = new Set();
  const findings = [];
  for (const input of inputs) {
    if (typeof input !== 'string' || input.length === 0) {
      findings.push(finding(String(input ?? '<empty>'), 'unreadable-file', 0, 0));
      continue;
    }
    const filePath = canonicalPath(input);
    if (!paths.has(filePath)) {
      paths.add(filePath);
      findings.push(...auditFile(filePath));
    }
  }
  findings.sort((left, right) => compareStrings(left.rule, right.rule) || compareStrings(left.path, right.path) || left.line - right.line || left.column - right.column || compareStrings(left.snippet ?? '', right.snippet ?? ''));
  return { ok: findings.length === 0, findings };
}
