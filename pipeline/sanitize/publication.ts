import type { Entry, GeneratedDescription } from '@hub/contracts';

/**
 * Deterministic publication sanitization for facts that must not be republished
 * verbatim.
 *
 * This is not the acquisition redactor: it runs on the canonical entry just
 * before it is serialized for readers, so the catalogue, search index, detail
 * and preview pages, and every exported product derive from the same sanitized
 * text. It removes only the three exposures measured on the published corpus:
 *
 *   - email addresses in free text a reader sees (description, summary,
 *     structured description) and in the author display name. Only the address
 *     substring is withheld there: the rest of the name, the author URL and the
 *     licence facts are provenance and are never rewritten. An author name that
 *     was only an address becomes the marker itself; the UI must then say the
 *     contact was withheld rather than invent a person.
 *   - private, loopback and internal-only hostnames. A withheld endpoint keeps
 *     its place as `[private endpoint]` so the requirement row still exists and
 *     its count stays true; the literal address is never published. The public
 *     `domains` relation drops these placeholders entirely, so it never invents
 *     a domain name.
 *
 * Nothing here infers that a value is benign because its source repository is
 * public. The transformation is a pure function of the entry text and is
 * idempotent, so re-running a regeneration over already-sanitized entries does
 * not change them again.
 */

/** Bounded the same way as the privacy gate's matcher; see `scripts/lib/corpus-privacy.mjs`. */
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g;

/** The gate already ignores these, so leaving them intact keeps documentation examples readable. */
const PLACEHOLDER_EMAIL = /(example|yourdomain|your-domain|your_email|placeholder|changeme|xxx+|<[^>]{1,64}>|\{\{|test@|foo@|user@domain)/i;
const FILENAME_SUFFIX = /\.(?:pdf|png|jpe?g|gif|svg|csv|xlsx?|docx?|zip|json|txt|md|mp[34]|html?)$/i;

const PRIVATE_IP = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1)\b/i;
const INTERNAL_HOST = /\b[A-Za-z0-9-]{1,63}\.(?:local|internal|intranet|lan|corp)\b/i;

export const PRIVATE_ENDPOINT_LABEL = '[private endpoint]';
const WITHHELD_ENDPOINT = /^\[private endpoint(?: \d+)?\]$/u;

export function isPrivateEndpointHost(value: string): boolean {
  return PRIVATE_IP.test(value) || INTERNAL_HOST.test(value);
}

export function isWithheldEndpointLabel(value: string): boolean {
  return WITHHELD_ENDPOINT.test(value);
}

/**
 * Replace reader-visible email substrings, leaving placeholders and
 * filename-shaped strings alone for the same reason the privacy gate does.
 */
export function redactEmailAddresses(text: string): string {
  return text.replace(EMAIL, (match) =>
    PLACEHOLDER_EMAIL.test(match) || FILENAME_SUFFIX.test(match) ? match : '[email]',
  );
}

/**
 * Withhold private endpoints while keeping one row per original value. The
 * ordinal exists only so two withheld endpoints in the same entry stay distinct
 * requirement rows; it says nothing about the address.
 */
function withholdHosts(hosts: readonly string[], startOrdinal = 1): { values: string[]; nextOrdinal: number } {
  let ordinal = startOrdinal;
  const values = hosts.map((host) => {
    if (!isPrivateEndpointHost(host)) return host;
    const label = ordinal === 1
      ? PRIVATE_ENDPOINT_LABEL
      : `${PRIVATE_ENDPOINT_LABEL.slice(0, -1)} ${ordinal}]`;
    ordinal += 1;
    return label;
  });
  return { values, nextOrdinal: ordinal };
}

function sanitizeDescriptionContent(content: GeneratedDescription): GeneratedDescription {
  return {
    headline: redactEmailAddresses(content.headline),
    summary: redactEmailAddresses(content.summary),
    outcome: redactEmailAddresses(content.outcome),
    beforeAfter: {
      before: redactEmailAddresses(content.beforeAfter.before),
      after: redactEmailAddresses(content.beforeAfter.after),
    },
    exampleScenario: redactEmailAddresses(content.exampleScenario),
    howItWorks: content.howItWorks.map(redactEmailAddresses),
    limitations: content.limitations.map(redactEmailAddresses),
    audience: redactEmailAddresses(content.audience),
  };
}

/**
 * Return an entry whose reader-visible text and endpoint facts are safe to
 * publish. The input is never mutated: callers may still need the acquired
 * entry for private diagnostics that are not serialized.
 */
export function sanitizeEntryForPublication(entry: Entry): Entry {
  const description = redactEmailAddresses(entry.description);
  const summary = redactEmailAddresses(entry.summary);
  const descriptionContent = entry.descriptionContent
    ? sanitizeDescriptionContent(entry.descriptionContent)
    : undefined;
  const authorName = entry.source.author ? redactEmailAddresses(entry.source.author.name) : null;
  const source = authorName !== null && authorName !== entry.source.author!.name
    ? { ...entry.source, author: { ...entry.source.author!, name: authorName } }
    : entry.source;

  let hostnames = entry.hostnames;
  if (hostnames) {
    const literal = withholdHosts(hostnames.literal);
    let ordinal = literal.nextOrdinal;
    const dynamic = hostnames.dynamic.map((item) => {
      const withheld = withholdHosts([item.host], ordinal);
      ordinal = withheld.nextOrdinal;
      return { ...item, host: withheld.values[0]! };
    });
    hostnames = { literal: literal.values, dynamic, undeterminable: hostnames.undeterminable };
  }

  const unchanged = description === entry.description
    && summary === entry.summary
    && source === entry.source
    && (descriptionContent === undefined
      || JSON.stringify(descriptionContent) === JSON.stringify(entry.descriptionContent))
    && (hostnames === undefined
      || JSON.stringify(hostnames) === JSON.stringify(entry.hostnames));
  if (unchanged) return entry;

  return {
    ...entry,
    description,
    summary,
    source,
    ...(descriptionContent === undefined ? {} : { descriptionContent }),
    ...(hostnames === undefined ? {} : { hostnames }),
  };
}

export function sanitizeEntriesForPublication(entries: readonly Entry[]): Entry[] {
  return entries.map(sanitizeEntryForPublication);
}
