import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDependencyComponents, licensesFor, purlFor } from './lib/scanner-release-package.mjs';
import { readPackedSourceMaps } from './lib/scanner-packed-artifact.mjs';

/**
 * Scanner SBOM generator: CycloneDX 1.5 JSON (https://cyclonedx.org/docs/1.5/json/), schema
 * http://cyclonedx.org/schema/bom-1.5.schema.json. Chosen over SPDX 2.3 JSON because
 * `metadata.timestamp` is OPTIONAL in 1.5 (deterministic generation without a fabricated time),
 * `component.purl` is first-class, and `license` is `oneOf` SPDX `{id}` or free-text `{name}`.
 * SPDX 2.3 makes `created` required (§6.9) and needs a `LicenseRef-` for licences off the SPDX list.
 * Full justification, with citation URLs, is in docs/audit/2026-10-17-remediation/E1c-report.md.
 *
 * Members emitted are limited to what the 1.5 schema allows: top-level `bomFormat` + `specVersion`,
 * component `type` + `name`, `hash.alg` with lowercase-hex `content`, exactly one of
 * `license.id`/`license.name`, and no wall-clock timestamp or absolute user path.
 */
export const SBOM_STATUS_SCHEMA_VERSION = 'scanner-sbom-status-v1';
export const SCANNER_SBOM_SCHEMA_URL = 'http://cyclonedx.org/schema/bom-1.5.schema.json';
export const SCANNER_SBOM_FILENAME = 'scanner-sbom.cyclonedx.json';
export const SCANNER_SBOM_STATUS_FILENAME = 'scanner-sbom-status.json';
export const SBOM_GENERATOR_NAME = 'sfscanner-sbom-generator';
export const SBOM_GENERATOR_VERSION = '1.0.0';
export const DEFAULT_LOCKFILE_PATH = 'package-lock.json';
export const DEFAULT_WORKSPACE_PATH = 'packages/scanner-cli';
export const DEFAULT_DIST_DIRECTORY = 'dist';
const TIMESTAMP_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
export const DEFAULT_OUTPUT_DIRECTORY = path.join('outputs', 'distribution');

const PENDING_STATUS = Object.freeze({
  schemaVersion: SBOM_STATUS_SCHEMA_VERSION,
  status: 'PENDING_CI',
  ownerStatus: 'PENDING_OWNER',
  formats: Object.freeze([]),
  reason: 'scripts/generate-scanner-sbom.mjs now emits the CycloneDX 1.5 SBOM; this document only records that no CI run has attached that SBOM and no release owner has approved it yet.',
});

