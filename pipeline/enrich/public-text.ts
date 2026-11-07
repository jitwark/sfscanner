const PUBLIC_SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi,
  /Bearer\s+(?:sk|gh[pos]|github_pat|glpat|xox|AKIA)[A-Za-z0-9._~-]{8,}/gi,
  /(?<![A-Za-z0-9])sk-(?:ant-)?[A-Za-z0-9_-]{20,}/gi,
  /(?:gh[pos]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}|glpat-[A-Za-z0-9_-]{20})/gi,
  /xox[baprs]-[A-Za-z0-9-]{10,}/gi,
  /AKIA[0-9A-Z]{16}/g,
  /(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]{8,}/gi,
  /https?:\/\/[^\s:@]+:[^\s:@]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?/gi,
];

/** Remove secret-shaped literals from upstream prose before public projection. */
export function redactPublicText(value: string): string {
  return PUBLIC_SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[redacted]'), value);
}
