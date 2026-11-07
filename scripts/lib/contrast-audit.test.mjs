import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { contrastRatio, parseColor, parseThemeBlocks, relativeLuminance } from './contrast.mjs';
import { auditPalette, auditTextRoles, MARK_TOKENS, TEXT_TOKENS } from './contrast-audit.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const css = readFileSync(join(root, 'app', 'app', 'globals.css'), 'utf8');
const appSourceRoot = join(root, 'app', 'src');

function appSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return appSourceFiles(path);
    return /\.(?:ts|tsx|css)$/u.test(entry.name) ? [path] : [];
  });
}

function tintOverSurface(foreground, background, opacity = 0.1) {
  const color = parseColor(foreground);
  const surface = parseColor(background);
  if (!color || !surface) return null;
  const channels = ['r', 'g', 'b'].map((channel) =>
    Math.round(color[channel] * opacity + surface[channel] * (1 - opacity)));
  return `rgb(${channels.join(', ')})`;
}

describe('contrast arithmetic', () => {
  test('black on white is 21:1 and a colour against itself is 1:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#7355bf', '#7355bf')).toBeCloseTo(1, 5);
  });

  test('matches published WCAG values', () => {
    // #767676 on white is the canonical "exactly 4.5:1" grey.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
    expect(relativeLuminance(parseColor('#ffffff'))).toBeCloseTo(1, 5);
    expect(relativeLuminance(parseColor('#000000'))).toBeCloseTo(0, 5);
  });

  test('composites a translucent foreground before measuring', () => {
    // A hairline at 16% alpha is nowhere near the ratio its raw hex suggests.
    // Reading it raw is how a border becomes invisible while looking fine in a
    // spreadsheet of hex values.
    const raw = contrastRatio('#c4b5fd', '#100f1b');
    const actual = contrastRatio('rgba(196, 181, 253, 0.16)', '#100f1b');
    expect(raw).toBeGreaterThan(9);
    expect(actual).toBeLessThan(2);
  });

  test('parses three-digit hex and both rgb spellings', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor('rgba(1, 2, 3, 0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseColor('not-a-colour')).toBeNull();
  });
});