const PRIVATE_DATA_PATTERNS = Object.freeze([
  { label: 'absolute path', pattern: /(?:^|[^A-Za-z0-9+.-])[A-Za-z]:[\\/]/u },
  { label: 'absolute user path', pattern: /\/(?:Users|home)\/[^/\s"]+/u },
  { label: 'UNC path', pattern: /\\\\[^\\\s"]+/u },
  { label: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { label: 'API token', pattern: /\b(?:sk|npm|gh[pousr])_[A-Za-z0-9]{16,}\b/u },
  { label: 'registry auth token', pattern: /_authToken/u },
]);

export class ScannerSbomSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScannerSbomSourceError';
    this.code = code;
  }
}

export class ScannerSbomPrivacyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScannerSbomPrivacyError';
    this.code = 'PRIVATE_DATA';
  }
}

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const posix = (value) => value.split(path.sep).join('/');
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const property = (name, value) => ({ name, value: String(value) });
const sortProperties = (properties) => properties.filter(Boolean).sort((left, right) => compare(left.name, right.name));

function readJson(sourcePath, { code, label }) {
  let content;
  try {
    content = fs.readFileSync(sourcePath, 'utf8');
  } catch {
    throw new ScannerSbomSourceError(code, `missing ${label} (the SBOM is generated from the resolved dependency set, never from assumed data)`);
  }
  try {
    return { value: JSON.parse(content), sha256: sha256Hex(content) };
  } catch {
    throw new ScannerSbomSourceError(`${code}_INVALID`, `invalid JSON in ${label}`);
  }
}

function resolveTimestamp({ timestamp, sourceDateEpoch }) {
  // An empty variable (the common `--source-date-epoch "$SOURCE_DATE_EPOCH"` case) means "not set".
  const epoch = sourceDateEpoch === '' ? null : sourceDateEpoch ?? process.env.SOURCE_DATE_EPOCH;
  const supplied = timestamp === undefined || timestamp === null || timestamp === '' ? null : timestamp;
  if (supplied !== null) {
    // An offset-less date-time would be read in the host time zone, so the bytes would differ per
    // machine. Require Z or an explicit offset instead of assuming one.
    if (typeof supplied !== 'string' || !TIMESTAMP_WITH_OFFSET.test(supplied) || Number.isNaN(Date.parse(supplied))) {
      throw new ScannerSbomSourceError('TIMESTAMP_INVALID', 'timestamp must be an ISO-8601 date-time with an explicit UTC offset or Z (e.g. 2026-10-17T10:00:00Z)');
    }
    return new Date(supplied).toISOString();
  }
  if (epoch === undefined || epoch === null || epoch === '') return null;
  if (!/^\d{1,12}$/u.test(String(epoch))) {
    throw new ScannerSbomSourceError('TIMESTAMP_INVALID', 'SOURCE_DATE_EPOCH must be integer seconds since the Unix epoch');
  }
  return new Date(Number(epoch) * 1000).toISOString();
}

function assertNoPrivateData(json) {
  for (const { label, pattern } of PRIVATE_DATA_PATTERNS) {
    if (pattern.test(json)) throw new ScannerSbomPrivacyError(`refusing to write the SBOM: detected ${label} in the generated document`);
  }
}

export function generateScannerSbom({
  rootDirectory,
  lockfilePath = DEFAULT_LOCKFILE_PATH,
  workspacePath = DEFAULT_WORKSPACE_PATH,
  distDirectory,
  outputDirectory,
  outputFileName = SCANNER_SBOM_FILENAME,
  timestamp,
  sourceDateEpoch,
  revision,
} = {}) {
  const root = path.resolve(rootDirectory ?? process.cwd());
  const lockfileAbsolute = path.resolve(root, lockfilePath);
  const lockfileLabel = posix(path.relative(root, lockfileAbsolute)) || DEFAULT_LOCKFILE_PATH;
  const workspaceRelative = posix(path.relative(root, path.resolve(root, workspacePath))) || workspacePath;
  const lockfile = readJson(lockfileAbsolute, { code: 'LOCKFILE_MISSING', label: lockfileLabel });
  if (!lockfile.value.packages || Object.keys(lockfile.value.packages).length === 0) {
    throw new ScannerSbomSourceError('LOCKFILE_EMPTY', `${lockfileLabel} contains no resolved packages; a lockfileVersion 2 or 3 package-lock.json is required`);
  }
  const workspaceLabel = `${workspaceRelative}/package.json`;
  const workspace = readJson(path.join(root, workspaceRelative, 'package.json'), { code: 'WORKSPACE_MISSING', label: workspaceLabel });
  const manifest = workspace.value;
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new ScannerSbomSourceError('WORKSPACE_INVALID', `${workspaceLabel} does not declare a package name and version`);
  }
  // What the packed artifact actually ships: the modules named by its build-output source maps,
  // not what the lockfile declares. Without that evidence the shipped set would be a guess.
  const distAbsolute = path.resolve(root, distDirectory ?? path.join(workspaceRelative, DEFAULT_DIST_DIRECTORY));
  const distLabel = `${posix(path.relative(root, distAbsolute))}/`;
  const evidence = readPackedSourceMaps({ distDirectory: distAbsolute, rootDirectory: root });
  if (evidence.maps.length === 0) {
    throw new ScannerSbomSourceError('ARTIFACT_EVIDENCE_MISSING', `no dist source maps under ${distLabel} to derive what the packed artifact ships; build the scanner first (npm run build:scanner)`);
  }
  const { components, edges } = collectDependencyComponents({
    packages: lockfile.value.packages,
    workspacePath: workspaceRelative,
    workspaceManifest: manifest,
    lockfileLabel,
    observedPaths: evidence.paths,
  });
  const resolvedTimestamp = resolveTimestamp({ timestamp, sourceDateEpoch });
  const rootRef = purlFor(manifest.name, manifest.version);
  const rootLicenses = licensesFor(manifest.license);
  const repositoryUrl = /^(?:git\+)?https?:\/\/\S+$/u.exec(manifest.repository?.url ?? '')?.[0]?.replace(/^git\+/u, '');
  const serialSeed = sha256Hex(`${rootRef}|${lockfile.sha256}|${workspace.sha256}|${resolvedTimestamp ?? 'NO_TIMESTAMP'}|${revision ?? 'NO_REVISION'}`);

  const document = {
    $schema: SCANNER_SBOM_SCHEMA_URL,
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    // Deterministic RFC 9562 UUIDv8 (custom, SHA-256 derived) instead of a random serial number.
    serialNumber: `urn:uuid:${serialSeed.slice(0, 8)}-${serialSeed.slice(8, 12)}-8${serialSeed.slice(13, 16)}-8${serialSeed.slice(17, 20)}-${serialSeed.slice(20, 32)}`,
    version: 1,
    metadata: {
      ...(resolvedTimestamp ? { timestamp: resolvedTimestamp } : {}),
      lifecycles: [{ phase: 'build' }],
      tools: {
        components: [{
          type: 'application',
          name: SBOM_GENERATOR_NAME,
          version: SBOM_GENERATOR_VERSION,
          properties: [property('sfscanner:script', 'scripts/generate-scanner-sbom.mjs')],
        }],
      },
      component: {
        type: 'library',
        'bom-ref': rootRef,
        name: manifest.name,
        version: manifest.version,
        purl: rootRef,
        ...(rootLicenses.length > 0 ? { licenses: rootLicenses } : {}),
        ...(repositoryUrl ? { externalReferences: [{ type: 'vcs', url: repositoryUrl }] } : {}),
        // The packaged lifecycle/build scripts are recorded as an annotation on the packaged component.
        properties: sortProperties(Object.entries(manifest.scripts ?? {}).map(([name, command]) => property(`sfscanner:lifecycle-script:${name}`, command))),
      },
      properties: sortProperties([
        property('sfscanner:packed-artifact-evidence', `${distLabel} source maps: ${evidence.maps.length} file(s), ${evidence.paths.length} source path(s), sha256 ${evidence.digest}${evidence.unresolved > 0 ? `, ${evidence.unresolved} unresolved source(s)` : ''}`),
        property('sfscanner:source-lockfile-sha256', lockfile.sha256),
        property('sfscanner:source-package-sha256', workspace.sha256),
        revision && property('sfscanner:source-revision', revision),
        resolvedTimestamp === null && property('sfscanner:timestamp-unavailable', 'no timestamp injected; set SOURCE_DATE_EPOCH or pass timestamp to pin one'),
      ]),
    },
    components,
    dependencies: [
      { ref: rootRef, dependsOn: components.filter(({ scope }) => scope === 'required').map(({ purl }) => purl) },
      ...components.map(({ purl }) => ({ ref: purl, dependsOn: edges.find((edge) => edge.purl === purl)?.dependsOn ?? [] })),
    ],
  };

  const json = `${JSON.stringify(document, null, 2)}\n`;
  assertNoPrivateData(json);
  const output = path.resolve(outputDirectory ?? path.join(root, DEFAULT_OUTPUT_DIRECTORY));
  fs.mkdirSync(output, { recursive: true });
  const outputPath = path.join(output, outputFileName);
  fs.writeFileSync(outputPath, json, 'utf8');
  return Object.freeze({ document, json, outputPath, lockfileSha256: lockfile.sha256, packageSha256: workspace.sha256 });
}

