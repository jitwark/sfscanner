/**
 * Locale-independent ordering for serialized artifacts.
 *
 * Relational string comparison is deliberate: it follows JavaScript's stable
 * UTF-16 code-unit ordering and does not depend on the host locale or ICU data.
 */
export function compareCanonicalStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
