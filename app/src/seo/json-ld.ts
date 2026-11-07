import React from 'react';
import type { Entry } from '@hub/contracts';
import { getPrimaryIntegration } from './og-image';
import { absoluteSiteUrl } from './site-origin';
import { SITE_NAME } from './page-meta';
import { isPreviewBuild } from './robots';
import { capitalize } from './text-format';
import { publishableAuthorName } from '../catalogue/author-display';
/**
 * A schema.org ListItem whose `item` exists only when a release origin does.
 * `cleanObject` strips `undefined` but keeps `null`, and a JSON-LD field that
 * serializes as `"url": null` is worse than an omitted one — so the field is
 * spread in conditionally rather than assigned a nullable value.
 */
function listItem(position: number, name: string, path: string) {
  const item = absoluteSiteUrl(path);
  return { '@type': 'ListItem', position, name, ...(item ? { item } : {}) };
}

function licenceUrl(entry: Entry): string | undefined {
  if (entry.rights?.licenceUrl) return entry.rights.licenceUrl;
  const id = entry.rights?.licence?.trim();
  return id ? `https://spdx.org/licenses/${encodeURIComponent(id)}.html` : undefined;
}
/**
 * Deeply remove undefined properties from an object/array so no undefined is serialized.
 */
export function cleanObject<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj
      .filter((item) => item !== undefined)
      .map((item) => cleanObject(item)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const res: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        res[key] = cleanObject(value);
      }
    }
    return res as T;
  }
  return obj;
}

export function entryJsonLd(entry: Entry) {
  const primaryInt = getPrimaryIntegration(entry.structure?.integrations);
  const primaryIntFormatted = primaryInt !== 'generic' ? capitalize(primaryInt) : undefined;
  const publishableAuthor = publishableAuthorName(entry.source?.author?.name);
  const softwareSourceCode: Record<string, unknown> = {
    '@type': 'SoftwareSourceCode',
    name: entry.title,
    description: entry.summary || entry.title,
    programmingLanguage: 'n8n workflow JSON',
    codeRepository: entry.source?.permalink,
    license: licenceUrl(entry),
    ...(publishableAuthor ? { author: { '@type': 'Person', name: publishableAuthor } } : {}),
    dateModified: entry.source?.committedAt || entry.source?.fetchedAt,
    isAccessibleForFree: true,
  };

  const breadcrumbsListElements = [
    listItem(1, 'Home', '/'),
    listItem(2, 'Integrations', '/integrations/'),
  ];

  if (primaryIntFormatted) {
    breadcrumbsListElements.push(listItem(3, primaryIntFormatted, `/integrations/${primaryInt}/`));
    breadcrumbsListElements.push(listItem(4, entry.title, `/w/${entry.slug}/`));
  } else {
    breadcrumbsListElements.push(listItem(3, entry.title, `/w/${entry.slug}/`));
  }

  const breadcrumbList = {
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbsListElements,
  };

  return cleanObject({
    '@context': 'https://schema.org',
    '@graph': [softwareSourceCode, breadcrumbList],
  });
}

export function hubJsonLd(
  kind: string,
  slug: string,
  items: Array<{ title: string; slug: string; isIndexable?: boolean }> = [],
  page = 1,
) {
  const formattedSlug = capitalize(slug);
  const pagePath = page > 1 ? `${page}/` : '';
  const collectionPath = kind === 'security' ? 'security' : `${kind}s`;
  const url = absoluteSiteUrl(`/${collectionPath}/${slug}/${pagePath}`);

  const collectionPage = {
    '@type': 'CollectionPage',
    name: `${formattedSlug} n8n Workflows`,
    description: `Collection of n8n workflow templates for ${formattedSlug}.`,
    ...(url ? { url } : {}),
  };

  const first24 = items.filter((item) => item.isIndexable !== false).slice(0, 24);
  const itemListElements = first24.map((item, idx) => {
    const itemUrl = absoluteSiteUrl(`/w/${item.slug}/`);
    return {
      '@type': 'ListItem',
      position: idx + 1,
      name: item.title,
      ...(itemUrl ? { url: itemUrl } : {}),
    };
  });

  const itemList = first24.length > 0
    ? {
        '@type': 'ItemList',
        itemListElement: itemListElements,
      }
    : undefined;

  return cleanObject({
    '@context': 'https://schema.org',
    '@graph': [collectionPage, itemList],
  });
}

