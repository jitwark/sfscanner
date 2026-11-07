/**
 * Neutralizing externally-sourced strings and URLs before they reach a page.
 *
 * Everything here defends a sink that already exists. Titles, author names, and
 * repository permalinks all come from workflow JSON in repositories we crawl,
 * so anyone who can name a file in one of those repositories controls this
 * input. `serializeJsonLd` handles the script-breakout case; these two handle
 * what escaping does not.
 *
 * They are not general-purpose sanitizers. `stripInvisible` deliberately
 * preserves ordinary Unicode — a Japanese or Arabic workflow title must survive
 * intact — and removes only characters that have no visible glyph and can
 * change how the surrounding text reads.
 */

/**
 * Bidirectional overrides and invisible characters.
 *
 * A right-to-left override in a title reverses the text a reader sees while
 * leaving the stored string unchanged, so `report‮gnp.exe` renders as
 * `reportexe.png` in a browser tab, a search result, and a social card. Nothing
 * is escaped and nothing executes, which is why HTML escaping does not catch
 * it. Zero-width characters are included because they defeat the
 * duplicate-title and near-duplicate checks the catalogue relies on.
 */
const INVISIBLE = new RegExp(
  [
    '[\\u200B-\\u200F]', // zero-width space/joiners, LRM/RLM
    '[\\u202A-\\u202E]', // embedding and override
    '[\\u2066-\\u2069]', // isolates
    '[\\u2028\\u2029]', // line and paragraph separators
    '[\\u00AD\\uFEFF]', // soft hyphen, BOM
    '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', // C0 controls, DEL
  ].join('|'),
  'gu',
);

/**
 * Removes characters that change how text reads without being visible.
 *
 * Homoglyphs are deliberately **not** handled. `аpple` with a Cyrillic а is a
 * legitimate string in a multilingual catalogue, and rewriting it would corrupt
 * real titles. The defence against homoglyph confusion is that we never present
 * a title as an identity claim: the source repository, owner, and commit are
 * rendered from pipeline fields beside it.
 */
export function stripInvisible(value: string): string {
  return value.replace(INVISIBLE, '');
}

/** Collapses runs of whitespace so a title padded with newlines cannot stretch a card. */
export function normalizeDisplayText(value: string, maxLength = 300): string {
  const cleaned = stripInvisible(value).replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/**
 * Returns `candidate` only when it is a well-formed `http`/`https` URL.
 *
 * A link-only entry's canonical URL is its upstream `permalink`, which is
 * externally sourced. Without this, a permalink of `javascript:alert(1)` was
 * emitted verbatim into `<link rel="canonical">` and `og:url`. Scheme checking
 * is done on the parsed URL rather than by matching the string, so
 * `JavaScript:`, leading whitespace, and embedded control characters cannot
 * slip a scheme past it.
 */
export function safeHttpUrl(candidate: string | undefined | null, fallback: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0) return fallback;
  try {
    const parsed = new URL(stripInvisible(candidate).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : fallback;
  } catch {
    return fallback;
  }
}
