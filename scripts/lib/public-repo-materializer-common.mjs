import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_SCHEMA = 'public-repository-extraction-v1';
export const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
export const issue = (code, issuePath, message) => ({ code, path: issuePath, message });
export const sortIssues = (issues) => issues.sort((a, b) => compare(a.code, b.code) || compare(a.path, b.path) || compare(a.message, b.message));
export const isInside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
export const overlaps = (left, right) => isInside(left, right) || isInside(right, left);
export const normalisePath = (value) => value.replaceAll('\\', '/');

export function hashFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  return { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
