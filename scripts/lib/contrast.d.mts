/**
 * Types for the WCAG contrast helpers.
 *
 * The implementation is `.mjs` because every gate script in `scripts/` is plain
 * Node with no build step — that is the convention `npm run check:*` depends on.
 * These declarations exist so a TypeScript test can use the same arithmetic the
 * gate uses instead of reimplementing relative luminance, which is precisely the
 * kind of second implementation that drifts.
 */
export type Rgba = { r: number; g: number; b: number; a: number };

export function parseColor(value: string): Rgba | null;
export function composite(foreground: Rgba, background: Rgba): Rgba;
export function relativeLuminance(color: { r: number; g: number; b: number }): number;
export function contrastRatio(foreground: string, background: string): number | null;
export function parseThemeBlocks(css: string): Record<string, Record<string, string>>;
