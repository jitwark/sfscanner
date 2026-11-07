import { createHash } from 'node:crypto';

export function entryId(kind: string, ref: string, path: string): string {
  return createHash('sha256').update(kind + ref + path).digest('hex').slice(0, 16);
}

export function slugify(title: string, id: string): string {
  const cleanTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = cleanTitle || 'workflow';
  const shortId = id.length > 8 ? id.slice(0, 8) : id;
  return `${base}-${shortId}`;
}
