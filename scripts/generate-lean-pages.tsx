/**
 * Write a crawlable page for every workflow Next did not pre-render.
 *
 * Runs after `next build` and before `generate-sitemaps.mjs`, which enumerates
 * the export and reads each page's own `robots` meta — so a page written here
 * enters the sitemap by existing and saying it may be indexed, exactly as a
 * Next-rendered one does.
 *
 * Why a second generator at all: Next's static export writes six files per page
 * (`index.html` plus five RSC sidecars) totalling 330–500 KB, so 12,923 of them
 * would cost 4.3 GB against a 1 GB GitHub Pages ceiling that `data/` already
 * spends 251 MB of. Rendering the same React components through
 * `renderToStaticMarkup` costs one file and about 24 KB. The measurement is in
 * `docs/audit/2026-08-25/scripts/page-weight-measure.tsx`; the two tiers are
 * held to the same required elements by `scripts/check-page-parity.mjs`.
 */
import React from 'react';
(globalThis as unknown as { React: unknown }).React = React;
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { isIndexable, type Entry } from '@hub/contracts';
import { buildRelatedIndex, computeRelated } from '../app/src/catalogue/related';
import { qualityScore } from '../app/src/catalogue/prerender-list';
import { readPreviewSync } from '../app/src/catalogue/preview-node';
import { DetailLean } from '../app/src/ui/detail/detail-lean';
import { entryDescription, entryMeta } from '../app/src/seo/page-meta';
import { absoluteSiteUrl } from '../app/src/seo/site-origin';
import { isPreviewBuild } from '../app/src/seo/robots';
import { cleanObject, entryJsonLd, serializeJsonLd } from '../app/src/seo/json-ld';
import { getThemeToggleScript } from '../app/src/ui/theme/theme-script';
import { getLeanPageEnhancementsScript } from '../app/src/ui/detail/lean-enhancements-script';
import { normalizeBasePath } from '../app/src/ui/site-url.mjs';
import { readShell, renderDocument, withBasePath } from './lean-pages/document-shell.js';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'app', 'out');
const dataDir = path.join(root, 'data');

function readEntries(): Entry[] {
  const entries: Entry[] = [];
  for (const file of fs.readdirSync(dataDir).sort()) {
    if (!/^catalogue-\d+\.json$/.test(file)) continue;
    entries.push(...(JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')) as Entry[]));
  }
  return entries;
}

function metaStrings(entry: Entry): { title: string; description: string } {
  const meta = entryMeta(entry);
  return {
    title: typeof meta.title === 'string' ? meta.title : entry.title,
    // `entryMeta` truncates to 155; `check-seo.mjs` caps at 160.
    description: typeof meta.description === 'string' ? meta.description : entryDescription(entry),
  };
}

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const behaviorScript = `${getThemeToggleScript()}\n${getLeanPageEnhancementsScript(basePath)}`;
const behaviorHash = createHash('sha256').update(behaviorScript).digest('hex').slice(0, 16);
const behaviorFileName = `lean-page-behavior-${behaviorHash}.js`;
// Not `withBasePath`: that rewrites `href="…"` inside markup, so a bare URL
// passed through it matched nothing and stayed root-absolute. On the deployment
// every lean page then asked for `/lean-page-behavior-*.js` at the site root,
// got a 404, and ran no behaviour script at all — no pan, no zoom, no download.
const behaviorScriptUrl = `${normalizeBasePath(basePath)}/${behaviorFileName}`;
fs.writeFileSync(path.join(outDir, behaviorFileName), behaviorScript, 'utf8');
const shell = readShell(path.join(outDir, 'w', 'view', 'index.html'));
const entries = readEntries();
const relatedIndex = buildRelatedIndex(entries, qualityScore);

let written = 0;
let skipped = 0;
let bytes = 0;

for (const entry of entries) {
  const dir = path.join(outDir, 'w', entry.slug);
  // Next owns the pages it pre-rendered: they are richer, they hydrate, and
  // overwriting one would replace a working canvas with a link to one.
  //
  // Keyed on the RSC sidecar, not on `index.html` existing. Keying on the page
  // meant a second run found its own output and skipped all 12,971 — so a fix
  // to this generator could not be applied without deleting the export first,
  // which is precisely when nobody remembers to.
  if (fs.existsSync(path.join(dir, 'index.txt'))) {
    skipped += 1;
    continue;
  }

  const related = computeRelated(entry, entries, 6, qualityScore, relatedIndex)
    .map((item) => ({ id: item.id, slug: item.slug, title: item.title }));
  const { title, description } = metaStrings(entry);

  const html = renderDocument(shell, {
    title,
    description,
    canonical: absoluteSiteUrl(`/w/${entry.slug}/`) ?? undefined,
    index: isIndexable(entry),
    preview: isPreviewBuild(),
    jsonLd: serializeJsonLd(cleanObject(entryJsonLd(entry))),
    body: withBasePath(renderToStaticMarkup(<DetailLean entry={entry} related={related} preview={readPreviewSync(entry)} />), basePath),
    behaviorScriptUrl,
  });

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
  written += 1;
  bytes += Buffer.byteLength(html, 'utf8');
}

const mean = written > 0 ? Math.round(bytes / written) : 0;
process.stdout.write(
  `lean pages: ${written} written, ${skipped} left to Next, `
  + `${(bytes / 1048576).toFixed(0)} MB at ${(mean / 1024).toFixed(1)} KB each\n`,
);
