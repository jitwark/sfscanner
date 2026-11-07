import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listFilesRecursively } from './lib/walk.mjs';
import { findFillOnlyForegroundUses } from './lib/accent-usage.mjs';

/**
 * Fail the build when a component uses a fill-only colour as a foreground.
 *
 * `check:contrast` proves the palette is sound. This proves the palette is used
 * soundly, which is a different question and the one that actually broke: when
 * the accent moved from violet to amber, 103 components that had reasonably
 * written `text-accent` became 1.51:1 in light mode, and every gate stayed
 * green because the palette was still correct and the markup was still valid.
 *
 *   node scripts/check-accent-usage.mjs
 */
const root = resolve(import.meta.dirname, '..');
const roots = ['app/src', 'app/app'];

const violations = [];
let scanned = 0;

for (const directory of roots) {
  for (const file of await listFilesRecursively(join(root, directory))) {
    if (!/[.](tsx?|jsx?)$/.test(file)) continue;
    scanned += 1;
    for (const use of findFillOnlyForegroundUses(readFileSync(join(root, directory, file), 'utf8'))) {
      violations.push(`${directory}/${file}:${use.line}: \`${use.utility}\` — use ${use.advice}`);
    }
  }
}

console.log(`Accent usage checked: ${scanned} component files.`);

if (violations.length > 0) {
  console.error(`Accent usage gate failed: ${violations.length} use(s) of a fill-only colour as a foreground.`);
  for (const violation of violations.slice(0, 30)) console.error(`  ${violation}`);
  if (violations.length > 30) console.error(`  ... ${violations.length - 30} more`);
  console.error('');
  console.error('Amber is the accent. It is 1.51:1 on white, so it fills shapes and never');
  console.error('carries words or draws a boundary. The tokens that do are declared in');
  console.error('app/app/globals.css and measured by npm run check:contrast.');
  process.exit(1);
}

console.log('Accent usage gate passed: no fill-only colour is used as a foreground.');
