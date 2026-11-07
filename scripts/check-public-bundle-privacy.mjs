import fs from 'node:fs';
import path from 'node:path';
import { MATCHERS } from './lib/corpus-privacy.mjs';
import { baselineTotals, regressions, summaryFieldPaths, sweepBundle } from './lib/public-bundle-privacy.mjs';

/**
 * Fail closed when the promoted public bundle carries more personal or
 * credential-shaped text than the committed baseline.
 *
 * The bundle is the artifact a consumer downloads, so this reads the promoted
 * directory itself — not the pipeline's intermediate files — and it prints
 * matcher totals plus field paths and affected-field counts, never a matched
 * value. Field paths are printed for triage; they never become an enforced
 * ceiling and are not part of the baseline.
 *
 * A run with no baseline fails: exit 0 has to mean "compared against a baseline
 * and nothing grew". Capturing that baseline is an owner-authorized operation
 * (`--write-baseline`, O-2), not a side effect of a failed run.
 *
 *   node scripts/check-public-bundle-privacy.mjs --bundle <dir> [--write-baseline]
 */
const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
let bundleArg;
let writeBaseline = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--bundle') {
    const value = args[index + 1];
    if (bundleArg !== undefined) {
      console.error('Public bundle privacy failed: --bundle was given more than once.');
      process.exit(1);
    }
    if (value === undefined || value === '' || value.startsWith('--')) {
      console.error('Public bundle privacy failed: --bundle needs a bundle directory.');
      process.exit(1);
    }
    bundleArg = value;
    index += 1;
  } else if (arg === '--write-baseline') {
    writeBaseline = true;
  } else {
    console.error(`Public bundle privacy failed: unknown argument ${arg}.`);
    process.exit(1);
  }
}
const bundleDir = path.resolve(root, bundleArg ?? 'outputs/public-dataset');
const baselinePath = path.join(root, 'scripts', 'public-bundle-privacy-baseline.json');

if (!fs.existsSync(path.join(bundleDir, 'ndjson', 'public-release.json'))) {
  console.error(`Public bundle privacy failed: no bundle at ${path.relative(root, bundleDir)}.`);
  process.exit(1);
}

let result;
try {
  result = sweepBundle(bundleDir);
} catch (error) {
  console.error(`Public bundle privacy failed: ${error instanceof Error ? error.message : 'unreadable bundle'}`);
  process.exit(1);
}

let baseline = null;
if (fs.existsSync(baselinePath)) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch {
    console.error(`Public bundle privacy failed: malformed baseline ${path.relative(root, baselinePath)}.`);
    process.exit(1);
  }
  try {
    baseline = baselineTotals(parsed);
  } catch (error) {
    console.error(`Public bundle privacy failed: ${error instanceof Error ? error.message : 'unreadable baseline'}`);
    process.exit(1);
  }
}

const fieldPaths = summaryFieldPaths(result);
console.log(`Public bundle privacy swept ${result.scanned} string leaves from ${path.relative(root, bundleDir)}.`);
for (const matcher of MATCHERS) {
  const count = result.totals[matcher.name];
  const limit = baseline?.[matcher.name];
  console.log(`  ${matcher.name.padEnd(20)} ${String(count).padStart(6)}${limit === undefined ? '' : ` (baseline ${limit})`}`);
  for (const [fieldPath, affectedFields] of fieldPaths[matcher.name] ?? []) {
    console.log(`    ${fieldPath} (${affectedFields} affected field${affectedFields === 1 ? '' : 's'})`);
  }
}

if (writeBaseline) {
  fs.writeFileSync(baselinePath, `${JSON.stringify({ capturedAgainstFields: result.scanned, totals: result.totals }, null, 2)}\n`);
  console.log(`Baseline written to ${path.relative(root, baselinePath)}.`);
  process.exit(0);
}

if (baseline === null) {
  console.error('Public bundle privacy failed: no baseline. Capture it once with --write-baseline and owner approval.');
  process.exit(1);
}

const grown = regressions(result, baseline);
if (grown.length > 0) {
  console.error('Public bundle privacy failed: more personal or credential-shaped text than the baseline.');
  for (const regression of grown) console.error(`  ${regression}`);
  process.exit(1);
}

console.log('Public bundle privacy passed.');
