/**
 * The release gate: one origin, one base path, in every emitted document.
 *
 * Every other gate holds the export to a rule of its own making. This one holds
 * it to the deployment's identity: no dead origin, no private repository link,
 * no canonical or structured URL that leaves the configured origin, no missing
 * base-path prefix, no missing asset, no page without a CSP, and a robots file
 * whose `Sitemap:` names this origin. It scans the whole export — including
 * `out/public/**` and `robots.txt` — because a stale copy of a page is exactly
 * the failure it exists to catch.
 *
 * It fails closed without `NEXT_PUBLIC_SITE_URL`: there is no default origin to
 * check against, and `app/out/app/public` (B-07, owner-owned) is a real blocker
 * rather than something this script may suppress.
 *
 * Usage: npm run check:web-release [--dataset-dir <dir>] [--source-data-dir <dir>]
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertUrlMatchesBasePath, normalizeBasePath, requireSiteUrl } from '../app/src/ui/site-url.mjs';

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/**
 * Whether a published URL belongs to the configured site.
 *
 * `startsWith(siteUrl)` accepted `https://host/repository/` and
 * `https://host/repo-evil` for a site served from `https://host/repo`, which is
 * exactly the identity drift this gate exists to catch. Same origin plus the
 * exact base pathname or a slash-boundary descendant is the whole rule; a root
 * deployment (`base === ''`) accepts any same-origin URL.
 */
function isWithinSite(value, siteUrl) {
  let candidate;
  let base;
  try {
    candidate = new URL(value);
    base = new URL(siteUrl);
  } catch {
    return false;
  }
  if (candidate.origin !== base.origin) return false;
  const basePathname = base.pathname.replace(/\/+$/, '');
  if (basePathname === '') return true;
  return candidate.pathname === basePathname || candidate.pathname.startsWith(`${basePathname}/`);
}

const LOCAL_SOURCE_MANIFEST = path.join('data', 'manifest.json');

/**
 * The manifest a dataset bundle's `sourceManifestSha256` names.
 *
 * `sourceManifestSha256` is the digest of the corpus manifest the projection
 * read (`data/manifest.json`), but the export restamps `out/data/manifest.json`
 * while pruning it, so the shipped copy legitimately differs. Compare against
 * the source corpus manifest when one is configured or present, and fall back
 * to the export's own copy only when there is no source manifest at all.
 */
function resolveSourceManifestPath(sourceDataDir, exportManifestPath) {
  if (sourceDataDir) return path.join(sourceDataDir, 'manifest.json');
  return fs.existsSync(LOCAL_SOURCE_MANIFEST) ? LOCAL_SOURCE_MANIFEST : exportManifestPath;
}

