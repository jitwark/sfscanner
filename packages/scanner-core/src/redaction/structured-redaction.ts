export const REDACTED = '[REDACTED]';

const urlPattern = /\b(?:https?|postgres(?:ql)?|mysql|mariadb|redis|rediss|mongodb(?:\+srv)?|amqp|amqps|smtp|smtps|ftp|ftps|sftp|ssh):\/\/[^\s"'<>]+/gi;
const sensitiveQueryKey = /^(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|token|secret|password|credential|authorization|client[-_ ]?secret)$/i;
const queryAssignment = /([?&])((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|token|secret|password|credential|authorization|client[-_ ]?secret))=([^&#\s]*)/gi;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern = /(?<![\w+])(?:\+?\d[\d .()-]{7,}\d)(?!\w)/g;

export function redactStructuredUrlText(value: string): string {
  return redactQueryAssignments(value.replace(urlPattern, redactUrl));
}

export function redactContextualPii(value: string): string {
  return value.replace(emailPattern, REDACTED).replace(phonePattern, REDACTED);
}

export function isPiiContainerKey(key: string): boolean {
  return key.toLowerCase() === 'pindata' || key.toLowerCase() === 'pinneddata';
}

export function isStickyNoteRecord(value: Record<string, unknown>): boolean {
  return value.type === 'n8n-nodes-base.stickyNote';
}

function redactUrl(match: string): string {
  try {
    const url = new URL(match);
    if (url.username || url.password) {
      url.username = REDACTED;
      url.password = '';
    }
    for (const [key] of url.searchParams) {
      if (sensitiveQueryKey.test(key)) url.searchParams.set(key, REDACTED);
    }
    if (url.hash) url.hash = REDACTED;
    return url.toString();
  } catch {
    // WHATWG rejects malformed hosts such as postgres://user:pass@[bad. Re-running only the
    // query rule would leave both the password and the fragment in place, so redact the
    // authority structurally and then redact the fragment exactly as the parsed path does.
    return redactQueryAssignments(redactMalformedUrl(match));
  }
}

/**
 * The authority starts after `://` and ends at the first `/`, `?`, or `#`. The last `@` before
 * that boundary separates userinfo from the host; an `@` in the path or query is therefore not
 * userinfo. This is a linear scan with no regex and no parser call, so a malformed URI cannot
 * throw.
 */
function redactMalformedUrl(value: string): string {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd < 0) return value;
  const authorityStart = schemeEnd + 3;
  const authorityEnd = firstIndexOf(value, authorityStart, '/?#');
  const at = value.lastIndexOf('@', authorityEnd < 0 ? value.length - 1 : authorityEnd);
  const withoutUserinfo = at < authorityStart
    ? value
    : `${value.slice(0, authorityStart)}${REDACTED}${value.slice(at)}`;
  const hash = withoutUserinfo.indexOf('#');
  return hash < 0 ? withoutUserinfo : `${withoutUserinfo.slice(0, hash)}#${REDACTED}`;
}

function firstIndexOf(value: string, from: number, needles: string): number {
  for (let index = from; index < value.length; index += 1) {
    if (needles.includes(value[index]!)) return index;
  }
  return -1;
}

function redactQueryAssignments(value: string): string {
  return value.replace(queryAssignment, (_, prefix: string, key: string) => `${prefix}${key}=${REDACTED}`);
}
