import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// The per-entry checks below are fatal-first by design: a duplicate ID or an
// invalid download range means the package is structurally wrong and there is
// nothing useful to report after it. What they should not do is answer a
// release question with a Node stack trace.
const reportAndExit = (error) => {
  console.error(`Corpus integrity failed: ${error?.message ?? error}`);
  process.exit(1);
};
process.on('uncaughtException', reportAndExit);
process.on('unhandledRejection', reportAndExit);

const root = path.resolve(import.meta.dirname, '..');
const dataArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const dataDir = path.resolve(dataArgument ?? path.join(root, 'data'));
const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8'));
const strictRelease = process.argv.includes('--release');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function filesUnder(directory, prefix = '') {
  const names = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, item.name).replace(/\\/g, '/');
    if (item.isDirectory()) names.push(...filesUnder(path.join(directory, item.name), relative));
    else names.push(relative);
  }
  return names;
}
const isScannerSidecar = (file) => file.startsWith('scanner/');

// Packaging drift is reported as a set, not one-at-a-time. Aborting on the
// first mismatch hides every artifact behind it, and a release gate whose
// output depends on alphabetical order is a gate you have to run N times to
// learn N facts.
const packagingViolations = [];

const expectedFiles = new Set([...(manifest.artifacts ?? []).map((artifact) => artifact.path.replace(/\\/g, '/')), 'manifest.json']);
const actualFiles = new Set(filesUnder(dataDir));
for (const file of actualFiles) {
  if (isScannerSidecar(file)) continue;
  if (!expectedFiles.has(file)) packagingViolations.push(`manifest does not own artifact: ${file}`);
}

for (const file of expectedFiles) {
  if (!actualFiles.has(file)) packagingViolations.push(`manifest artifact missing from disk: ${file}`);
}
for (const artifact of manifest.artifacts ?? []) {
  if (!actualFiles.has(artifact.path.replace(/\\/g, '/'))) continue;
  const bytes = fs.readFileSync(path.join(dataDir, artifact.path));
  if (bytes.length !== artifact.byteSize) {
    packagingViolations.push(`${artifact.path}: size ${bytes.length} bytes, manifest says ${artifact.byteSize}`);
    continue;
  }
  const actual = sha256(bytes);
  if (actual !== artifact.sha256) {
    packagingViolations.push(`${artifact.path}: sha256 ${actual}, manifest says ${artifact.sha256}`);
  }
}

if (packagingViolations.length) {
  console.error(`Corpus integrity failed: ${packagingViolations.length} packaging violation(s).`);
  for (const violation of packagingViolations) console.error(`  ${violation}`);
  console.error('\nRe-stamp the manifest (npm run prepare:release-data) and re-run.');
  process.exit(1);
}

