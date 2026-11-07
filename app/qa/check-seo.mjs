import fs from 'node:fs'; import path from 'node:path'; import { isTruncatedTitle } from './title-terminal-policy.mjs';

const OUT_DIR = path.resolve(process.argv[2] || path.join(process.cwd(), 'app', 'out'));
const violations = [];
const BASE_PATH = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH || '');
const PREVIEW_ROBOTS = 'noindex, nofollow, noarchive, nosnippet';
const PREVIEW_BUILD = process.env.NEXT_PUBLIC_BUILD_MODE === 'preview';
/**
 * A release build has a configured origin; a local build is a supported mode
 * without one. The origin decides whether absolute URLs are required (release)
 * or forbidden (local) — it never changes whether the page is a page.
 */
const RELEASE_CONFIGURED = Boolean((process.env.NEXT_PUBLIC_SITE_URL ?? '').trim());

function normalizeBasePath(value) {
  if (!value || value === '/') return '';
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}

function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? htmlFiles(full) : entry.name.endsWith('.html') ? [full] : [];
  });
}

// Backreference keeps apostrophes inside generated meta descriptions measurable.
function attr(html, name) {
  const pattern = new RegExp(`<meta\\b[^>]*\\bname=["']${name}["'][^>]*\\bcontent=(["'])(.*?)\\1`, 'i');
  const reverse = new RegExp(`<meta\\b[^>]*\\bcontent=(["'])(.*?)\\1[^>]*\\bname=["']${name}["']`, 'i');
  return (html.match(pattern) || html.match(reverse))?.[2]?.trim() || null;
}

