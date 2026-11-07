/**
 * Every internal link in the export must resolve to a file that exists.
 *
 * Written because the site's only content-removal channel — the footer's
 * "Request takedown" link — pointed at a route that had never been created
 * (TD-1, 2026-08-25 audit). Nothing failed: a dead link in a static export is
 * indistinguishable from a working one until someone clicks it.
 *
 * Targets are deduplicated before being checked. 13,221 detail pages link to
 * the same handful of hub and legal routes, so the work is proportional to the
 * number of distinct destinations, not to the number of links.
 *
 * Usage: node scripts/check-links.mjs [outDir]
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'app', 'out'));
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/^\/+|\/+$/g, '');

if (!fs.existsSync(outDir)) {
  console.error('Link gate failed: app/out does not exist. Run the build first.');
  process.exit(1);
}

/** Where an internal href would have to land on disk. */
function targetsFor(href) {
  const encodedRoute = href.split('#')[0].split('?')[0];
  let route;
  try {
    route = decodeURIComponent(encodedRoute);
  } catch {
    return [];
  }
  if (basePath && route.startsWith(`/${basePath}/`)) route = route.slice(basePath.length + 1);
  if (route === '' || route === '/') return [path.join(outDir, 'index.html')];
  const relative = route.replace(/^\/+/, '').replaceAll('/', path.sep);
  // A route may be a directory with an index, or a file served directly.
  return [path.join(outDir, relative, 'index.html'), path.join(outDir, relative)];
}

const exists = new Map();
const resolves = (href) => {
  if (!exists.has(href)) {
    exists.set(href, targetsFor(href).some((candidate) => fs.existsSync(candidate)));
  }
  return exists.get(href);
};

const HREF = /\s(?:href|src)="(\/[^"#][^"]*|\/)"/g;
const broken = new Map();
let pages = 0;
let links = 0;

function walk(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) {
      if (item.name === '_next' || item.name === 'data' || item.name === 'og') continue;
      walk(absolute);
      continue;
    }
    if (item.name !== 'index.html' && !item.name.endsWith('.html')) continue;

    pages += 1;
    const html = fs.readFileSync(absolute, 'utf8');
    for (const match of html.matchAll(HREF)) {
      const href = match[1];
      if (href.startsWith('//')) continue;
      links += 1;
      if (resolves(href)) continue;
      const relative = path.relative(outDir, absolute).replaceAll(path.sep, '/');
      if (!broken.has(href)) broken.set(href, relative);
    }
  }
}

walk(outDir);

if (pages === 0) {
  console.error('Link gate failed: no HTML found in the export.');
  process.exit(1);
}

if (broken.size > 0) {
  console.error(`Link gate failed: ${broken.size} internal target(s) do not exist.`);
  for (const [href, from] of [...broken].slice(0, 25)) console.error(`- ${href}  (first seen in ${from})`);
  if (broken.size > 25) console.error(`- ...and ${broken.size - 25} more`);
  process.exit(1);
}

console.log(`Link gate passed: ${links} internal links across ${pages} pages, ${exists.size} distinct targets, all resolve.`);
