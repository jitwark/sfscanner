import { sitePath } from '../ui/site-url.mjs';

/**
 * When the semantic vectors are fetched, and who hears about it.
 *
 * `semantic-index.json` is 1.55 MB gzip — larger than the lexical index itself
 * — and nothing consults it until someone types. It used to be fetched during
 * warm-up, on `requestIdleCallback`, on every page that imports the search
 * client, which is most of the 9.89 MB a visitor paid before their first
 * keystroke.
 *
 * This module decides *whether and when* to fetch. It deliberately knows
 * nothing about where the vectors go: the caller supplies `deliver`, because
 * that is a worker `postMessage` on the normal path and a direct call on the
 * fallback path, and this file should not have to care which.
 */
const listeners = new Set<() => void>();
let requested = false;

/**
 * Fires when the vectors land and the ranking they feed becomes available.
 * Semantic carries 0.38 of the relevance blend, so results computed before this
 * are lexical-only and genuinely weaker; a subscriber should re-run whatever
 * query it is showing rather than leave the reader with the earlier ordering.
 */
export function onRankingImproved(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function reportRankingImproved(): void {
  for (const callback of listeners) callback();
}

export function resetSemanticVectorState(): void {
  requested = false;
  listeners.clear();
}

/** A query can only use vectors if it has tokens and none of them is a quoted
 * phrase — the worker skips the semantic path entirely for quoted phrases, so
 * one must never trigger the download. */
export function couldUseSemanticVectors(query: string): boolean {
  if (!query.trim()) return false;
  const tokens = query.match(/"[^"]*"|\S+/g) || [];
  return tokens.length > 0 && !tokens.some((token) => token.startsWith('"') && token.endsWith('"'));
}

export function requestSemanticVectors(
  query: string,
  deliver: (semanticIndexJson: string) => void,
  isCurrent: () => boolean,
): void {
  if (requested || !couldUseSemanticVectors(query)) return;
  requested = true;
  void (async () => {
    try {
      if (typeof fetch !== 'function') return;
      const response = await fetch(sitePath('/data/semantic-index.json'));
      if (!response.ok || !isCurrent()) return;
      const json = await response.text();
      if (isCurrent()) deliver(json);
    } catch {
      // A failed vector fetch degrades ranking; it never breaks search. Allow a
      // later query to try again.
      requested = false;
    }
  })();
}
