/**
 * Configured external product links, or nothing.
 *
 * Both repositories were private when the site shipped a hardcoded link and a
 * "GitHub (private)" label — a dead target the page itself admitted. A link is
 * now a configuration decision: absent configuration renders no anchor at all
 * rather than a link that cannot be followed.
 *
 * This validator is external-link-specific: path, query, and fragment are all
 * allowed. `siteOrigin()` deliberately rejects query and fragment because it is
 * a canonical origin, so it is the wrong tool here.
 */
function httpsLink(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export const productRepositoryUrl = () => httpsLink(process.env.NEXT_PUBLIC_PRODUCT_REPOSITORY_URL);
export const scannerRuleReferenceUrl = () => httpsLink(process.env.NEXT_PUBLIC_RULE_REFERENCE_URL);
