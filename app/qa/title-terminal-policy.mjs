// AUDIT-SEO-001: a title truncated at 60 characters on a word boundary, with
// no notion of segments, left whatever character preceded the cut — a
// separator in 22.1% of catalogue entries (2,927 / 13,221). `check-seo.mjs`
// is a grandfathered, ratcheted file (see scripts/file-size-baseline.json)
// with zero line budget left, so this policy — used by both the composer
// and the corpus gate — lives here instead of growing that file.
//
// `app/src/seo/entry-title.ts` composes titles from complete segments so
// this should never fire again, but the gate checks every emitted title
// (entry pages via composeEntryTitle, hub pages via page-meta.ts's own
// truncate-and-strip) rather than trusting the composer.
//
// Terminal-character allowlist, decided deliberately rather than scrubbing
// all trailing punctuation:
//   - Blocked (reads as "something follows" when last): `,` `:` introduce a
//     continuation; `|` and `·` are our own segment joiners; `-` reads as a
//     truncated compound/range; `/` reads as a truncated path/alternative.
//   - Allowed: a closing paren/bracket (a complete qualifier's own
//     terminator), any letter or digit, and sentence-final punctuation
//     (`.` `!` `?` and closing quotes) — these close a segment rather than
//     open one, so a title is allowed to end with them.
export const DANGLING_TITLE_TERMINAL_RE = /[,|·\-:/]$/u;

export function endsInDanglingSeparator(title) {
  return typeof title === 'string' && DANGLING_TITLE_TERMINAL_RE.test(title);
}

// R1-F2: the rule above only inspects the LAST character, so it cannot see a
// title cut *inside* a bracketed clause - `"...multi-input (text, image &"`
// ends in a letter and passes. 85 of 13,221 corpus titles were in that state
// after the first fix. An opened-but-never-closed bracket is the same defect
// wearing different punctuation, so the gate checks balance too.
export function hasUnclosedBracket(title) {
  if (typeof title !== 'string') return false;
  for (const [open, close] of [['(', ')'], ['[', ']']]) {
    let depth = 0;
    for (const char of title) {
      if (char === open) depth += 1;
      else if (char === close) depth = Math.max(0, depth - 1);
    }
    if (depth > 0) return true;
  }
  return false;
}

/** True when a title is visibly truncated: dangling separator or unclosed bracket. */
export function isTruncatedTitle(title) {
  return endsInDanglingSeparator(title) || hasUnclosedBracket(title);
}
