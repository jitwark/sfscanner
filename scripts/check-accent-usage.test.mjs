import { describe, expect, test } from 'vitest';
import { findFillOnlyForegroundUses } from './lib/accent-usage.mjs';

/**
 * The palette gate measures values. This one measures roles — the half that was
 * missing when the accent moved from violet to amber and 103 components that
 * had legitimately used `text-accent` all became 1.51:1 in light mode without a
 * single gate going red.
 */
describe('findFillOnlyForegroundUses', () => {
  test('flags the accent fill used as text', () => {
    const found = findFillOnlyForegroundUses('<span className="text-accent">Open</span>');

    expect(found).toHaveLength(1);
    expect(found[0].utility).toBe('text-accent');
    expect(found[0].advice).toContain('accent-text');
    expect(found[0].line).toBe(1);
  });

  test.each(['outline-accent', 'ring-accent', 'border-accent', 'decoration-accent', 'fill-accent', 'stroke-accent'])(
    'flags %s, because a boundary and a focus ring need 3:1 too',
    (utility) => {
      expect(findFillOnlyForegroundUses(`className="${utility}"`)).toHaveLength(1);
    },
  );

  test('does not flag the tokens that exist precisely to be used this way', () => {
    const source = [
      '<a className="text-accent-text underline">Open the library</a>',
      '<button className="bg-accent text-accent-ink border-accent-border">Scan</button>',
      '<div className="focus-visible:ring-accent-border" />',
      '<p className="text-on-band-muted">On a band</p>',
    ].join('\n');

    expect(findFillOnlyForegroundUses(source)).toEqual([]);
  });

  test('flags an opacity modifier, which changes nothing about the hue', () => {
    // `border-accent/40` is amber at 40% — further from the floor, not closer.
    expect(findFillOnlyForegroundUses('className="border-accent/40"')).toHaveLength(1);
  });

  test('does not flag a background, which is what the fill is for', () => {
    expect(findFillOnlyForegroundUses('className="bg-accent bg-accent-dim"')).toEqual([]);
  });

  test('reports the line, so a failure points at the place to fix', () => {
    const found = findFillOnlyForegroundUses(['const a = 1;', '', '<i className="text-accent" />'].join('\n'));
    expect(found[0].line).toBe(3);
  });
});
