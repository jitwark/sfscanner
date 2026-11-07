import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { maskReviewedParserProcessShim } from './emitted-browser-safe-process-shim.mjs';
const emittedForbiddenChecks = [
  { name: 'fetch API reference', pattern: /\bfetch\b/ },
  { name: 'XMLHttpRequest API reference', pattern: /\bXMLHttpRequest\b/ },
  { name: 'WebSocket API reference', pattern: /\bWebSocket\b/ },
  { name: 'EventSource API reference', pattern: /\bEventSource\b/ },
  { name: 'navigator.sendBeacon API reference', pattern: /\bsendBeacon\b/ },
  { name: 'Node Buffer global', pattern: /\bBuffer\b/ },
  { name: 'require(...) call', pattern: /\brequire\s*\(/ },
  { name: 'dynamic import() call', pattern: /\bimport\s*\(/ },
  {
    name: 'Node module import',
    raw: true,
    pattern: /(?:\bfrom\s*|\bimport\s+(?:[\w*{},$\s]+\s+from\s*)?|\b(?:import|require)\s*\(\s*)["'](?:node:)?(?:fs|path|crypto|child_process|os|util|stream|buffer|events|http|https|net|tls|url|vm|zlib|worker_threads)(?:\/[^"']*)?["']/,
  },
];
function blank(chars, start, end) {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
  }
}
function isRegexStart(chars, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(chars[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  const previous = chars[cursor];
  if ('([{,:;=!?&|+*%^~<>'.includes(previous)) return true;
  if (!/[A-Za-z_$]/.test(previous)) return false;
  while (cursor >= 0 && /[\w$]/.test(chars[cursor])) cursor -= 1;
  const word = chars.slice(cursor + 1, index).join('').trim();
  return /^(return|case|throw|typeof|void|delete|in|of)$/.test(word);
}
export function maskJavaScript(source) {
  const chars = source.split('');
  const scanTemplate = (start) => {
    blank(chars, start, start + 1);
    let index = start + 1;
    while (index < chars.length) {
      if (chars[index] === '\\') { blank(chars, index, index + 2); index += 2; continue; }
      if (chars[index] === String.fromCharCode(96)) { blank(chars, index, index + 1); return index + 1; }
      if (chars[index] === '$' && chars[index + 1] === '{') {
        blank(chars, index, index + 2);
        index = scanCode(index + 2, true);
        continue;
      }
      blank(chars, index, index + 1);
      index += 1;
    }
    return index;
  };
  const scanCode = (start, templateExpression = false) => {
    let index = start;
    let braces = 0;
    while (index < chars.length) {
      const char = chars[index];
      const next = chars[index + 1];
      if (char === "'" || char === '"') {
        const quote = char;
        const from = index++;
        while (index < chars.length) {
          if (chars[index] === '\\') { index += 2; continue; }
          if (chars[index] === quote) { index += 1; break; }
          if (chars[index] === '\n' || chars[index] === '\r') break;
          index += 1;
        }
        blank(chars, from, index);
        continue;
      }
      if (char === String.fromCharCode(96)) { index = scanTemplate(index); continue; }
      if (char === '/' && next === '/') {
        const from = index;
        index += 2;
        while (index < chars.length && chars[index] !== '\n' && chars[index] !== '\r') index += 1;
        blank(chars, from, index);
        continue;
      }
      if (char === '/' && next === '*') {
        const from = index;
        index += 2;
        while (index < chars.length && !(chars[index] === '*' && chars[index + 1] === '/')) index += 1;
        index = Math.min(chars.length, index + 2);
        blank(chars, from, index);
        continue;
      }
      if (char === '/' && isRegexStart(chars, index)) {
        const from = index++;
        let inClass = false;
        while (index < chars.length) {
          if (chars[index] === '\\') { index += 2; continue; }
          if (chars[index] === '[') inClass = true;
          else if (chars[index] === ']') inClass = false;
          else if (chars[index] === '/' && !inClass) { index += 1; break; }
          else if (chars[index] === '\n' || chars[index] === '\r') break;
          index += 1;
        }
        while (index < chars.length && /[a-z]/i.test(chars[index])) index += 1;
        blank(chars, from, index);
        continue;
      }
      if (templateExpression && char === '{') braces += 1;
      if (templateExpression && char === '}') {
        if (braces === 0) { blank(chars, index, index + 1); return index + 1; }
        braces -= 1;
      }
      index += 1;
    }
    return index;
  };
  scanCode(0);
  return chars.join('');
}
export function findEmittedArtifactViolations(source, artifact = 'emitted scanner worker') {
  const reviewed = maskReviewedParserProcessShim(source);
  const maskedLines = maskJavaScript(reviewed).split(/\r?\n/);
  const rawLines = reviewed.split(/\r?\n/);
  const violations = [];
  for (let index = 0; index < maskedLines.length; index += 1) {
    const processMatch = [...maskedLines[index].matchAll(/\bprocess\b/g)].find((match) => {
      const prefix = maskedLines[index].slice(0, match.index);
      const suffix = maskedLines[index].slice(match.index + 'process'.length);
      return /\.g\.$/.test(prefix) || /(?:^|[^\w$])globalThis\.$/.test(prefix) || !prefix.endsWith('.') && /^\s*\./.test(suffix);
    });
    if (processMatch) {
      violations.push({ artifact, name: 'Node process global', line: index + 1, column: processMatch.index + 1 });
    }
    for (const check of emittedForbiddenChecks) {
      const line = check.raw ? rawLines[index] : maskedLines[index];
      const match = line.match(check.pattern);
      if (!match || (check.raw && !maskedLines[index].slice(match.index, match.index + 8).trim())) continue;
      violations.push({ artifact, name: check.name, line: index + 1, column: match.index + 1 });
    }
  }
  return violations;
}
function chunksDirectory(outputDir) {
  const root = path.resolve(outputDir);
  const candidates = [path.join(root, '_next', 'static', 'chunks'), path.join(root, 'static', 'chunks')]
    .filter((candidate) => fs.existsSync(candidate));
  if (candidates.length !== 1) {
    throw new Error('expected one emitted static chunks directory, found ' + candidates.length);
  }
  return candidates[0];
}
function resolveRootChunk(chunksDir, chunkId) {
  const candidates = fs.readdirSync(chunksDir)
    .filter((name) => new RegExp('^' + chunkId + '[-.].+\\.js$').test(name)).sort();
  if (candidates.length !== 1) throw new Error('could not resolve emitted scanner worker chunk ' + chunkId);
  return path.join(chunksDir, candidates[0]);
}
function loaderFor(source) {
  return source.match(/\b\w+\.u\s*=\s*[\s\S]*?(?=,\s*\w+\.miniCssF\s*=|;|$)/)?.[0] ?? '';
}

function resolveDependency(chunksDir, loader, chunkId) {
  const id = String(chunkId);
  const direct = loader.match(new RegExp(id + "\\s*===\\s*\\w+\\s*\\?\\s*['\"]([^'\"]+\\.js)['\"]"));
  let filename = direct?.[1] ? path.basename(direct[1]) : '';
  if (!filename) {
    const objects = [...loader.matchAll(/\(\{([^{}]*)\}\)\[\w+\]/g)];
    let hash = '';
    for (const object of objects) {
      hash = object[1].match(new RegExp("(?:^|,)\\s*" + id + "\\s*:\\s*['\"]([^'\"]+)['\"]"))?.[1] ?? '';
      if (hash) break;
    }
    const prefix = loader.match(new RegExp(id + "\\s*===\\s*\\w+\\s*\\?\\s*['\"]([^'\"]+)['\"]"))?.[1] ?? id;
    if (hash) filename = prefix + '.' + hash + '.js';
  }
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('unsafe emitted worker dependency path for chunk ' + id);
  }
  if (!filename) {
    const candidates = fs.readdirSync(chunksDir).filter((name) => new RegExp('^' + id + '[-.].+\\.js$').test(name));
    if (candidates.length === 1) filename = candidates[0];
  }
  const full = path.join(chunksDir, filename);
  if (!filename || !fs.existsSync(full)) throw new Error('could not resolve emitted worker dependency chunk ' + id);
  return full;
}
function dependencyIds(source) {
  const ids = new Set();
  const patterns = [
    /\.O\(\s*[^,]*,\s*\[([^\]]*)\]/g,
    /\[([^\]]*)\]\s*\.map\(\s*\w+\.e/g,
    /\.\s*e\(\s*(\d+)\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      for (const id of match[1].matchAll(/\b\d+\b/g)) ids.add(Number(id[0]));
    }
  }
  return [...ids].sort((left, right) => left - right);
}
export function resolveEmittedScannerWorker(outputDir) {
  const chunksDir = chunksDirectory(outputDir);
  const pageDir = path.join(chunksDir, 'app', 'scanner');
  const pageFiles = fs.existsSync(pageDir)
    ? fs.readdirSync(pageDir).filter((name) => /^page-[^/]+\.js$/.test(name)).sort()
    : [];
  if (pageFiles.length !== 1) throw new Error('expected one emitted scanner page chunk, found ' + pageFiles.length);
  const pageFile = path.join(pageDir, pageFiles[0]);
  const workerIds = [...fs.readFileSync(pageFile, 'utf8').matchAll(/new\s+Worker\([\s\S]*?\.u\(\s*(\d+)\s*\)/g)]
    .map((match) => Number(match[1]));
  const chunkIds = [...new Set(workerIds)].sort((left, right) => left - right);
  if (chunkIds.length === 0) throw new Error('expected at least one emitted scanner worker chunk reference, found 0');
  const roots = chunkIds.map((chunkId) => resolveRootChunk(chunksDir, chunkId));
  const workerFiles = [];
  const seen = new Set();
  const queue = roots.map((file) => ({ file, loader: '' }));
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current.file)) continue;
    seen.add(current.file);
    workerFiles.push(current.file);
    const source = fs.readFileSync(current.file, 'utf8');
    const loader = loaderFor(source) || current.loader;
    for (const dependency of dependencyIds(source)) {
      const file = resolveDependency(chunksDir, loader, dependency);
      if (!seen.has(file)) queue.push({ file, loader });
    }
  }
  const resolved = { pageFile, chunkIds: chunkIds.map(String), workerFiles, workerFile: roots[0], chunksDir };
  return chunkIds.length === 1 ? { ...resolved, chunkId: String(chunkIds[0]) } : resolved;
}
export function auditEmittedScannerWorker(outputDir, options = {}) {
  const resolved = resolveEmittedScannerWorker(outputDir);
  const artifacts = resolved.workerFiles.map((file) => {
    const source = fs.readFileSync(file);
    return {
      file,
      name: path.basename(file),
      bytes: source.byteLength,
      sha256: createHash('sha256').update(source).digest('hex'),
      violations: findEmittedArtifactViolations(source.toString('utf8'), file),
    };
  });
  const totalBytes = artifacts.reduce((total, artifact) => total + artifact.bytes, 0);
  const minimumBytes = options.minimumBytes ?? 100_000;
  if (totalBytes < minimumBytes) {
    throw new Error('emitted worker dependency closure is only ' + totalBytes + ' bytes; expected at least ' + minimumBytes);
  }
  return {
    ...resolved,
    artifacts,
    totalBytes,
    violations: artifacts.flatMap((artifact) => artifact.violations),
  };
}