function decode(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parsePage(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || null;
  const description = attr(html, 'description');
  const canonical = html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["']/i)?.[1] ||
    html.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']canonical["']/i)?.[1] || null;
  const robots = attr(html, 'robots') || '';
  const scripts = [...html.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim());
  const data = [];
  for (const text of scripts) {
    try {
      const parsed = JSON.parse(text);
      data.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch (error) {
      data.push({ __parseError: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    title: title ? decode(title) : null,
    description: description ? decode(description) : null,
    canonical,
    robots,
    h1: (html.match(/<h1(?:\s|>)/gi) || []).length,
    noindex: /\bnoindex\b/i.test(robots),
    scripts,
    data,
  };
}

function graphNodes(data) {
  return data.flatMap((item) => item && Array.isArray(item['@graph']) ? item['@graph'] : data);
}

function nodeWithType(nodes, type) {
  return nodes.find((node) => {
    const types = Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']];
    return types.includes(type);
  });
}

function required(node, properties, relPath) {
  for (const property of properties) {
    const value = node?.[property];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      violations.push(`${relPath}: JSON-LD ${node?.['@type'] || 'object'} missing ${property}`);
    }
  }
}

const SITE_URL_PROPERTIES = ['url', 'item', 'target', 'urlTemplate'];
/**
 * Without a configured origin the app omits every site URL rather than emitting
 * `null`. A value here means the omission regressed somewhere, so it is reported
 * per property. The walk deliberately looks only at these keys: `codeRepository`
 * and other genuinely external URLs stay.
 */
function assertNoSiteUrls(value, relPath) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSiteUrls(item, relPath);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const property of SITE_URL_PROPERTIES) {
    if (value[property] !== undefined) {
      violations.push(`${relPath}: JSON-LD ${property} must be omitted without NEXT_PUBLIC_SITE_URL`);
    }
  }
  for (const child of Object.values(value)) assertNoSiteUrls(child, relPath);
}

function checkJsonLd(relPath, page) {
  // Structured data exists to shape a search result. A noindex page has none,
  // so requiring it there would be ceremony rather than a check.
  if (page.noindex) return;
  if (page.scripts.length !== 1) {
    violations.push(`${relPath}: expected exactly one JSON-LD script, found ${page.scripts.length}`);
  }
  if (!page.scripts.length || page.data.some((item) => item.__parseError)) {
    for (const item of page.data.filter((value) => value.__parseError)) violations.push(`${relPath}: invalid JSON-LD (${item.__parseError})`);
    return;
  }
  const nodes = graphNodes(page.data);
  if (!RELEASE_CONFIGURED) assertNoSiteUrls(page.data, relPath);
  for (const node of page.data) if (node?.['@context'] !== 'https://schema.org') violations.push(`${relPath}: JSON-LD @context must be https://schema.org`);
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('w/')) {
    // Link-only entries keep unknown rights unknown rather than invent a licence.
    // `author` is optional: a withheld contact identity is omitted, never reassigned.
    required(nodeWithType(nodes, 'SoftwareSourceCode'), ['name', 'description', 'programmingLanguage', 'codeRepository', 'dateModified', 'isAccessibleForFree'], relPath);
    required(nodeWithType(nodes, 'BreadcrumbList'), ['itemListElement'], relPath);
  } else if (normalized.startsWith('integrations/') || normalized.startsWith('tags/') || normalized.startsWith('triggers/') || normalized.startsWith('grades/') || normalized.startsWith('complexity/')) {
    required(nodeWithType(nodes, 'CollectionPage'), ['name', 'description'], relPath);
    if (RELEASE_CONFIGURED) required(nodeWithType(nodes, 'CollectionPage'), ['url'], relPath);
    const itemList = nodeWithType(nodes, 'ItemList');
    if (itemList) required(itemList, ['itemListElement'], relPath);
  } else if (normalized === 'scanner/index.html') {
    const app = nodeWithType(nodes, 'WebApplication');
    required(app, ['name', 'applicationCategory', 'offers'], relPath);
    required(app?.offers, ['price'], relPath);
  } else if (normalized === 'index.html') {
    const site = nodeWithType(nodes, 'WebSite');
    required(site, ['name'], relPath);
    required(nodeWithType(nodes, 'Organization'), ['name'], relPath);
    if (RELEASE_CONFIGURED) {
      required(site, ['url', 'potentialAction'], relPath);
      required(nodeWithType(nodes, 'Organization'), ['url'], relPath);
      const action = site?.potentialAction;
      if (action?.['@type'] !== 'SearchAction') violations.push(`${relPath}: WebSite potentialAction must be SearchAction`);
      required(action, ['target'], relPath);
    }
  } else {
    if (!nodes.some((node) => node?.['@type'])) violations.push(`${relPath}: JSON-LD has no @type`);
  }
}

