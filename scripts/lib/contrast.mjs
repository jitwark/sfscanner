/**
 * WCAG contrast arithmetic and the palette pairs this product must satisfy.
 *
 * Colour is load-bearing here in a way it is not on most sites: a severity ramp
 * tells a reader how dangerous a finding is. A ramp step that disappears
 * against its panel is not a cosmetic problem, it is a security-reporting one.
 * The design audit measured two failures by hand; a hand measurement holds
 * until the next person edits a hex value.
 *
 * Everything is derived from `app/app/globals.css`, which is the only place
 * palette values are declared, so the gate cannot drift from what ships.
 */

/** @param {string} value a `#rgb`, `#rrggbb`, or `rgba(r, g, b, a)` string */
export function parseColor(value) {
  const text = String(value).trim();

  const rgba = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/i);
  if (rgba) {
    return {
      r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }

  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return null;
  const digits = hex[1].length === 3 ? hex[1].split('').map((d) => d + d).join('') : hex[1];
  return {
    r: parseInt(digits.slice(0, 2), 16),
    g: parseInt(digits.slice(2, 4), 16),
    b: parseInt(digits.slice(4, 6), 16),
    a: 1,
  };
}

/** Composite a possibly-translucent colour over an opaque one. */
export function composite(foreground, background) {
  if (foreground.a >= 1) return foreground;
  const blend = (f, b) => f * foreground.a + b * (1 - foreground.a);
  return {
    r: blend(foreground.r, background.r),
    g: blend(foreground.g, background.g),
    b: blend(foreground.b, background.b),
    a: 1,
  };
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const srgb = value / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Contrast ratio between two colours. A translucent foreground is composited
 * over the background first — a hairline at 16% alpha is not the ratio its raw
 * hex suggests, and reading it that way is how a border becomes invisible.
 */
export function contrastRatio(foreground, background) {
  const front = parseColor(foreground);
  const back = parseColor(background);
  if (!front || !back) return null;
  const resolved = composite(front, back);
  const lighter = Math.max(relativeLuminance(resolved), relativeLuminance(back));
  const darker = Math.min(relativeLuminance(resolved), relativeLuminance(back));
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Read the custom properties declared in each theme block of `globals.css`.
 *
 * Returns one map per mode. The dark block is the one selected by bare `:root`,
 * so it is what a viewer with no explicit preference sees.
 */
export function parseThemeBlocks(css) {
  const modes = {};
  const blockPattern = /(:root,\s*\[data-theme='dark'\]|\[data-theme='(light|dark)'\])\s*\{([^}]*)\}/g;
  for (const match of css.matchAll(blockPattern)) {
    const mode = match[0].startsWith(':root') ? 'dark' : match[2];
    const declarations = {};
    for (const line of match[3].split(';')) {
      const declaration = line.match(/\s*(--[\w-]+)\s*:\s*(.+)\s*$/);
      if (declaration) declarations[declaration[1]] = declaration[2].trim();
    }
    modes[mode] = { ...(modes[mode] ?? {}), ...declarations };
  }
  return modes;
}
