import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCANNER_MANIFEST_SCHEMA_VERSION = 'scanner-release-manifest-v1';
export const PREPARED_UNSIGNED_STATUS = 'PREPARED_UNSIGNED';

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRelative(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const normalised = value.replaceAll('\\', '/');
  if (normalised.startsWith('/') || /^[A-Za-z]:\//u.test(normalised)) return null;
  const parts = normalised.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return normalised;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function walkFiles(root, current, excludedRoot, output = []) {
  const entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => compareStrings(left.name, right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (absolute === excludedRoot || absolute.startsWith(`${excludedRoot}${path.sep}`)) continue;
    const stats = fs.lstatSync(absolute);
    if (stats.isSymbolicLink()) throw new Error(`artifact tree contains a symbolic link: ${path.relative(root, absolute)}`);
    if (stats.isDirectory()) walkFiles(root, absolute, excludedRoot, output);
    else if (stats.isFile()) {
      const relative = canonicalRelative(path.relative(root, absolute));
      if (relative === null) throw new Error(`artifact path is not safe: ${path.relative(root, absolute)}`);
      const bytes = fs.readFileSync(absolute);
      output.push(Object.freeze({ path: relative, size: bytes.byteLength, sha256: sha256(bytes) }));
    } else throw new Error(`artifact tree contains a special file: ${path.relative(root, absolute)}`);
  }
  return output;
}

function sourceRecord(sourceSha256) {
  if (sourceSha256 === undefined || sourceSha256 === null) return Object.freeze({ sha256: null, status: 'PENDING_CI' });
  if (!/^[a-f0-9]{64}$/iu.test(sourceSha256)) throw new TypeError('sourceSha256 must be a 64-character SHA-256 digest');
  return Object.freeze({ sha256: sourceSha256.toLowerCase(), status: 'VERIFIED' });
}

export function buildScannerManifest({
  artifactRoot, packageName = 'sfscanner', packageVersion = '0.1.0', sourceSha256, excludeRoot, includePaths,
} = {}) {
  const root = path.resolve(artifactRoot ?? process.cwd());
  const rootStats = fs.lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new TypeError('artifactRoot must be a real directory');
  if (typeof packageName !== 'string' || packageName.length === 0) throw new TypeError('packageName is required');
  if (typeof packageVersion !== 'string' || packageVersion.length === 0) throw new TypeError('packageVersion is required');
  const excluded = excludeRoot === undefined ? null : path.resolve(excludeRoot);
  const allArtifacts = walkFiles(root, root, excluded);
  const selected = Array.isArray(includePaths) && includePaths.length > 0
    ? allArtifacts.filter((artifact) => includePaths.some((entry) => artifact.path === entry || artifact.path.startsWith(`${entry}/`)))
    : allArtifacts;
  const artifacts = selected.sort((left, right) => compareStrings(left.path, right.path));
  return Object.freeze({
    schemaVersion: SCANNER_MANIFEST_SCHEMA_VERSION,
    status: PREPARED_UNSIGNED_STATUS,
    ownerStatus: 'PENDING_OWNER',
    package: Object.freeze({ name: packageName, version: packageVersion }),
    source: sourceRecord(sourceSha256),
    license: Object.freeze({ status: 'PENDING_OWNER', notices: 'INCLUDED' }),
    artifacts: Object.freeze(artifacts),
    signature: Object.freeze({ status: 'PENDING_OWNER' }),
    provenance: Object.freeze({ status: 'PENDING_CI' }),
  });
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function checksumText(manifest) {
  return `${manifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join('\n')}\n`;
}
export function writeScannerManifest({
  artifactRoot, outputDirectory, packageName, packageVersion, sourceSha256, includePaths,
} = {}) {
  const output = path.resolve(outputDirectory ?? path.join(process.cwd(), 'outputs', 'distribution'));
  fs.mkdirSync(output, { recursive: true });
  const manifest = buildScannerManifest({
    artifactRoot, packageName, packageVersion, sourceSha256, includePaths, excludeRoot: output,
  });
  const manifestPath = path.join(output, 'scanner-manifest.json');
  const checksumsPath = path.join(output, 'SHA256SUMS');
  fs.writeFileSync(manifestPath, canonicalJson(manifest), 'utf8');
  fs.writeFileSync(checksumsPath, checksumText(manifest), 'utf8');
  return Object.freeze({ manifest, manifestPath, checksumsPath });

}
function cli(argv) {
  const positional = [];
  let sourceSha256;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source-sha256') sourceSha256 = argv[++index];
    else if (argument?.startsWith('--source-sha256=')) sourceSha256 = argument.slice('--source-sha256='.length);
    else if (argument?.startsWith('-')) throw new Error(`unknown option: ${argument}`);
    else positional.push(argument);
  }
  if (positional.length > 2) throw new Error('expected at most artifact root and output directory');
  const artifactRoot = positional[0] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'scanner-cli');
  const outputDirectory = positional[1] ?? path.resolve('outputs', 'distribution');
  return writeScannerManifest({
    artifactRoot, outputDirectory, sourceSha256,
    includePaths: ['dist', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json'],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = cli(process.argv.slice(2));
  process.stdout.write(`Prepared unsigned scanner manifest: ${result.manifestPath}\n`);
  process.stdout.write(`Prepared checksum list: ${result.checksumsPath}\n`);
}