export function scannerJsonLd() {
  const webApp = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'n8n Workflow Security Scanner',
    applicationCategory: 'SecurityApplication',
    operatingSystem: 'Any',
    description: 'Browser-based static security analyzer for n8n workflows.',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
  };

  return cleanObject(webApp);
}

export function homeJsonLd() {
  const site = absoluteSiteUrl('/');
  const searchTemplate = absoluteSiteUrl('/library/?q={search_term_string}');

  const webSite = {
    '@type': 'WebSite',
    name: SITE_NAME,
    ...(site ? { url: site } : {}),
    ...(searchTemplate
      ? {
          potentialAction: {
            '@type': 'SearchAction',
            target: { '@type': 'EntryPoint', urlTemplate: searchTemplate },
            'query-input': 'required name=search_term_string',
          },
        }
      : {}),
  };

  const organization = {
    '@type': 'Organization',
    name: SITE_NAME,
    ...(site ? { url: site } : {}),
  };

  return cleanObject({
    '@context': 'https://schema.org',
    '@graph': [webSite, organization],
  });
}
/**
 * Structured data for a standalone content or index page.
 *
 * `breadcrumbTrail` names the ancestors, excluding Home and excluding the page
 * itself, so `/integrations/` passes an empty trail and a nested index would
 * pass its parents in order.
 */
export function pageJsonLd(options: {
  name: string;
  path: string;
  description: string;
  collection?: boolean;
  breadcrumbTrail?: Array<{ name: string; path: string }>;
  /** Entries this page lists. Emits an ItemList so the listing is machine-readable. */
  items?: Array<{ name: string; path: string }>;
}) {
  const pageUrl = absoluteSiteUrl(options.path);
  const site = absoluteSiteUrl('/');
  const page = {
    '@type': options.collection ? 'CollectionPage' : 'WebPage',
    name: options.name,
    ...(pageUrl ? { url: pageUrl } : {}),
    description: options.description,
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, ...(site ? { url: site } : {}) },
  };

  const trail = [
    { name: 'Home', path: '/' },
    ...(options.breadcrumbTrail ?? []),
    { name: options.name, path: options.path },
  ];

  const breadcrumbList = {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((step, index) => listItem(index + 1, step.name, step.path)),
  };

  // Schema.org caps nothing, but a listing page with hundreds of ListItem nodes
  // bloats every HTML response for no ranking gain; the first 24 describe the page.
  const itemList = options.items?.length
    ? {
        '@type': 'ItemList',
        name: options.name,
        numberOfItems: options.items.length,
        itemListElement: options.items.slice(0, 24).map((item, index) => {
          const url = absoluteSiteUrl(item.path);
          return {
            '@type': 'ListItem',
            position: index + 1,
            name: item.name,
            ...(url ? { url } : {}),
          };
        }),
      }
    : null;

  return cleanObject({
    '@context': 'https://schema.org',
    '@graph': itemList ? [page, breadcrumbList, itemList] : [page, breadcrumbList],
  });
}
/**
 * Workflow titles and author names come from repositories we crawl, so they are
 * attacker-controlled. `JSON.stringify` escapes quotes but not `<`, so a title
 * containing `</script><script>alert(1)</script>` closes this element and runs
 * as page script. Escaping the four characters that can terminate a script
 * element or break a JS parser keeps the payload inert; JSON.parse still yields
 * the identical string, so structured data is unchanged.
 */
const HTML_UNSAFE = /[<>&\u2028\u2029]/g;
const HTML_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(HTML_UNSAFE, (c) => HTML_ESCAPES[c] ?? c);
}

export function JsonLdScript({ data }: { data: unknown }) {
  if (isPreviewBuild()) return null;
  const cleaned = cleanObject(data);
  return React.createElement('script', {
    type: 'application/ld+json',
    dangerouslySetInnerHTML: { __html: serializeJsonLd(cleaned) },
  });
}
