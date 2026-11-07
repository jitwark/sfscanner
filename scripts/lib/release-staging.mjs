/**
 * Staging a release snapshot. A release is the site bundle, the corpus it serves and
 * the published dataset, copied byte for byte — except the site, which is a review
 * snapshot and must not be indexable. The noindex signal therefore has to be written
 * into the staged bytes rather than configured at the edge, and it is verified by
 * reading those bytes back.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fail, filesIn } from './release-artifacts.mjs';

export const NOINDEX_META = '<meta name="robots" content="noindex, nofollow"/>';
export const NOINDEX_ROBOTS = 'User-agent: *\nDisallow: /\n';
const ROBOTS_META = /<meta[^>]*\bname=["']robots["'][^>]*\/?>/iu;
const HEAD_OPEN = /<head[^>]*>/iu;

/** Replaces the head's robots directive with the snapshot one, or inserts it. */
export function applyNoindex(html) {
  const withMeta = html.replace(ROBOTS_META, NOINDEX_META);
  if (withMeta !== html) return withMeta;
  const head = html.match(HEAD_OPEN);
  if (!head || head.index === undefined) fail('staged HTML has no head element to carry the noindex signal');
  return `${html.slice(0, head.index + head[0].length)}${NOINDEX_META}${html.slice(head.index + head[0].length)}`;
}

/**
 * Copies a tree, transforming the snapshot's indexability. `.html` gains the noindex
 * directive and `robots.txt` is replaced, because the built robots.txt points search
 * engines at a sitemap for a site that is not meant to be indexed yet.
 */
export async function stageTree(source, destination, transform = (relative, bytes) => bytes) {
  const files = await filesIn(source);
  for (const file of files) {
    const relative = file.path.replaceAll('/', path.sep);
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, transform(file.path, await readFile(file.file)));
  }
  return files.length;
}

/**
 * The staged bytes of one site file. The verifier re-derives the site section by running
 * `describeSection` over the source with this same transform, so the recorded site hash
 * is reproducible from the source tree rather than trusted from the staging run.
 */
export function snapshotSiteBytes(relative, bytes) {
  if (relative === 'robots.txt') return Buffer.from(NOINDEX_ROBOTS, 'utf8');
  if (!relative.endsWith('.html')) return bytes;
  return Buffer.from(applyNoindex(bytes.toString('utf8')), 'utf8');
}

export function stageSite(source, destination) {
  return stageTree(source, destination, snapshotSiteBytes);
}

/** Reads the staged site back and reports what the snapshot actually says. */
export async function inspectNoindex(directory) {
  const files = await filesIn(directory);
  const html = files.filter((file) => file.path.endsWith('.html'));
  const missing = [];
  for (const file of html) {
    const directive = (await readFile(file.file, 'utf8')).match(ROBOTS_META)?.[0] ?? '';
    if (directive !== NOINDEX_META) missing.push(file.path);
  }
  const robots = files.find((file) => file.path === 'robots.txt');
  return Object.freeze({
    meta: NOINDEX_META,
    htmlFiles: html.length,
    missingMeta: Object.freeze(missing),
    robotsIsDisallowAll: robots !== undefined && await readFile(robots.file, 'utf8') === NOINDEX_ROBOTS,
  });
}