const forbiddenKeys = new Set([
  'meta', 'pinData', 'binary', 'executionId', 'instanceId', 'versionId',
  'jsCode', 'pythonCode', 'functionCode', 'functionItemCode', 'code',
]);
const secretPatterns = [
  // (?<![A-Za-z0-9]) keeps these off ordinary prose: "risk-reviews" contains
  // "sk-reviews…", which the unanchored form flagged as an OpenAI key.
  /(?<![A-Za-z0-9])sk-(?:ant-)?[A-Za-z0-9_-]{20,}/i,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/,
  // GitHub tokens have fixed shapes: ghp_/gho_/ghu_/ghs_ + 36 alphanumerics,
  // github_pat_ + ≥50 mixed, glpat- + ≥20. The previous loose alternation
  // matched ordinary words like "Ghost_and_Sheets" inside repository URLs.
  /(?:gh[pos]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}|glpat-[A-Za-z0-9_-]{20})/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/i,
  /AKIA[0-9A-Z]{16}/,
  /(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]{8,}/,
  // 'bearer' followed by a real token shape: the loose form matched plain
  // prose like "external bearer authentication credentials".
  /Bearer\s+(?:sk|gh[pos]|github_pat|glpat|xox|AKIA)[A-Za-z0-9._~-]{8,}/i,
  /https?:\/\/[^\s:@]+:[^\s:@]+@[^\s/:]+/i,
];
function auditValue(value, location) {
  if (typeof value === 'string') {
    for (const pattern of secretPatterns) if (pattern.test(value)) throw new Error(`privacy audit secret-like value at ${location}`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((child, index) => auditValue(child, `${location}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    // A 'code' key holding an n8n expression string (=...) is a data column
    // named "code" in a node parameter (e.g. a Postgres column), not an
    // executable script body; real script bodies never start with '='.
    const isExpressionColumn = key === 'code' && typeof child === 'string' && child.startsWith('=');
    // Forbidden keys inside node parameters holding n8n expressions (={{ ... }})
    // are workflow content — e.g. an n8n node parameter executionId referencing
    // the error trigger's own execution. Run-residue fields sit at the workflow
    // root, which this same check still catches.
    const isParamExpression = typeof child === 'string' && child.startsWith('={{');
    if (forbiddenKeys.has(key) && !isExpressionColumn && !isParamExpression && child !== null && child !== undefined) throw new Error(`privacy audit forbidden field at ${childLocation}`);
    if (key === 'credentials' && child && typeof child === 'object' && !Array.isArray(child)) throw new Error(`privacy audit credential object at ${childLocation}`);
    auditValue(child, childLocation);
  }
}
for (const file of expectedFiles) {
  if (isScannerSidecar(file) || file === 'manifest.json' || (!file.startsWith('catalogue-') && !file.startsWith('packs/'))) continue;
  const content = fs.readFileSync(path.join(dataDir, file), 'utf8');
  if (file.endsWith('.jsonl')) {
    content.split('\n').forEach((line, index) => { if (line.trim()) auditValue(JSON.parse(line), `${file}:line-${index + 1}`); });
  } else {
    auditValue(JSON.parse(content), file);
  }
}

const packBuffers = new Map();
function packBuffer(pack) {
  if (!packBuffers.has(pack)) {
    const file = path.join(dataDir, 'packs', `pack-${pack}.jsonl`);
    if (!fs.existsSync(file)) throw new Error(`download pack missing: pack-${pack}.jsonl`);
    packBuffers.set(pack, fs.readFileSync(file));
  }
  return packBuffers.get(pack);
}

const byId = new Map();
let total = 0;
for (const artifact of manifest.artifacts ?? []) {
  if (!/^catalogue-\d+\.json$/.test(artifact.path)) continue;
  const shard = Number(artifact.path.match(/\d+/)?.[0]);
  const entries = JSON.parse(fs.readFileSync(path.join(dataDir, artifact.path), 'utf8'));
  if (!Array.isArray(entries)) throw new Error(`${artifact.path} is not an array`);
  total += entries.length;
  for (const entry of entries) {
    if (!entry?.id || byId.has(entry.id)) throw new Error(`duplicate/missing entry ID: ${entry?.id ?? '(missing)'}`);
    byId.set(entry.id, shard);
    if (entry.chartRef) {
      if (!Number.isInteger(entry.chartRef.shard) || !Number.isInteger(entry.chartRef.offset) || !Number.isInteger(entry.chartRef.length) || entry.chartRef.offset < 0 || entry.chartRef.length <= 0) {
        throw new Error(`invalid chartRef for ${entry.id}`);
      }
    }
    if (entry.download && entry.rights?.status !== 'redistributable') throw new Error(`link-only entry has download metadata: ${entry.id}`);
    if (entry.rights?.status === 'redistributable' && entry.dedup?.canonical === true) {
      if (!entry.download) throw new Error(`redistributable canonical entry has no download metadata: ${entry.id}`);
      const buffer = packBuffer(entry.download.pack);
      const line = buffer.subarray(entry.download.offset, entry.download.offset + entry.download.length);
      if (line.length !== entry.download.length || !line.toString('utf8').endsWith('\n')) {
        throw new Error(`invalid download range for ${entry.id}`);
      }
      try { JSON.parse(line.toString('utf8')); } catch { throw new Error(`download range is not JSON for ${entry.id}`); }
    }
    if (strictRelease) {
      if (entry.security?.scannerVersion === 'unknown') throw new Error(`unknown scanner version for ${entry.id}`);
      // 'not-scanned' is the explicit marker for link-only entries with no
      // retained body; 'unknown' (provenance lost) remains fatal.
      if (entry.descriptionSource === 'fallback') throw new Error(`fallback description is not publishable: ${entry.id}`);
      if (entry.dedup?.canonical === true && (entry.descriptionSource !== 'generated' || !entry.descriptionContent)) throw new Error(`entry is not Gemini-enriched: ${entry.id}`);
      if (entry.descriptionSource === 'generated' && (entry.descriptionProvenance?.source !== 'gemini' || !entry.descriptionProvenance.model || !entry.descriptionProvenance.promptVersion || !entry.descriptionProvenance.promptHash || !entry.descriptionProvenance.schemaVersion || !entry.descriptionProvenance.workflowHash || !entry.descriptionProvenance.generatedAt)) throw new Error(`generated entry has incomplete Gemini provenance: ${entry.id}`);
      if (!entry.compatibility) throw new Error(`compatibility missing for ${entry.id}`);
    }
  }
}
const map = manifest.catalogueShards;
if (!map || typeof map !== 'object') throw new Error('manifest.catalogueShards is missing');
if (total !== manifest.totalEntries || byId.size !== Object.keys(map).length) throw new Error(`manifest totals mismatch: entries=${total}, totalEntries=${manifest.totalEntries}, map=${Object.keys(map).length}`);
for (const [id, shard] of Object.entries(map)) if (byId.get(id) !== shard) throw new Error(`manifest shard mismatch for ${id}`);
if (strictRelease && (!manifest.metadata || manifest.metadata.scannerVersion === 'unknown')) {
  throw new Error('strict release requires manifest.metadata with known scannerVersion');
}
console.log(`Corpus integrity passed: ${total} entries, ${Object.keys(map).length} manifest ID mappings.`);
