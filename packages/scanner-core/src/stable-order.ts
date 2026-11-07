/** Locale-independent UTF-16 ordering for deterministic scanner output. */
export function compareCanonicalStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
