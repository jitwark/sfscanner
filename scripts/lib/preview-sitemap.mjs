import fs from 'node:fs';
import path from 'node:path';

const SITEMAP_FILE = /^sitemap(?:[-_]?[A-Za-z0-9_-]+)?\.xml$/iu;

function removeSitemaps(directory, root, removed) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SITEMAP_FILE.test(entry.name)) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        removed.push(path.relative(root, fullPath));
      } else {
        removeSitemaps(fullPath, root, removed);
      }
    } else if (SITEMAP_FILE.test(entry.name)) {
      fs.rmSync(fullPath);
      removed.push(path.relative(root, fullPath));
    }
  }
}

/** Remove generated sitemap XML and write a crawl-blocking preview robots file. */
export function writePreviewRobots(outDir) {
  const removed = [];
  if (fs.existsSync(outDir)) {
    removeSitemaps(outDir, outDir, removed);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');
  return removed.sort();
}
