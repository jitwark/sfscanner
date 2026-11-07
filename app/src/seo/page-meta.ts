import type { Metadata } from 'next';
import { isIndexable, type Entry } from '@hub/contracts';
import { resolveOgImage } from './og-image';
import { absoluteSiteUrl } from './site-origin';
import { normalizeDisplayText, safeHttpUrl } from './hostile-text';
import { isPreviewBuild, robotsMetadata } from './robots';
import { composeEntryTitle, stripTrailingSeparators } from './entry-title';
import { capitalize, truncateWordBoundary } from './text-format';
// Compatibility export for existing app consumers; this is the shared contracts predicate, not a second rule.
export { isIndexable } from '@hub/contracts';
// Compatibility export: moved to text-format.ts to keep this file under the line cap.
export { truncateWordBoundary } from './text-format';

export const SITE_NAME = 'n8n-secureflow';

/**
 * The canonical link for a fixed page, or nothing when no release origin is
 * configured. Root-absolute canonicals would drop a Pages base path once
 * `metadataBase` is set, so every page passes the composed absolute URL.
 */
export function canonicalAlternates(path: string): { canonical: string } | undefined {
  const canonical = absoluteSiteUrl(path);
  return canonical ? { canonical } : undefined;
}

/**
 * A meta description of at least 50 characters, built only from facts already
 * recorded on the entry.
 *
 * Roughly 200 corpus summaries are shorter than a search engine will display,
 * because the upstream workflow was named but never described. Rather than
 * inventing prose, this appends what the scanner and parser measured: the
 * services involved, how the workflow starts, and how large it is.
 */
export function entryDescription(entry: Entry): string {
  const summary = (entry.summary || entry.title || '').trim();
  if (summary.length >= 50) return summary;

  const structure = entry.structure;
  const facts: string[] = [];
  const integrations = (structure?.integrations ?? []).slice(0, 3).map(capitalize);
  if (integrations.length > 0) facts.push(`Connects ${integrations.join(', ')}`);
  if (structure?.trigger) facts.push(`starts from ${structure.trigger.toLowerCase()}`);
  if (structure?.nodeCount) {
    facts.push(
      `${structure.nodeCount} nodes and ${structure.connectionCount ?? 0} connections`,
    );
  }

  const detail = facts.length > 0 ? `${facts.join(', ')}.` : '';
  const base = summary ? `${summary.replace(/\.$/, '')}. ${detail}` : detail;
  const composed = base.trim();
  return composed.length >= 50
    ? composed
    : `${composed} An n8n workflow indexed with its source, licence, and security scan.`.trim();
}

/**
 * Generate Next.js Metadata for a workflow entry page.
 */
export function entryMeta(entry: Entry): Metadata {
  const primaryInts = (entry.structure?.integrations || []).slice(0, 2).map((i) => capitalize(i));
  const trigger = entry.structure?.trigger;

  // Composed from complete segments (name, then qualifier, then site name) so
  // a title never truncates onto dangling punctuation — see entry-title.ts
  // (AUDIT-SEO-001). normalizeDisplayText inside composeEntryTitle strips
  // invisible characters before anything is measured against the budget.
  const title = composeEntryTitle(entry.title, { integrations: primaryInts, trigger }, SITE_NAME, 60);
  const description = truncateWordBoundary(normalizeDisplayText(entryDescription(entry)), 155);

  const canonicalUrl = absoluteSiteUrl(`/w/${entry.slug}/`);
  const preview = isPreviewBuild();

  const indexable = isIndexable(entry);
  const ogImageUrl = resolveOgImage(entry);
  const showUrls = !preview && canonicalUrl !== null;

  return {
    title,
    description,
    ...(showUrls ? { alternates: { canonical: canonicalUrl } } : {}),
    robots: robotsMetadata(indexable),
    openGraph: {
      title,
      description,
      siteName: SITE_NAME,
      type: 'article',
      ...(showUrls && ogImageUrl ? {
        url: canonicalUrl,
        images: [{ url: ogImageUrl, width: 1200, height: 630, alt: title }],
      } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      ...(showUrls && ogImageUrl ? { images: [ogImageUrl] } : {}),
    },
  };
}

/**
 * Generate Next.js Metadata for hub pages (integrations, tags, etc.).
 */
export function hubMeta(kind: string, slug: string, page = 1, count = 0): Metadata {
  // Hub slugs are derived from node type names, which come from crawled
  // workflows, so they are externally sourced too.
  const formattedSlug = capitalize(normalizeDisplayText(slug, 80));
  const pageSuffix = page > 1 ? ` (Page ${page})` : '';
  const rawTitle = `${formattedSlug} n8n Workflows${pageSuffix} | ${SITE_NAME}`;
  // Hub titles are not the AUDIT-SEO-001 defect (that was catalogue entry
  // titles), but the corpus-wide gate checks every page, and a long
  // integration/tag slug can still push this past 60 — strip a dangling
  // separator the word-boundary cut may have left, same allowlist as
  // composeEntryTitle.
  const title = stripTrailingSeparators(truncateWordBoundary(rawTitle, 60));

  const countStr = count > 0 ? `${count} ` : '';
  const rawDesc = `Explore ${countStr}n8n workflow templates for ${formattedSlug}. Page ${page} of community-contributed automation workflows with security analysis.`;
  const description = truncateWordBoundary(rawDesc, 155);

  const pagePath = page > 1 ? `${page}/` : '';
  const collectionPath = collectionPathFor(kind);
  const canonicalUrl = absoluteSiteUrl(
    slug === 'index' || (kind === 'library' && slug === 'library')
      ? `/${collectionPath}/`
      : `/${collectionPath}/${slug}/${pagePath}`,
  );

  const defaultOgImage = absoluteSiteUrl('/og/og-generic-LOW.png');
  const preview = isPreviewBuild();
  const showUrls = !preview && canonicalUrl !== null;

  return {
    title,
    description,
    ...(showUrls ? { alternates: { canonical: canonicalUrl } } : {}),
    robots: robotsMetadata(true),
    openGraph: {
      title,
      description,
      siteName: SITE_NAME,
      type: 'website',
      ...(showUrls && defaultOgImage ? {
        url: canonicalUrl,
        images: [{ url: defaultOgImage, width: 1200, height: 630, alt: title }],
      } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      ...(showUrls && defaultOgImage ? { images: [defaultOgImage] } : {}),
    },
  };
}

const COLLECTION_PATHS: Record<string, string> = {
  library: 'library',
  integration: 'integrations',
  tag: 'tags',
  security: 'security',
  trigger: 'triggers',
  source: 'sources',
};

function collectionPathFor(kind: string): string {
  return COLLECTION_PATHS[kind] ?? `${kind.replace(/s$/, '')}s`;
}
