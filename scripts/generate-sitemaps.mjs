/**
 * Generate sitemaps and robots.txt from the exported site.
 *
 * This runs after `next build` and enumerates the HTML that was actually
 * written, rather than recomputing which routes ought to exist. Recomputation
 * was the source of a real defect: the generator counted every integration in
 * the corpus while the hub routes only build hubs with at least three
 * workflows, so 220 sitemap URLs pointed at pages that were never generated.
 * A crawler treats those as soft 404s.
 *
 * A page is excluded when its own HTML says `noindex`. The page is therefore
 * the single authority on whether it belongs in a sitemap, and the two can no
 * longer disagree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writePreviewRobots } from './lib/preview-sitemap.mjs';
import { assertUrlMatchesBasePath, normalizeBasePath, requireSiteUrl } from '../app/src/ui/site-url.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'app', 'out');
const BASE_PATH = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH || '');
const WORKFLOW_SHARD_SIZE = 5000;
const PREVIEW_BUILD = process.env.NEXT_PUBLIC_BUILD_MODE === 'preview';

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatLastMod(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().split('T')[0];
}

/** Every route in the export, as a trailing-slash path, excluding noindex pages. */
function collectRoutes(directory, prefix = '/') {
  const routes = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '_next' || entry.name === 'data') continue;
      routes.push(...collectRoutes(path.join(directory, entry.name), `${prefix}${entry.name}/`));
      continue;
    }
    if (entry.name !== 'index.html') continue;
    const html = fs.readFileSync(path.join(directory, entry.name), 'utf8');
    if (/<meta[^>]+name="robots"[^>]+noindex/i.test(html)) continue;
    routes.push(prefix);
  }
  return routes;
}

/** Commit dates for workflow pages, keyed by slug, used for `lastmod`. */
function readCommitDates() {
  const dataDir = path.join(OUT_DIR, 'data');
  const dates = new Map();
  if (!fs.existsSync(dataDir)) return dates;
  for (const file of fs.readdirSync(dataDir)) {
    if (!file.startsWith('catalogue-') || !file.endsWith('.json')) continue;
    const shard = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
    if (!Array.isArray(shard)) continue;
    for (const entry of shard) {
      const lastmod = formatLastMod(entry.source?.committedAt);
      if (entry.slug && lastmod) dates.set(entry.slug, lastmod);
    }
  }
  return dates;
}

function urlSet(urls, siteUrl) {
  const body = urls
    .map(({ loc, lastmod }) => {
      const lastmodXml = lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : '';
      return `  <url>\n    <loc>${escapeXml(`${siteUrl}${loc}`)}</loc>${lastmodXml}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function robotsTxt(siteUrl) {
  const routePrefix = BASE_PATH || '';
  return `User-agent: *
Disallow: ${routePrefix}/library/?*
Disallow: ${routePrefix}/w/view*
Disallow: ${routePrefix}/*?*

Sitemap: ${siteUrl}/sitemap.xml
`;
}

function main() {
  if (!fs.existsSync(OUT_DIR)) {
    process.stderr.write(
      'app/out does not exist. Run the Next build before generating sitemaps.\n',
    );
    process.exit(1);
  }

  if (PREVIEW_BUILD) {
    const removed = writePreviewRobots(OUT_DIR);
    process.stdout.write(`sitemap: preview mode, removed ${removed.length} sitemap file(s)\n`);
    return;
  }

  // No origin, no sitemap: a local build has no crawlable identity to declare.
  // Writing one against a guessed host is how a dead origin reaches production.
  if (!(process.env.NEXT_PUBLIC_SITE_URL ?? '').trim()) {
    process.stdout.write('sitemap: no NEXT_PUBLIC_SITE_URL configured; wrote no sitemap or robots.txt (local build)\n');
    return;
  }
  const siteUrl = requireSiteUrl();
  assertUrlMatchesBasePath(siteUrl, process.env.NEXT_PUBLIC_BASE_PATH ?? '');

  const today = new Date().toISOString().split('T')[0];
  const routes = collectRoutes(OUT_DIR).sort();
  const commitDates = readCommitDates();

  const workflowRoutes = routes.filter((route) => route.startsWith('/w/'));
  const otherRoutes = routes.filter((route) => !route.startsWith('/w/'));

  const files = {};
  const children = [];

  files['sitemap-pages.xml'] = urlSet(otherRoutes.map((loc) => ({ loc, lastmod: today })), siteUrl);
  children.push('sitemap-pages.xml');

  const shardCount = Math.max(1, Math.ceil(workflowRoutes.length / WORKFLOW_SHARD_SIZE));
  for (let shard = 0; shard < shardCount; shard++) {
    const name = `sitemap-workflows-${shard + 1}.xml`;
    const slice = workflowRoutes.slice(
      shard * WORKFLOW_SHARD_SIZE,
      (shard + 1) * WORKFLOW_SHARD_SIZE,
    );
    files[name] = urlSet(
      slice.map((loc) => ({ loc, lastmod: commitDates.get(loc.slice(3, -1)) ?? null })),
      siteUrl,
    );
    children.push(name);
  }

  files['sitemap.xml'] =
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    children
      .map(
        (child) =>
          `  <sitemap>\n    <loc>${escapeXml(`${siteUrl}/${child}`)}</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>`,
      )
      .join('\n') +
    `\n</sitemapindex>\n`;

  for (const [name, xml] of Object.entries(files)) {
    fs.writeFileSync(path.join(OUT_DIR, name), xml, 'utf8');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'robots.txt'), robotsTxt(siteUrl), 'utf8');

  process.stdout.write(
    `sitemap: ${otherRoutes.length} pages, ${workflowRoutes.length} workflows across ${shardCount} shard(s)\n`,
  );
}

main();