export function evaluate({ outDir, siteUrl, basePath = '', datasetDir = null, sourceDataDir = null }) {
  const violations = [];
  const base = normalizeBasePath(basePath);
  const files = walk(outDir);
  if (files.length === 0) violations.push(`${outDir}: no exported files to check`);

  for (const file of files.filter((name) => /\.(?:html|xml|txt)$/.test(name))) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(outDir, file).replaceAll(path.sep, '/');
    if (text.includes('https://n8n-community.com')) violations.push(`${rel}: dead origin`);
    if (text.includes('github.com/jitwark/n8n-community')) violations.push(`${rel}: private repository link`);
    if (text.includes('GitHub (private)')) violations.push(`${rel}: private label`);
    for (const match of text.matchAll(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/gi)) {
      if (!isWithinSite(match[1], siteUrl)) violations.push(`${rel}: canonical ${match[1]}`);
    }
    for (const match of text.matchAll(/og:url["']\s+content=["']([^"']+)|"url"\s*:\s*"([^"]+)"/g)) {
      const value = match[1] ?? match[2];
      if (value && !isWithinSite(value, siteUrl)) violations.push(`${rel}: structured URL ${value}`);
    }
    if (/\.html$/.test(file) && !text.includes('Content-Security-Policy')) violations.push(`${rel}: CSP missing`);
    if (/\.html$/.test(file)) {
      for (const match of text.matchAll(/\s(?:href|src)=["'](\/[^"']*)["']/g)) {
        const pathname = match[1].split(/[?#]/)[0];
        if (base && pathname !== base && !pathname.startsWith(`${base}/`)) violations.push(`${rel}: base path ${pathname}`);
        // Asset URLs are percent-encoded; the export stores the decoded path
        // (for example `w/%5Bslug%5D/…js` lives at `w/[slug]/…js`).
        let assetPath;
        try {
          assetPath = decodeURIComponent(pathname.slice(base.length));
        } catch {
          assetPath = pathname.slice(base.length);
        }
        if (!fs.existsSync(path.join(outDir, assetPath))) violations.push(`${rel}: missing asset ${pathname}`);
      }
    }
  }

  const dataDir = path.join(outDir, 'data');
  const manifestPath = path.join(dataDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    violations.push('data/manifest.json missing or unreadable');
  }
  if (manifest !== undefined) {
    if (!Array.isArray(manifest?.artifacts)) {
      violations.push('data/manifest.json artifacts missing');
    } else {
      for (const artifact of manifest.artifacts) {
        const rel = typeof artifact?.path === 'string' ? artifact.path : '';
        const segments = rel.split(/[\\/]/);
        const unsafe = rel === '' || path.isAbsolute(rel) || rel.includes('\0')
          || segments.some((segment) => segment === '..' || segment === '');
        const absolute = path.resolve(dataDir, rel);
        if (unsafe || (absolute !== dataDir && !absolute.startsWith(`${dataDir}${path.sep}`))) {
          violations.push(`data/manifest.json artifact escapes out/data: ${JSON.stringify(rel)}`);
          continue;
        }
        let stat;
        try { stat = fs.statSync(absolute); } catch { stat = undefined; }
        if (!stat?.isFile()) violations.push(`declared artifact missing from out/data: ${rel}`);
      }
    }
  }

  const robots = path.join(outDir, 'robots.txt');
  const sitemap = path.join(outDir, 'sitemap.xml');
  if (!fs.existsSync(robots)) violations.push('robots.txt missing');
  else if (!fs.readFileSync(robots, 'utf8').includes(`Sitemap: ${siteUrl}/sitemap.xml`)) violations.push('robots Sitemap origin mismatch');
  if (!fs.existsSync(sitemap)) violations.push('sitemap.xml missing');
  else if (!fs.readFileSync(sitemap, 'utf8').includes(`<loc>${siteUrl}`)) violations.push('sitemap origin mismatch');

  if (datasetDir !== null && datasetDir !== undefined) {
    const datasetManifestPath = datasetDir ? path.join(datasetDir, 'public-release.json') : '';
    if (!datasetDir || !fs.existsSync(datasetDir)) {
      violations.push(`dataset directory does not exist: ${datasetDir || '(empty)'}`);
    } else if (!fs.existsSync(datasetManifestPath)) {
      violations.push(`dataset manifest missing from ${datasetDir}: public-release.json`);
    } else {
      try {
        const bundleRaw = fs.readFileSync(datasetManifestPath, 'utf8');
        const bundle = JSON.parse(bundleRaw);
        const SHA256_HEX = /^[0-9a-f]{64}$/;
        if (!bundle.sourceManifestSha256 || !SHA256_HEX.test(bundle.sourceManifestSha256)) {
          violations.push(`source-manifest SHA missing or malformed in dataset bundle: ${bundle.sourceManifestSha256}`);
        } else {
          const sourceManifestPath = resolveSourceManifestPath(sourceDataDir, manifestPath);
          let sourceManifestRaw;
          try {
            sourceManifestRaw = fs.readFileSync(sourceManifestPath);
          } catch {
            violations.push(`source manifest missing or unreadable: ${sourceManifestPath}`);
          }
          if (sourceManifestRaw !== undefined) {
            const sourceManifestDigest = crypto.createHash('sha256').update(sourceManifestRaw).digest('hex');
            if (bundle.sourceManifestSha256 !== sourceManifestDigest) {
              violations.push(`source-manifest SHA mismatch between site and dataset: site=${sourceManifestDigest} dataset=${bundle.sourceManifestSha256}`);
            }
          }
        }
        const isCount = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
        if (!isCount(manifest?.totalEntries) || !isCount(bundle.relations?.workflows)) {
          violations.push(`workflow count missing, negative or non-integer between site (${manifest?.totalEntries}) and dataset (${bundle.relations?.workflows})`);
        } else if (bundle.relations.workflows !== manifest.totalEntries) {
          violations.push(`workflow count mismatch between site (${manifest.totalEntries}) and dataset (${bundle.relations.workflows})`);
        }
      } catch (err) {
        violations.push(`dataset public-release.json unreadable or malformed: ${err.message}`);
      }
    }
  }
  return { violations };
}

export function resolveDatasetDir(argv = process.argv, env = process.env) {
  const flagIndex = argv.indexOf('--dataset-dir');
  if (flagIndex !== -1) return flagIndex + 1 < argv.length ? argv[flagIndex + 1] : '';
  const envVal = env.DATASET_BUNDLE_DIR;
  return typeof envVal === 'string' && envVal.trim().length > 0 ? envVal.trim() : null;
}

export function resolveSourceDataDir(argv = process.argv) {
  const flagIndex = argv.indexOf('--source-data-dir');
  const value = flagIndex !== -1 ? argv[flagIndex + 1] : 'data';
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'data';
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  let siteUrl;
  try {
    siteUrl = requireSiteUrl();
    assertUrlMatchesBasePath(siteUrl, process.env.NEXT_PUBLIC_BASE_PATH ?? '');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const rawDataset = resolveDatasetDir(process.argv, process.env);
  const datasetDir = rawDataset !== null ? (rawDataset ? path.resolve(rawDataset) : '') : null;
  const outFlagIdx = process.argv.indexOf('--out-dir');
  const outFlag = outFlagIdx !== -1 && process.argv[outFlagIdx + 1] ? process.argv[outFlagIdx + 1] : null;
  const result = evaluate({
    outDir: path.resolve(outFlag ?? 'app/out'),
    siteUrl,
    basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? '',
    datasetDir,
    sourceDataDir: path.resolve(resolveSourceDataDir(process.argv)),
  });
  if (result.violations.length) {
    console.error(result.violations.join('\n'));
    process.exit(1);
  }
  console.log(`web release parity: ${siteUrl} verified against app/out`);
}
