import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeRelative(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const normalised = value.replaceAll('\\', '/');
  if (normalised.startsWith('/') || /^[A-Za-z]:\//u.test(normalised)) return false;
  return !normalised.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function verifyScannerChecksums({ artifactRoot, checksumFile } = {}) {
  const errors = [];
  const root = path.resolve(artifactRoot ?? process.cwd());
  const checksumPath = path.resolve(checksumFile ?? path.join(root, 'SHA256SUMS'));
  let content;
  try {
    content = fs.readFileSync(checksumPath, 'utf8');
  } catch {
    return { ok: false, errors: ['checksum file could not be read'] };
  }
  if (content.includes('\r')) errors.push('checksum file must use LF line endings');
  const records = [];
  for (const [index, line] of content.split('\n').entries()) {
    if (line.length === 0 && index === content.split('\n').length - 1) continue;
    const match = /^([a-f0-9]{64})  (.+)$/iu.exec(line);
    if (!match) {
      errors.push(`invalid checksum record at line ${index + 1}`);
      continue;
    }
    const digest = match[1].toLowerCase();
    const relative = match[2].replaceAll('\\', '/');
    if (!safeRelative(relative)) {
      errors.push(`checksum path is not a safe relative path: ${relative}`);
      continue;
    }
    records.push({ digest, relative });
  }
  const paths = records.map(({ relative }) => relative);
  if (new Set(paths).size !== paths.length) errors.push('checksum file contains duplicate paths');
  if (paths.join('\0') !== [...paths].sort(compareStrings).join('\0')) errors.push('checksum records are not sorted');
  for (const { digest, relative } of records) {
    const absolute = path.resolve(root, relative);
    const relativeToRoot = path.relative(root, absolute);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      errors.push(`checksum path escapes artifact root: ${relative}`);
      continue;
    }
    let bytes;
    try {
      const stats = fs.lstatSync(absolute);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('not a regular file');
      bytes = fs.readFileSync(absolute);
    } catch {
      errors.push(`checksum artifact is missing or unreadable: ${relative}`);
      continue;
    }
    if (sha256(bytes) !== digest) errors.push(`checksum mismatch: ${relative}`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyScannerChecksums({ artifactRoot: process.argv[2], checksumFile: process.argv[3] });
  if (result.ok) process.stdout.write('Scanner checksums verified.\n');
  else {
    process.stderr.write(`${result.errors.join('\n')}\n`);
    process.exitCode = 1;
  }
}
