import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { allowedRuntimePackages } from './scanner-core-package-audit.mjs';

const prohibitedSpecifier = /^(?:node:)?(?:fs|path|process|buffer|module|child_process|worker_threads|http|https|net|tls|os|stream)(?:\/|$)/i;
const prohibitedPackage = /^(?:@hub\/(?:app|pipeline)|next(?:\/|$)|react(?:\/|$)|express(?:\/|$)|https?:\/\/)/i;
const prohibitedReference = [
  /\bprocess\b/,
  /\bBuffer\b/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\b(?:Shared)?Worker\b/,
  /\bimport\s*\(/,
  /\brequire\s*\(/,
];
const regexAfter = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'in', 'of', 'yield', 'await', 'else', 'do']);
export function collectSourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(file);
    if (!entry.isFile() || !/\.(?:ts|tsx|js|mjs)$/.test(entry.name) || /\.test\./.test(entry.name)) return [];
    return [file];
  });
}

export function checkSource(file, packageRoot, declaredDependencies, errors) {
  const source = readFileSync(file, 'utf8');
  const relativeFile = relative(packageRoot, file);
  const importPattern = /\b(?:import|export)\s+(?:(?:type\s+)?[\s\S]*?\s+from\s*)?["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? '';
    if (prohibitedSpecifier.test(specifier) || prohibitedPackage.test(specifier)) {
      errors.push(`${relativeFile}: prohibited import/specifier ${specifier}`);
      continue;
    }

    const packageName = barePackageName(specifier);
    if (packageName && !allowedRuntimePackages.has(packageName)) {
      errors.push(`${relativeFile}: runtime import is not allowed: ${specifier}`);
    } else if (packageName && !declaredDependencies.has(packageName)) {
      errors.push(`${relativeFile}: runtime import is not explicitly declared: ${packageName}`);
    }
  }
  const { source: executableSource, unterminatedRegex } = stripRuntimeLiterals(source);
  if (unterminatedRegex) errors.push(`${relativeFile}: unterminated regex literal`);
  for (const pattern of prohibitedReference) {
    if (pattern.test(executableSource)) errors.push(`${relativeFile}: prohibited runtime reference ${pattern}`);
  }
}

function stripRuntimeLiterals(source) {
  let output = '';
  let quote = null;
  let escaped = false;
  let comment = null;
  let previousToken = null;
  let unterminatedRegex = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (comment === 'line') {
      if (character === '\n') comment = null;
      output += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (comment === 'block') {
      if (character === '*' && next === '/') {
        comment = null;
        index += 1;
        output += '  ';
        continue;
      }
      output += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      output += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (character === '/' && next === '/') {
      comment = 'line';
      index += 1;
      output += '  ';
      continue;
    }
    if (character === '/' && next === '*') {
      comment = 'block';
      index += 1;
      output += '  ';
      continue;
    }
    if (character === '/' && canStartRegex(previousToken)) {
      const end = skipRegexLiteral(source, index);
      if (end !== null) {
        output += source.slice(index, end).replace(/[^\n]/g, ' ');
        index = end - 1;
        previousToken = 'literal';
        continue;
      }
      unterminatedRegex = true;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      output += ' ';
      previousToken = 'literal';
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1;
      while (/[A-Za-z0-9_$]/.test(source[end] ?? '')) end += 1;
      const token = source.slice(index, end);
      output += token;
      previousToken = token;
      index = end - 1;
      continue;
    }
    if (/\d/.test(character)) previousToken = 'literal';
    else if (!/\s/.test(character)) previousToken = character;
    output += character;
  }
  return { source: output, unterminatedRegex };
}

function canStartRegex(previousToken) {
  return previousToken === null || regexAfter.has(previousToken) || '=([{,:;!&|?+-*%^~<>'.includes(previousToken);
}

function skipRegexLiteral(source, start) {
  let index = start + 1;
  let escaped = false;
  let characterClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === '\n' || character === '\r') return null;
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === '[') characterClass = true;
    else if (character === ']') characterClass = false;
    else if (character === '/' && !characterClass) {
      index += 1;
      while (/[A-Za-z]/.test(source[index] ?? '')) index += 1;
      return index;
    }
    index += 1;
  }
  return null;
}

function barePackageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return null;
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0];
}