export function generateScannerSbomStatus({ outputDirectory } = {}) {
  const output = path.resolve(outputDirectory ?? path.join(process.cwd(), DEFAULT_OUTPUT_DIRECTORY));
  fs.mkdirSync(output, { recursive: true });
  const statusPath = path.join(output, SCANNER_SBOM_STATUS_FILENAME);
  fs.writeFileSync(statusPath, `${JSON.stringify(PENDING_STATUS, null, 2)}\n`, 'utf8');
  return Object.freeze({ status: PENDING_STATUS, statusPath });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const options = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) options[argv[index].slice(2)] = argv[index] === '--status' ? true : argv[++index];
    else options.positional.push(argv[index]);
  }
  if (options.status) {
    const result = generateScannerSbomStatus({ outputDirectory: options.out ?? options.positional[0] });
    process.stdout.write(`SBOM status recorded as ${result.status.status}: ${result.statusPath}\n`);
  } else {
    const result = generateScannerSbom({
      rootDirectory: options.root,
      outputDirectory: options.out ?? options.positional[0],
      lockfilePath: options.lockfile ?? DEFAULT_LOCKFILE_PATH,
      workspacePath: options.workspace ?? DEFAULT_WORKSPACE_PATH,
      distDirectory: options.dist,
      timestamp: options.timestamp,
      sourceDateEpoch: options['source-date-epoch'],
      revision: options.revision,
    });
    process.stdout.write(`CycloneDX ${result.document.specVersion} SBOM (${result.document.components.length} components) written to ${result.outputPath}\n`);
  }
}
