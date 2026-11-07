import fs from 'node:fs';
import path from 'node:path';

const PREVIEW_ROBOTS = 'User-agent: *\nDisallow: /\n';
const SITEMAP_FILE = /^sitemap(?:-[A-Za-z0-9_-]+)?\.xml$/;
const TEXT_FILE = /\.(?:html|js)$/i;
const TELEMETRY_MARKER = /(?:googletagmanager(?:\.com|\/)|google-analytics\.com|firebase\/analytics|measurementId\s*[:=]|(?:window\.)?gtag\s*\(|(?:navigator\.)?sendBeacon\s*\(|mixpanel\.(?:init|track|identify)\s*\(|(?:https?:)?\/\/[^"'\\s<]*(?:segment\.io|plausible\.io))/i;

function walk(directory, root, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, root, files);
    else files.push({ fullPath, relative: path.relative(root, fullPath).replace(/\\/g, '/') });
  }
  return files;
}

/** Return fail-closed violations that must stop a preview deploy. */
export function findPreviewSafetyViolations(outDir) {
  if (!fs.existsSync(outDir)) return [`Output directory does not exist: ${outDir}`];

  const violations = [];
  const files = walk(outDir, outDir);
  const htmlFiles = files.filter(({ relative }) => relative.toLowerCase().endsWith('.html'));
  const robots = files.find(({ relative }) => relative === 'robots.txt');

  if (!robots || fs.readFileSync(robots.fullPath, 'utf8') !== PREVIEW_ROBOTS) {
    violations.push('robots.txt must disallow all routes and contain no sitemap pointer');
  }
  if (robots && /^\s*sitemap\s*:/im.test(fs.readFileSync(robots.fullPath, 'utf8'))) {
    violations.push('robots.txt contains a sitemap pointer');
  }

  for (const file of files.filter(({ relative }) => SITEMAP_FILE.test(path.basename(relative)))) {
    violations.push(`${file.relative}: sitemap file must not be present in preview output`);
  }
  for (const file of htmlFiles) {
    const content = fs.readFileSync(file.fullPath, 'utf8');
    if (!/<meta\b[^>]*\bname=["']robots["'][^>]*\bcontent=["']noindex, nofollow, noarchive, nosnippet["']/i.test(content)) {
      violations.push(`${file.relative}: missing complete preview noindex robots directive`);
    }
  }
  for (const file of files.filter(({ relative }) => TEXT_FILE.test(relative))) {
    const content = fs.readFileSync(file.fullPath, 'utf8');
    if (TELEMETRY_MARKER.test(content)) violations.push(`${file.relative}: telemetry marker detected`);
  }

  return violations.sort();
}
