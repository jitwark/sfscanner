/**
 * Prunes build-time preview artifacts from the shipped export only (P6.3).
 *
 * Every static catalogue detail page embeds its validated SVG preview and
 * text fallback in HTML. The preview JSONL is therefore build input, not a
 * browser dependency of the static export. Keeping it in `data/` and
 * `app/public/data/` preserves reproducible builds; removing only the final
 * `app/out/data/previews/` copy avoids shipping the same preview twice.
 * The client-only `/w/view/` route loads chart data only after the explicit
 * canvas action, so it does not request this build-time artifact.
 *
 * Failing loudly if nothing is found prevents a moved output directory or a
 * future naming change from silently changing the export contract.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'app', 'out'));
const previewsDir = path.join(outDir, 'data', 'previews');

if (!fs.existsSync(previewsDir)) {
  console.error(`Export preview directory does not exist: ${previewsDir}. Run the build first.`);
  process.exit(1);
}

const files = fs.readdirSync(previewsDir);
if (files.length === 0) {
  console.error(`Export preview directory is empty: ${previewsDir}.`);
  process.exit(1);
}

const freedBytes = files.reduce((total, name) => total + fs.statSync(path.join(previewsDir, name)).size, 0);
fs.rmSync(previewsDir, { recursive: true, force: true });

const manifestPath = path.join(outDir, 'data', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.artifacts = manifest.artifacts.filter((artifact) => !artifact.path.startsWith('previews/'));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(
  `Pruned ${files.length} preview artifact(s) from the shipped export `
  + `(${(freedBytes / 1048576).toFixed(1)} MB freed).`,
);
console.log('data/ and app/public/data/ are untouched — previews remain build-time inputs.');
