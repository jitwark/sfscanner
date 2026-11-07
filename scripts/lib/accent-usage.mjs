/**
 * A fill token may not be used as a foreground in component source.
 *
 * `check:contrast` measures the palette. It cannot see a component writing
 * `className="text-accent"`, and that is exactly what broke: under the violet
 * palette `--color-accent` was 5.32:1 on white and perfectly good as text, so
 * 103 places used it that way. Swapping the accent to amber made every one of
 * them 1.51:1 in light mode, and no gate noticed — the palette was still
 * correct, and the components were still valid Tailwind.
 *
 * So this checks the other half: the *role* a token is used in, not its value.
 */

/** Tailwind utilities that put a colour on a foreground or a boundary. */
const FOREGROUND_PREFIXES = ['text', 'outline', 'ring', 'decoration', 'border', 'fill', 'stroke'];

/**
 * Tokens that are fills only. Each maps to the token that should be used
 * instead, so the failure message says what to do rather than only what is
 * wrong.
 */
export const FILL_ONLY_TOKENS = Object.freeze({
  accent: 'accent-text for words and icons, accent-border for a boundary or a focus ring',
  'accent-dim': 'accent-text — accent-dim is a tint behind opaque text, never a foreground',
  band: 'on-band, which is measured against the band',
  'band-raised': 'on-band or on-band-muted',
});

/**
 * @param {string} source one component's source text
 * @returns {Array<{ utility: string, token: string, advice: string, line: number }>}
 */
export function findFillOnlyForegroundUses(source) {
  const found = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const [token, advice] of Object.entries(FILL_ONLY_TOKENS)) {
      for (const prefix of FOREGROUND_PREFIXES) {
        // `text-accent-text` and `text-accent-ink` must not match `text-accent`,
        // so the token may only be followed by a non-name character: a quote,
        // a space, a slash for an opacity modifier, or end of line.
        const pattern = new RegExp(`\\b${prefix}-${token}(?![\\w-])`, 'g');
        for (const match of lines[index].matchAll(pattern)) {
          found.push({ utility: match[0], token, advice, line: index + 1 });
        }
      }
    }
  }
  return found;
}
