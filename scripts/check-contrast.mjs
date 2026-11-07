import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseThemeBlocks } from './lib/contrast.mjs';
import { auditPalette, auditTextRoles, EXEMPT } from './lib/contrast-audit.mjs';

/**
 * Fail the build when a palette token cannot be read against a surface it lands on.
 *
 * Colour is load-bearing in this product: the severity ramp is how a reader
 * learns whether a finding matters. The design audit measured two failures by
 * hand and this gate found seven more, including the most severe step of the
 * dark ramp at 2.77:1 on the surface every card uses.
 *
 *   node scripts/check-contrast.mjs
 */
const root = resolve(import.meta.dirname, '..');
const cssPath = join(root, 'app', 'app', 'globals.css');
const css = readFileSync(cssPath, 'utf8');

const modes = parseThemeBlocks(css);
if (Object.keys(modes).length === 0) {
  console.error(`Contrast gate failed: no theme blocks found in ${cssPath}.`);
  process.exit(1);
}

const themeBlock = {};
const block = css.match(/@theme\s*\{([\s\S]*?)\n\}/);
for (const line of (block?.[1] ?? '').split(';')) {
  const declaration = line.match(/\s*(--[\w-]+)\s*:\s*(.+)\s*$/);
  if (declaration) themeBlock[declaration[1]] = declaration[2].trim();
}

const { violations, checked } = auditPalette(modes);
const roleViolations = auditTextRoles(themeBlock);
const all = [...violations, ...roleViolations];

if (all.length > 0) {
  console.error(`Contrast gate failed: ${all.length} violation(s).`);
  for (const violation of all) console.error(`  ${violation}`);
  console.error('');
  console.error('WCAG 1.4.3 asks 4.5:1 of normal text; 1.4.11 asks 3:1 of a mark or a');
  console.error('boundary that carries information. Raise the token, or if it genuinely');
  console.error('carries no information, add it to EXEMPT in scripts/lib/contrast-audit.mjs');
  console.error('with the reason.');
  process.exit(1);
}

console.log(
  `Contrast gate passed: ${checked} pairs across ${Object.keys(modes).length} modes, ` +
  `${Object.keys(EXEMPT).length} documented exemptions.`,
);
