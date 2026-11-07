/**
 * The release origin, read at call time.
 *
 * Deliberately a function and never a module-level constant: tests and the
 * build each set `NEXT_PUBLIC_SITE_URL` before calling, and a captured value
 * would silently outlive its environment. There is no default origin — the
 * deploy that motivated this helper published a hardcoded host that nobody
 * owned, so a missing value omits the surface instead of inventing one.
 */
export function siteOrigin(): string | null {
  const raw = (process.env.NEXT_PUBLIC_SITE_URL ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      ? url.href.replace(/\/$/, '')
      : null;
  } catch {
    return null;
  }
}

export const siteUrl = siteOrigin;

export function absoluteSiteUrl(path: string): string | null {
  const base = siteUrl();
  return base === null ? null : `${base}/${path.replace(/^\/+/, '')}`;
}
