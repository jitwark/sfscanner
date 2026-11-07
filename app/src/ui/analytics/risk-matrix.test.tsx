import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MAX_CELL_ALPHA } from './risk-matrix';
import { composite, contrastRatio, parseColor, parseThemeBlocks } from '../../../../scripts/lib/contrast.mjs';

/**
 * The risk matrix encodes a count as one hue stepped by alpha, and prints the
 * count on top of it. The darkest cell is therefore the binding case for
 * legibility, and its contrast depends on three things that move independently:
 * the accent hue, the panel behind it, and this alpha ceiling.
 *
 * All three moved on 2026-09-05 — violet to amber, and a new panel — and the
 * old 0.5 ceiling silently fell to 4.15:1 in dark mode, below the 4.5:1 floor
 * for text. The comment in `risk-matrix.tsx` said 4.79:1 and was describing a
 * palette that no longer existed.
 *
 * So this re-derives the number from the shipped palette rather than trusting
 * the comment. It is the only assertion that fails when someone changes the
 * accent and does not think about this file.
 */
const root = resolve(import.meta.dirname, '..', '..', '..', '..');
const modes = parseThemeBlocks(readFileSync(join(root, 'app', 'app', 'globals.css'), 'utf8'));

/** The cell fill at a given alpha: accent composited over the panel. */
function cellFill(mode: Record<string, string>, alpha: number): string {
  const accent = parseColor(mode['--theme-accent']!)!;
  const blended = composite({ ...accent, a: alpha }, parseColor(mode['--theme-panel']!)!);
  return `rgb(${Math.round(blended.r)}, ${Math.round(blended.g)}, ${Math.round(blended.b)})`;
}

describe('risk matrix cell legibility', () => {
  it.each(['light', 'dark'])('keeps the darkest %s cell above the 4.5:1 text floor', (name) => {
    const mode = modes[name]!;
    const ratio = contrastRatio(mode['--theme-ink']!, cellFill(mode, MAX_CELL_ALPHA));

    expect(ratio, `${name} at alpha ${MAX_CELL_ALPHA}`).toBeGreaterThanOrEqual(4.5);
  });

  it('is at a real ceiling, not an arbitrary one', () => {
    // If a higher alpha would also pass, the ceiling is leaving contrast on the
    // table and the derivation above has drifted from the palette. If this
    // fails, recompute and raise it deliberately.
    const worst = (alpha: number) => Math.min(
      ...['light', 'dark'].map((name) => contrastRatio(modes[name]!['--theme-ink']!, cellFill(modes[name]!, alpha))!),
    );

    expect(worst(MAX_CELL_ALPHA)).toBeGreaterThanOrEqual(4.5);
    expect(worst(MAX_CELL_ALPHA + 0.1)).toBeLessThan(4.5);
  });
});
