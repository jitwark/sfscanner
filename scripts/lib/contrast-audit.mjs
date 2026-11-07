import { contrastRatio } from './contrast.mjs';

/**
 * The contrast contract for the palette in `app/app/globals.css`.
 *
 * WCAG floors: 4.5:1 for normal text (1.4.3), 3:1 for graphical objects and
 * meaningful UI boundaries (1.4.11). Both are enforced against **every** surface
 * a token can land on, not just the page background — the failure this gate was
 * written for was a severity colour that passed on `page` and `panel` and fell
 * below the floor on `raised`, which is the surface cards actually use.
 */

export const SURFACES = ['--theme-page', '--theme-panel', '--theme-raised'];

/**
 * Tokens that carry words. Small text, so the 4.5:1 floor, no exceptions.
 *
 * `--theme-accent` is deliberately NOT here. Amber measures 1.57:1 on white:
 * it is a fill, and `--theme-accent-text` is the same hue taken down until it
 * can carry a word. Two tokens rather than one is what stops the wrong choice
 * being the convenient one.
 */
export const TEXT_TOKENS = [
  '--theme-ink',
  '--theme-muted',
  '--theme-faint',
  '--theme-accent-text',
];

/**
 * Tokens that carry meaning as a shape or a boundary rather than as words.
 *
 * The severity ramp is here rather than in TEXT_TOKENS because severity is
 * always direct-labelled — the colour reinforces an order it never has to carry
 * alone. That is a deliberate design rule, and it is the only reason 3:1 is
 * defensible for a security product's severity scale.
 */
export const MARK_TOKENS = [
  '--theme-sev-low',
  '--theme-sev-medium',
  '--theme-sev-high',
  '--theme-sev-critical',
  '--theme-green',
  '--theme-pink',
  '--theme-structure',
  '--theme-accent-border',
  '--theme-hairline-strong',
  // Categorical node families. Unordered — they say "different kind", never
  // "worse" — and every one is paired with a written label in the canvas, which
  // is the only reason 3:1 rather than 4.5:1 is defensible for them.
  '--theme-cat-purple',
  '--theme-cat-blue',
  '--theme-cat-orange',
  '--theme-cat-pink',
];

/**
 * Tokens deliberately below every floor, each with the reason it is allowed to
 * be. A blanket "ignore the rest" would let the next invisible border through.
 */
export const EXEMPT = {
  '--theme-hairline': 'a decorative separator between related rows, not a meaningful boundary; --theme-hairline-strong is the token for a boundary that carries information',
  '--theme-accent-dim': 'a tint used only as a fill behind opaque text, never as a boundary or a mark',
  '--theme-accent': 'a FILL, measured against what sits on it rather than against the page. Amber on white is 1.51:1, so a control filled with it takes its 1.4.11 boundary from --theme-accent-border, which IS checked against every surface.',
  '--theme-accent-ink': 'reads against the accent fill, not against a surface; checked separately',
  '--theme-sev-unknown': 'aliases --theme-faint, which is checked as text',
  '--theme-band': 'a surface, not a foreground; what reads against it is checked as an explicit pair',
  '--theme-band-raised': 'a surface, as above',
  '--theme-on-band': 'reads against the bands, not against a page surface; checked as an explicit pair',
  '--theme-on-band-muted': 'reads against the bands, as above',
};

/** Pairs that are not token-on-surface and so need naming individually. */
export const EXPLICIT_PAIRS = [
  { foreground: '--theme-accent-ink', background: '--theme-accent', floor: 4.5, what: 'text on the accent fill' },
  // The bands are a surface of their own — hero, CTA, footer, code samples —
  // and they do not change between modes. Whatever reads on them has to be
  // checked against them, not against the page.
  { foreground: '--theme-on-band', background: '--theme-band', floor: 4.5, what: 'text on a band' },
  { foreground: '--theme-on-band', background: '--theme-band-raised', floor: 4.5, what: 'text on a raised band' },
  { foreground: '--theme-on-band-muted', background: '--theme-band', floor: 4.5, what: 'secondary text on a band' },
  { foreground: '--theme-on-band-muted', background: '--theme-band-raised', floor: 4.5, what: 'secondary text on a raised band' },
  { foreground: '--theme-accent', background: '--theme-band', floor: 3, what: 'the accent as a mark on a band' },
];

function record(violations, { mode, foreground, background, ratio, floor, what }) {
  if (ratio === null) {
    violations.push(`${mode}: ${foreground} on ${background} — could not parse a colour`);
    return;
  }
  if (ratio + 1e-9 >= floor) return;
  violations.push(
    `${mode}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1, below the ${floor}:1 floor for ${what}`,
  );
}

/**
 * @param {Record<string, Record<string, string>>} modes from `parseThemeBlocks`
 * @returns {{ violations: string[], checked: number }}
 */
export function auditPalette(modes) {
  const violations = [];
  let checked = 0;

  for (const [mode, tokens] of Object.entries(modes)) {
    for (const [group, floor, what] of [
      [TEXT_TOKENS, 4.5, 'text'],
      [MARK_TOKENS, 3, 'a mark or a meaningful boundary'],
    ]) {
      for (const foreground of group) {
        if (tokens[foreground] === undefined) {
          violations.push(`${mode}: ${foreground} is not declared`);
          continue;
        }
        for (const background of SURFACES) {
          checked += 1;
          record(violations, {
            mode, foreground, background, floor, what,
            ratio: contrastRatio(tokens[foreground], tokens[background]),
          });
        }
      }
    }

    for (const pair of EXPLICIT_PAIRS) {
      checked += 1;
      record(violations, {
        mode, ...pair,
        ratio: contrastRatio(tokens[pair.foreground], tokens[pair.background]),
      });
    }
  }

  return { violations, checked };
}

/**
 * The standing palette rule: the structural colour is never a text colour.
 *
 * Copper today, amber in the planned palette — either way it is the one hue in
 * this system that looks like it should be usable for emphasis and measures
 * around 1.6:1 on white. The `@theme` block is where a token gets pointed at a
 * role, so that is where the rule belongs.
 */
export const TEXT_ROLE_TOKENS = ['--color-accent-text', '--color-ink', '--color-ink-muted'];

/** Roles that must never resolve to a fill-only hue. */
const FILL_ONLY = ['--theme-accent', '--theme-structure'];

export function auditTextRoles(themeBlock) {
  const violations = [];
  for (const role of TEXT_ROLE_TOKENS) {
    const value = themeBlock[role];
    if (value === undefined) {
      violations.push(`${role} is not declared in the @theme block`);
      continue;
    }
    for (const fill of FILL_ONLY) {
      // `--color-accent-text: var(--theme-accent)` is the mistake this exists
      // to stop: it is correct in dark mode, where amber clears the text floor,
      // and 1.57:1 in light mode, where it does not.
      if (value.includes(`var(${fill})`)) {
        violations.push(
          `${role} points at ${fill}, which is a fill and measures 1.57:1 on white. ` +
          'Point it at --theme-accent-text, or add a token that measures as text.',
        );
      }
    }
  }
  return violations;
}
