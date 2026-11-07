const REVALIDATE = 'public,max-age=0,must-revalidate';
const MUTABLE = 'public,max-age=300,must-revalidate';
const IMMUTABLE = 'public,max-age=31536000,immutable';

const POLICIES = {
  html: REVALIDATE,
  'release-pointer': REVALIDATE,
  'immutable-release-data': IMMUTABLE,
  'mutable-metadata': MUTABLE,
  'hashed-asset': IMMUTABLE,
  legal: REVALIDATE,
};
const RELEASE_ARTIFACT_PATH = /^\/data\/releases\/[^/]+\/[^/]+(?:\/[^/]+)*$/u;
const AMBIGUOUS_PATH_ENCODING = /%(?:2e|2f|5c)/iu;

function fallbackClass(pathname) {
  return /\/data\//u.test(pathname) ? 'mutable-metadata' : 'html';
}

/**
 * Classifies the five documented Hosting policy families. HTML and release
 * pointers share a revalidation policy but remain distinguishable for audits.
 * Release data is
 * immutable only when its URL contains an explicit release namespace; the
 * current unversioned data/ tree therefore remains mutable metadata.
 */
export function classifyCachePath(input) {
  const pathname = new URL(input, 'https://community-hub.invalid').pathname;
  // Do not mark an encoded dot or path separator immutable: the hosting layer
  // may decode and normalize it before resolving the static file.
  if (AMBIGUOUS_PATH_ENCODING.test(pathname)) return fallbackClass(pathname);
  if (pathname.includes('/_next/static/')) return 'hashed-asset';
  if (/\/(?:privacy|takedown)(?:\/|$)/u.test(pathname)) return 'legal';
  if (RELEASE_ARTIFACT_PATH.test(pathname)) return 'immutable-release-data';
  if (/\/data\/manifest\.json$/u.test(pathname)) return 'release-pointer';
  if (/\/data\//u.test(pathname)) return 'mutable-metadata';
  return 'html';
}

export function cachePolicyForClass(cacheClass) {
  const policy = POLICIES[cacheClass];
  if (!policy) throw new Error(`Unknown cache policy class: ${cacheClass}`);
  return policy;
}

export const cachePolicyClasses = Object.freeze(Object.keys(POLICIES));