describe('theme parsing', () => {
  test('finds both modes and reads their declarations', () => {
    const modes = parseThemeBlocks(css);
    expect(Object.keys(modes).sort()).toEqual(['dark', 'light']);
    for (const mode of ['dark', 'light']) {
      expect(modes[mode]['--theme-page']).toMatch(/^#/);
      expect(modes[mode]['--theme-sev-critical']).toMatch(/^#/);
    }
  });

  test('reads a mode block whichever theme the bare :root is paired with', () => {
    // The default flipped from dark to light in the 2026-09-05 palette. The
    // parser must not care, because the next change might flip it back.
    const multiline = [":root,", "[data-theme='light'] { --theme-page: #eee; }"].join(String.fromCharCode(10));
    expect(parseThemeBlocks(multiline).light['--theme-page']).toBe('#eee');
  });

  test('light is the shipped default, which is what a reader sees before the theme script runs', () => {
    expect(css).toMatch(/:root,\s*\[data-theme='light'\]/u);
    expect(parseThemeBlocks(css).light['--theme-page']).toBe('#ffffff');
  });
});

describe('the shipped palette', () => {
  test('every text and mark token clears its floor on every surface', () => {
    const { violations, checked } = auditPalette(parseThemeBlocks(css));
    expect(checked).toBeGreaterThan(50);
    expect(violations).toEqual([]);
  });

  test('severity and category labels meet normal-text contrast on every theme surface', () => {
    const modes = parseThemeBlocks(css);
    const labelTokens = [
      '--theme-sev-low', '--theme-sev-medium', '--theme-sev-high',
      '--theme-sev-critical', '--theme-sev-unknown',
      '--theme-cat-purple', '--theme-cat-blue', '--theme-cat-green',
      '--theme-cat-orange', '--theme-cat-pink',
    ];
    const surfaces = ['--theme-page', '--theme-panel', '--theme-raised'];

    for (const [mode, tokens] of Object.entries(modes)) {
      for (const foreground of labelTokens) {
        expect(tokens[foreground], `${mode}: ${foreground} is declared`).toBeDefined();
        for (const background of surfaces) {
          expect(
            contrastRatio(tokens[foreground], tokens[background]),
            `${mode}: ${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
          expect(
            contrastRatio(tokens[foreground], tintOverSurface(tokens[foreground], tokens[background])),
            `${mode}: ${foreground} on its 10% tint over ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  test('retired risk styling tokens are neither declared nor used', () => {
    const themeBlock = css.match(/@theme\s*\{([\s\S]*?)\n\}/u)?.[1] ?? '';
    const source = appSourceFiles(appSourceRoot)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    const retiredStyleReference = /(?:--color-)?risk-(?:low|medium|high|critical(?:-text)?)/gu;
    const translucentSeverityBoundary = /\bborder-sev-(?:low|medium|high|critical)\/(?!100\b)\d+\b/gu;
    const canonicalTokens = [
      '--color-sev-low', '--color-sev-medium', '--color-sev-high',
      '--color-sev-critical', '--color-sev-unknown',
      '--color-cat-purple', '--color-cat-blue', '--color-cat-green',
      '--color-cat-orange', '--color-cat-pink',
    ];

    for (const token of canonicalTokens) expect(themeBlock).toContain(`${token}: var(`);
    expect(themeBlock).not.toMatch(/--color-risk-(?:low|medium|high|critical(?:-text)?)/u);
    expect(source.match(retiredStyleReference)).toBeNull();
    expect(source.match(translucentSeverityBoundary)).toBeNull();
  });

  test('no text role resolves to a fill-only hue', () => {
    const themeBlock = {};
    const block = css.match(/@theme\s*\{([\s\S]*?)\n\}/);
    for (const line of block[1].split(';')) {
      const declaration = line.match(/\s*(--[\w-]+)\s*:\s*(.+)\s*$/);
      if (declaration) themeBlock[declaration[1]] = declaration[2].trim();
    }
    expect(auditTextRoles(themeBlock)).toEqual([]);
  });
});

describe('the audit itself', () => {
  test('reports the surface a token fails on, not just the token', () => {
    // The defect this gate exists for: a colour that passes against `page` and
    // `panel` and falls below the floor on `raised`, which is the surface cards
    // use. Every other token here is white on black so only the one under test
    // can fail.
    const white = '#ffffff';
    const passing = Object.fromEntries([
      ...TEXT_TOKENS, ...MARK_TOKENS, '--theme-accent', '--theme-band', '--theme-band-raised',
    ].map((token) => [token, white]));
    const { violations } = auditPalette({
      dark: {
        ...passing,
        '--theme-page': '#000000', '--theme-panel': '#000000', '--theme-raised': '#767676',
        '--theme-accent-ink': '#000000',
        '--theme-on-band': white, '--theme-on-band-muted': white,
        '--theme-band': '#000000', '--theme-band-raised': '#000000',
        '--theme-sev-critical': '#7a7a7a',
      },
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('--theme-sev-critical');
    expect(violations[0]).toContain('--theme-raised');
    expect(violations[0]).toContain('3:1 floor');
  });

  test('an undeclared token is a violation, not a silent pass', () => {
    const { violations } = auditPalette({ light: { '--theme-page': '#fff' } });
    expect(violations.some((line) => line.includes('--theme-ink is not declared'))).toBe(true);
  });

  test('rejects a fill hue pointed at a text role', () => {
    // The mistake this catches is correct in dark mode and 1.57:1 in light:
    // pointing `--color-accent-text` at the amber fill instead of the darkened
    // text hue.
    expect(auditTextRoles({
      '--color-accent-text': 'var(--theme-accent)',
      '--color-ink': 'var(--theme-ink)',
      '--color-ink-muted': 'var(--theme-muted)',
    })).toHaveLength(1);
  });
});
