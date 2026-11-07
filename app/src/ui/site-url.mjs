/**
 * The one base-path rule, in plain JavaScript.
 *
 * It is plain JavaScript with a `.d.mts` beside it because two runtimes need the
 * exact same rule and one of them has no transpile step: the Next app imports
 * this file and its types, and the Node build scripts (`generate-sitemaps.mjs`,
 * `check-page-parity.mjs`, `check-web-release-parity.mjs`) import the same file
 * directly. Two copies of "where is the site served from" is how a canonical
 * and a sitemap end up disagreeing.
 */
export function normalizeBasePath(value = '') {
  const trimmed = String(value ?? '').replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

export function sitePath(path) {
  return `${normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH ?? '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The release origin must agree with the base path it is deployed under:
 * `https://owner.github.io/repo` and `/repo` describe one deployment, and a
 * mismatch means every canonical and sitemap URL points somewhere else.
 */
export function assertUrlMatchesBasePath(siteUrl, basePath) {
  const expected = new URL(siteUrl).pathname.replace(/\/$/, '');
  const actual = normalizeBasePath(basePath);
  if (expected !== actual) {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL path ${expected || '/'} does not match NEXT_PUBLIC_BASE_PATH ${actual || '/'}`,
    );
  }
}

/**
 * Read and validate the release origin at call time. The release gates fail
 * closed on a missing value: there is no default origin, because a deployed
 * host that nobody configured is not an identity, it is a guess.
 */
export function requireSiteUrl(raw = process.env.NEXT_PUBLIC_SITE_URL) {
  const value = (raw ?? '').trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('NEXT_PUBLIC_SITE_URL must be an absolute https URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('NEXT_PUBLIC_SITE_URL must be an absolute https URL without credentials, query, or fragment');
  }
  return url.href.replace(/\/$/, '');
}
