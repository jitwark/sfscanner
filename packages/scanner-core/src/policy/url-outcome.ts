import { literalIslands } from './literal-islands';
import { foldLiteralOutcome } from './literal-url-fold';

export type UrlUnknownReason = 'DYNAMIC' | 'UNSUPPORTED' | 'OVERSIZED';
export type UrlCollectionOutcome =
  | Readonly<{ state: 'FOUND'; urls: readonly URL[] }>
  | Readonly<{ state: 'NONE'; urls: readonly URL[] }>
  | Readonly<{ state: 'UNKNOWN'; reason: UrlUnknownReason; urls: readonly URL[]; omitted: number }>;

/** Tri-state destination discovery. UNKNOWN is never collapsed into an empty clean list. */
export function collectUrlOutcome(value: unknown): UrlCollectionOutcome {
  if (Array.isArray(value)) return combineOutcomes(value.map(collectUrlOutcome));
  if (isRecord(value)) return combineOutcomes(Object.values(value).map(collectUrlOutcome));
  if (typeof value !== 'string') return { state: 'NONE', urls: [] };
  if (value.startsWith('=')) {
    const folded = foldLiteralOutcome(value);
    if (folded.state === 'FOUND') {
      const urls = parseHttpUrl(folded.value);
      return urls.length > 0 ? { state: 'FOUND', urls } : { state: 'NONE', urls: [] };
    }
    const islands = literalIslands(value);
    const urls = islands.literals.flatMap(parseHttpUrl);
    // A dynamic island inside the authority can extend the host. A dynamic path after the
    // authority cannot: the literal hostname remains a sound allowlist target.
    if (urls.length > 0 && (!islands.templated || dynamicIslandAfterAuthority(value))) {
      return { state: 'FOUND', urls };
    }
    return { state: 'UNKNOWN', reason: folded.reason, urls: [], omitted: 1 };
  }
  const islands = literalIslands(value);
  const urls = islands.literals.flatMap(parseHttpUrl);
  if (urls.length > 0) return { state: 'FOUND', urls };
  if (islands.templated) return { state: 'UNKNOWN', reason: 'DYNAMIC', urls: [], omitted: 1 };
  return { state: 'NONE', urls: [] };
}

export function collectUrls(value: unknown): URL[] {
  return [...collectUrlOutcome(value).urls];
}

function dynamicIslandAfterAuthority(value: string): boolean {
  const body = value.startsWith('=') ? value.slice(1) : value;
  const scheme = body.indexOf('://');
  if (scheme < 0) return false;
  const start = scheme + 3;
  const authorityEnd = [body.indexOf('/', start), body.indexOf('?', start), body.indexOf('#', start)]
    .filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? body.length;
  const island = body.indexOf('{{');
  return island >= 0 && island > authorityEnd;
}

function combineOutcomes(outcomes: readonly UrlCollectionOutcome[]): UrlCollectionOutcome {
  const unknown = outcomes.filter((outcome): outcome is Extract<UrlCollectionOutcome, { state: 'UNKNOWN' }> => outcome.state === 'UNKNOWN');
  const urls = outcomes.flatMap((outcome) => outcome.urls);
  if (unknown.length > 0) {
    const order: readonly UrlUnknownReason[] = ['DYNAMIC', 'UNSUPPORTED', 'OVERSIZED'];
    const reason = order.find((candidate) => unknown.some((outcome) => outcome.reason === candidate)) ?? 'UNSUPPORTED';
    return { state: 'UNKNOWN', reason, urls, omitted: unknown.reduce((total, outcome) => total + outcome.omitted, 0) };
  }
  return urls.length > 0 ? { state: 'FOUND', urls } : { state: 'NONE', urls: [] };
}

function parseHttpUrl(value: string): URL[] {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
    // Userinfo is redacted, and query/fragment values are stripped before the URL can reach
    // findings. Host/scheme/port remain normalized by the URL parser.
    if (url.username !== '' || url.password !== '') { url.username = ''; url.password = ''; }
    url.search = '';
    url.hash = '';
    return [url];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
