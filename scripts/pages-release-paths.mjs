import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

export const PAGES_LIMITS = Object.freeze({ files: 25_000, bytes: 900 * 1024 * 1024,
  htmlBytes: 560_000_000, largestDataBytes: 40 * 1024 * 1024 });
export const MAX_ARCHIVE_BYTES = PAGES_LIMITS.bytes + PAGES_LIMITS.files * 1024 + 1024;
export function fail(message) { throw new Error(`Pages release: ${message}`); }

export function isSameOrInside(parent, candidate) {
  const canonical = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const relative = path.relative(canonical(parent), canonical(candidate));
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function safeRelative(name) {
  if (typeof name !== 'string' || !name || name !== name.normalize('NFC')
    || /[\x00-\x1f\x7f\\:]/u.test(name) || name.startsWith('/')
    || name.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/u.test(part)
      || /^\.(?:git|github)$/iu.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail('unsafe archive path');
  return name;
}

/** Reject symlink/junction ancestors too, not only the final source/output component. */
export async function confinedPath(input) {
  const absolute = path.resolve(input);
  let cursor = path.parse(absolute).root;
  for (const part of path.relative(cursor, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) fail('symlink/junction path is forbidden');
  }
  return absolute;
}

export function accounting() {
  const seen = new Set(), directories = new Set();
  const totals = { files: 0, bytes: 0, htmlBytes: 0 };
  return { totals, add(name, size) {
    safeRelative(name);
    if (!Number.isSafeInteger(size) || size < 0) fail('unsafe file size');
    if (seen.has(name) || directories.has(name)) fail('duplicate or conflicting archive path');
    const pathParts = name.split('/');
    for (let i = 1; i < pathParts.length; i++) {
      const parent = pathParts.slice(0, i).join('/');
      if (seen.has(parent)) fail('file/directory path conflict');
      directories.add(parent);
    }
    seen.add(name); totals.files++; totals.bytes += size;
    if (/\.html$/iu.test(name)) totals.htmlBytes += size;
    if (totals.files > PAGES_LIMITS.files || totals.bytes > PAGES_LIMITS.bytes
      || totals.htmlBytes > PAGES_LIMITS.htmlBytes
      || name.startsWith('data/') && size > PAGES_LIMITS.largestDataBytes) fail('static host budget exceeded');
    if (pathParts[0]?.toLowerCase() === 'data'
      && /^(?:raw|workflows?)$/iu.test(pathParts[1] ?? '')) fail('raw workflow data is forbidden');
  }, finish() {
    if (!seen.has('index.html') || !seen.has('.nojekyll')) fail('index.html and .nojekyll are required');
    return { ...totals };
  } };
}

export async function sourceFiles(input) {
  const root = await confinedPath(input), files = [], budget = accounting();
  if (!(await lstat(root)).isDirectory()) fail('source must be a directory');
  async function walk(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const relative = safeRelative(`${prefix}${name}`), absolute = path.join(directory, name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) fail('source symlink/junction is forbidden');
      if (stat.isDirectory()) await walk(absolute, `${relative}/`);
      else {
        if (!stat.isFile() || stat.nlink !== 1) fail('source special file or hard link is forbidden');
        budget.add(relative, stat.size); files.push({ name: relative, absolute, size: stat.size });
      }
    }
  }
  await walk(root);
  return { root, files, totals: budget.finish() };
}
