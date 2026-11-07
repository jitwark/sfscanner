/**
 * Prunes scanner sidecars from the shipped export only.
 *
 * The canonical hub `data/` (and the build input copied to `app/public/data/`)
 * keeps the six `scanner/*` files: advisory/calibration gates, the internal
 * calibration fixtures, the inlined v2 analytics evidence, and the private
 * native scan evidence/inventory used while building. None of them is fetched
 * by a browser page, and the private evidence/inventory must never ship.
 * Removing only the final `app/out/data/scanner/` copy avoids publishing
 * artifacts the static site does not consume.
 *
 * The directory is removed by the catalogue/preview pruners' sibling step, so
 * an already-absent directory is a legitimate idempotent state: this script
 * still rewrites the manifest to drop any stale `scanner/` records. That is
 * the failure this guard exists for — a deleted directory with a manifest that
 * still promises the files turns the export into 404s.
 *
 * This script requires an explicit export path and refuses this checkout's
 * canonical `data/` and `app/public/data/` inputs, including through symlinks,
 * so a mistaken `.` or `app/public` cannot delete the build sources.
 *
 * Usage: node scripts/prune-export-scanner-sidecars.mjs <owned-out-dir>
 */
import fs from 'node:fs';
import path from 'node:path';

if (!process.argv[2]) {
  console.error('Usage: node scripts/prune-export-scanner-sidecars.mjs <owned-out-dir>');
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.resolve(process.argv[2]);
const dataDir = path.join(outDir, 'data');
const manifestPath = path.join(dataDir, 'manifest.json');

const canonical = (directory) => {
  try { return fs.realpathSync(directory); } catch { return path.resolve(directory); }
};
const protectedData = new Set([
  canonical(path.join(root, 'data')),
  canonical(path.join(root, 'app', 'public', 'data')),
]);
if (protectedData.has(canonical(dataDir))) {
  console.error(`Refusing to prune canonical build inputs: ${dataDir}`);
  process.exit(1);
}

if (!fs.existsSync(dataDir)) {
  console.error(`Export data directory does not exist: ${dataDir}. Run the build first.`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch {
  console.error(`Export manifest is missing or unreadable: ${manifestPath}.`);
  process.exit(1);
}
if (!manifest || !Array.isArray(manifest.artifacts)) {
  console.error(`Export manifest has no artifacts array: ${manifestPath}.`);
  process.exit(1);
}

const scannerDir = path.join(dataDir, 'scanner');
let freedBytes = 0;
let removedFiles = 0;
if (fs.existsSync(scannerDir)) {
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(child) : [child];
  });
  const files = walk(scannerDir);
  freedBytes = files.reduce((total, file) => total + fs.statSync(file).size, 0);
  removedFiles = files.length;
  fs.rmSync(scannerDir, { recursive: true, force: true });
}

const before = manifest.artifacts.length;
manifest.artifacts = manifest.artifacts.filter((artifact) => (
  !(typeof artifact?.path === 'string' && artifact.path.startsWith('scanner/'))
));
const dropped = before - manifest.artifacts.length;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(
  `Scanner sidecars: removed ${removedFiles} file(s) (${(freedBytes / 1048576).toFixed(1)} MB), `
  + `dropped ${dropped} stale manifest record(s); ${manifest.artifacts.length} artifact(s) remain.`,
);
console.log('Canonical data/, app/public/data/ and the private native export are untouched.');
