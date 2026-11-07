/**
 * How a sanitized author name is shown to a reader.
 *
 * Acquisition provenance keeps the original name privately; the published entry
 * carries the address substring replaced with `[email]`. An author whose name was
 * only an address becomes the marker itself, and the UI must say the contact was
 * withheld rather than present `[email]` as if it were a person's name.
 */
export const REDACTED_CONTACT_MARKER = '[email]';

export function isRedactedAuthorName(name: string): boolean {
  return name.includes(REDACTED_CONTACT_MARKER);
}

export function authorDisplayName(name: string | undefined): string {
  if (!name) return 'Unknown';
  if (!isRedactedAuthorName(name)) return name;
  const remainder = name.replaceAll(REDACTED_CONTACT_MARKER, '');
  return /[\p{L}\p{N}]/u.test(remainder) ? name : 'Author contact withheld';
}

/** The author name a structured-data payload may publish; undefined when redacted. */
export function publishableAuthorName(name: string | undefined): string | undefined {
  return name && !isRedactedAuthorName(name) ? name : undefined;
}