function urlPath(url) {
  const parsed = new URL(url);
  let pathname = parsed.pathname;
  if (BASE_PATH && (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`))) {
    pathname = pathname.slice(BASE_PATH.length) || '/';
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  else if (!pathname.endsWith('.html')) pathname += '/index.html';
  return pathname.replace(/^\//, '');
}

function checkSitemaps(noindexPaths) {
  const indexPath = path.join(OUT_DIR, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) {
    if (RELEASE_CONFIGURED && !PREVIEW_BUILD) violations.push('sitemap.xml missing in output directory');
    return 0;
  }
  const index = fs.readFileSync(indexPath, 'utf8');
  const children = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => path.basename(new URL(match[1]).pathname));
  let total = 0;
  for (const child of children) {
    if (!/^sitemap-[^/]+\.xml$/.test(child) || !fs.existsSync(path.join(OUT_DIR, child))) {
      violations.push(`Sitemap child missing on disk: ${child}`);
      continue;
    }
    const xml = fs.readFileSync(path.join(OUT_DIR, child), 'utf8');
    for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const url = match[1];
      if (url.endsWith('.xml')) continue;
      total++;
      let relative;
      try { relative = urlPath(url); } catch { violations.push(`Invalid sitemap URL: ${url}`); continue; }
      const target = path.join(OUT_DIR, relative);
      if (!fs.existsSync(target)) violations.push(`Sitemap URL does not exist on disk: ${url}`);
      if (noindexPaths.has(relative)) violations.push(`Noindex page found in sitemap: ${url}`);
    }
  }
  return total;
}

function main() {
  if (!fs.existsSync(OUT_DIR)) throw new Error(`Output directory does not exist: ${OUT_DIR}`);
  const noindexPaths = new Set();
  let pageCount = 0;
  for (const file of htmlFiles(OUT_DIR)) {
    const relative = path.relative(OUT_DIR, file).replace(/\\/g, '/');
    if (relative === '404.html' || relative === '404/index.html' || relative.startsWith('_not-found/')) continue;
    const html = fs.readFileSync(file, 'utf8'); const page = parsePage(html);
    pageCount++;
    if (page.noindex) noindexPaths.add(relative);
    if (PREVIEW_BUILD) for (const [invalid, message] of [[page.robots !== PREVIEW_ROBOTS, `preview robots directive must be "${PREVIEW_ROBOTS}"`], [page.canonical, 'preview output must not include a canonical link'], [page.scripts.length > 0, 'preview output must not include JSON-LD'], [/<meta\b[^>]*\bproperty=["']og:(?:url|image)["']/i.test(html), 'preview output must not include Open Graph URL/image metadata'], [/<meta\b[^>]*\bname=["']twitter:image["']/i.test(html), 'preview output must not include Twitter image metadata']]) if (invalid) violations.push(`${relative}: ${message}`);
    if (page.h1 !== 1) violations.push(`${relative}: expected exactly one h1, found ${page.h1}`);
    if (!page.title) violations.push(`${relative}: missing title`);
    else if (page.title.length > 60) violations.push(`${relative}: title is ${page.title.length} characters (max 60)`);
    if (isTruncatedTitle(page.title)) violations.push(`${relative}: title is visibly truncated — dangling separator or unclosed bracket (AUDIT-SEO-001) — "${page.title}"`);
    if (!page.description) violations.push(`${relative}: missing meta description`);
    else if (page.description.length < 50 || page.description.length > 160) violations.push(`${relative}: description is ${page.description.length} characters (50-160 required)`);
    // Preview carries neither canonical nor site URLs. In a normal build the
    // configured origin requires exactly one canonical; without an origin, any
    // canonical is a violation — there is no origin to point it at.
    if (!PREVIEW_BUILD) {
      if (RELEASE_CONFIGURED) {
        // Noindex pages do not need a canonical; /w/view deliberately has none.
        if (!page.canonical && !page.noindex) violations.push(`${relative}: missing canonical link`);
      } else {
        if (page.canonical) violations.push(`${relative}: canonical must be omitted without NEXT_PUBLIC_SITE_URL`);
        for (const [pattern, message] of [
          [/<meta\b[^>]*\bproperty=["']og:url["']/i, 'og:url must be omitted without NEXT_PUBLIC_SITE_URL'],
          [/<meta\b[^>]*\bproperty=["']og:image["']/i, 'og:image must be omitted without NEXT_PUBLIC_SITE_URL'],
          [/<meta\b[^>]*\bname=["']twitter:image["']/i, 'twitter:image must be omitted without NEXT_PUBLIC_SITE_URL'],
        ]) if (pattern.test(html)) violations.push(`${relative}: ${message}`);
      }
    }
    checkJsonLd(relative, page);
  }
  const sitemapUrls = checkSitemaps(noindexPaths);
  const noindex = noindexPaths.size;
  const indexable = pageCount - noindex;
  console.log(`Total HTML pages checked: ${pageCount}`);
  console.log(`Indexable pages: ${indexable}`);
  console.log(`Noindex pages: ${noindex}`);
  console.log(`Total Sitemap URLs verified: ${sitemapUrls}`);
  console.log(`Total Violations: ${violations.length}`);
  if (violations.length) {
    console.error('\nViolations:');
    for (const violation of violations) console.error(` - ${violation}`);
    process.exitCode = 1;
  } else {
    console.log('SEO Audit PASSED cleanly!');
  }
}

try { main(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
