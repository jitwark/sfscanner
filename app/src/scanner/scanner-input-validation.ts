import { DEFAULT_SCANNER_LIMITS } from '@hub/contracts';

/** Sourced from the shared scanner-limits contract so this cannot drift from the worker's own enforcement. */
export const MAX_WORKFLOW_BYTES = DEFAULT_SCANNER_LIMITS.maxBytes;

/** Human-readable label for `MAX_WORKFLOW_BYTES`, so UI copy is derived rather than a second hardcoded number. */
export function formatMaxBytesLabel(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export const MAX_WORKFLOW_BYTES_LABEL = formatMaxBytesLabel(MAX_WORKFLOW_BYTES);

/**
 * Is this text over the scanner's byte budget?
 *
 * The length check is allocation-free and sufficient to reject: UTF-8 never
 * encodes a code unit as less than one byte, so more code units than the limit
 * is always over. Only a text that could still be under the limit is encoded.
 * Callers use this before structured-cloning the string to the worker, where a
 * 1.5 MB copy would already have happened.
 */
export function exceedsWorkflowByteLimit(text: string): boolean {
  if (text.length > MAX_WORKFLOW_BYTES) return true;
  return new TextEncoder().encode(text).byteLength > MAX_WORKFLOW_BYTES;
}

export type ApprovedDomainParseResult = {
  domains: string[];
  rejected: string[];
};

/** Canonicalize URL/host input to exact hostnames used by the scanner policy. */
export function parseApprovedDomains(text: string): ApprovedDomainParseResult {
  const domains: string[] = [];
  const rejected: string[] = [];

  for (const token of text.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean)) {
    const canonical = canonicalHostname(token);
    if (!canonical) {
      rejected.push(token);
    } else if (!domains.includes(canonical)) {
      domains.push(canonical);
    }
  }

  return { domains, rejected };
}

function canonicalHostname(token: string): string | null {
  if (token.includes('*') || /^[/?#]/.test(token)) return null;
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(token);

  try {
    const url = new URL(hasScheme ? token : `https://${token}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    return hostname || null;
  } catch {
    return null;
  }
}
