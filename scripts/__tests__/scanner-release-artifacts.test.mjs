import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateScannerSourceMap } from '../../packages/scanner-cli/build.mjs';
import { buildScannerManifest, writeScannerManifest } from '../create-scanner-manifest.mjs';
import { verifyScannerChecksums } from '../check-scanner-checksums.mjs';
import {
  SBOM_STATUS_SCHEMA_VERSION,
  SCANNER_SBOM_FILENAME,
  SCANNER_SBOM_STATUS_FILENAME,
  ScannerSbomSourceError,
  generateScannerSbom,
  generateScannerSbomStatus,
} from '../generate-scanner-sbom.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-release-artifacts-'));
  temporaryDirectories.push(directory);
  return directory;
}

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function writeJson(root, relativePath, value) {
  write(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

const PACKED_SRI = `sha512-${Buffer.from('ab'.repeat(64), 'hex').toString('base64')}`;
const DEV_SRI = `sha256-${Buffer.from('cd'.repeat(32), 'hex').toString('base64')}`;
const TIMESTAMP = '2026-10-17T00:00:00.000Z';

// Synthetic workspace: packed package, one linked workspace dependency, one dev-only tool, and one
// declared runtime dependency the packed artifact never contains.
function sbomFixture() {
  const root = fixture();
  const packedPackage = {
    name: 'demo-pkg',
    version: '1.2.3',
    license: 'MIT',
    dependencies: { 'left-pad': '^1.3.0', '@demo/util': '*', 'ghost-lib': '^1.0.0' },
    devDependencies: { 'dev-tool': '^2.0.0', 'no-license-tool': '^3.0.0' },
    scripts: { build: 'node build.mjs', test: 'vitest run' },
  };
  writeJson(root, 'packages/demo/package.json', packedPackage);
  writeJson(root, 'packages/util/package.json', { name: '@demo/util', version: '0.1.0', license: 'Apache-2.0' });
  writeJson(root, 'package-lock.json', {
    name: 'demo-root',
    version: '0.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'demo-root' },
      'packages/demo': packedPackage,
      'packages/util': { name: '@demo/util', version: '0.1.0', license: 'Apache-2.0' },
      'node_modules/demo-pkg': { resolved: 'packages/demo', link: true },
      'node_modules/@demo/util': { resolved: 'packages/util', link: true },
      'node_modules/left-pad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: PACKED_SRI, license: 'MIT' },
      'node_modules/dev-tool': { version: '2.0.0', resolved: 'https://registry.npmjs.org/dev-tool/-/dev-tool-2.0.0.tgz', integrity: DEV_SRI, license: 'SEE LICENSE IN LICENSE.txt' },
      'node_modules/no-license-tool': { version: '3.0.0', resolved: 'https://registry.npmjs.org/no-license-tool/-/no-license-tool-3.0.0.tgz', integrity: DEV_SRI },
      'node_modules/ghost-lib': { version: '1.0.0', resolved: 'https://registry.npmjs.org/ghost-lib/-/ghost-lib-1.0.0.tgz', integrity: PACKED_SRI, license: 'MIT' },
    },
  });
  // The evidence the SBOM classifies with: the source maps shipped next to the built bundle. Only
  // @demo/util and left-pad appear here; ghost-lib is declared but never inlined.
  writeJson(root, 'packages/demo/dist/main.js.map', {
    version: 3,
    sources: ['../src/main.ts', '../../../packages/util/index.js', '../../../node_modules/left-pad/index.js'],
  });
  return root;
}

function build(documentRoot, extra = {}) {
  return generateScannerSbom({
    rootDirectory: documentRoot,
    workspacePath: 'packages/demo',
    outputDirectory: path.join(documentRoot, 'out'),
    timestamp: TIMESTAMP,
    ...extra,
  });
}

const componentNamed = (document, name) => document.components.find((component) => component.name === name);
const propertyValue = (subject, name) => subject.properties?.find((property) => property.name === name)?.value;

describe('prepared scanner release artifacts', () => {
  it('builds a deterministic unsigned manifest over sorted relative files', () => {
    const root = fixture();
    write(root, 'dist/main.js', 'bundle\n');
    write(root, 'README.md', '# scanner\n');

    const first = buildScannerManifest({ artifactRoot: root, packageName: 'sfscanner', packageVersion: '0.1.0', sourceSha256: 'a'.repeat(64) });
    const second = buildScannerManifest({ artifactRoot: root, packageName: 'sfscanner', packageVersion: '0.1.0', sourceSha256: 'a'.repeat(64) });

    expect(first).toEqual(second);
    expect(first.status).toBe('PREPARED_UNSIGNED');
    expect(first.ownerStatus).toBe('PENDING_OWNER');
    expect(first.artifacts.map(({ path: file }) => file)).toEqual(['README.md', 'dist/main.js']);
    expect(first.signature).toEqual({ status: 'PENDING_OWNER' });
    expect(first.license).toEqual({ status: 'PENDING_OWNER', notices: 'INCLUDED' });
    expect(first.provenance).toEqual({ status: 'PENDING_CI' });
  });

  it('writes canonical LF JSON and checksums that verify without network or signing', () => {
    const root = fixture();
    const output = path.join(root, 'release');
    write(root, 'dist/main.js', 'bundle\n');
    const result = writeScannerManifest({ artifactRoot: root, outputDirectory: output, sourceSha256: 'b'.repeat(64) });

    expect(result.manifestPath).toBe(path.join(output, 'scanner-manifest.json'));
    expect(result.checksumsPath).toBe(path.join(output, 'SHA256SUMS'));
    expect(fs.readFileSync(result.manifestPath, 'utf8').endsWith('\n')).toBe(true);
    expect(fs.readFileSync(result.manifestPath, 'utf8')).not.toContain('\r');
    expect(fs.readFileSync(result.checksumsPath, 'utf8')).not.toContain('\r');
    expect(verifyScannerChecksums({ artifactRoot: root, checksumFile: result.checksumsPath })).toEqual({ ok: true, errors: [] });
  });

  it('still records pending SBOM ownership on request instead of claiming a generated SBOM', () => {
    const root = fixture();
    const result = generateScannerSbomStatus({ outputDirectory: root });
    const status = JSON.parse(fs.readFileSync(result.statusPath, 'utf8'));

    expect(result.statusPath).toBe(path.join(root, SCANNER_SBOM_STATUS_FILENAME));
    expect(status).toMatchObject({ schemaVersion: SBOM_STATUS_SCHEMA_VERSION, status: 'PENDING_CI', ownerStatus: 'PENDING_OWNER', formats: [] });
    expect(fs.existsSync(path.join(root, 'scanner-sbom.spdx.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, SCANNER_SBOM_FILENAME))).toBe(false);
  });

  it('emits a CycloneDX 1.5 document whose components carry the schema-required fields', () => {
    const root = sbomFixture();
    const { document, outputPath } = build(root);

    expect(path.basename(outputPath)).toBe(SCANNER_SBOM_FILENAME);
    expect(document.$schema).toBe('http://cyclonedx.org/schema/bom-1.5.schema.json');
    expect(document.bomFormat).toBe('CycloneDX');
    expect(document.specVersion).toBe('1.5');
    expect(document.version).toBe(1);
    expect(document.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(document.metadata.timestamp).toBe(TIMESTAMP);
    expect(document.metadata.lifecycles).toEqual([{ phase: 'build' }]);
    expect(document.metadata.component).toMatchObject({
      type: 'library', name: 'demo-pkg', version: '1.2.3', purl: 'pkg:npm/demo-pkg@1.2.3',
      'bom-ref': 'pkg:npm/demo-pkg@1.2.3', licenses: [{ license: { id: 'MIT' } }],
    });
    for (const component of document.components) {
      expect(typeof component.type).toBe('string');
      expect(typeof component.name).toBe('string');
      for (const entry of component.licenses ?? []) expect(Number('id' in entry.license) + Number('name' in entry.license)).toBe(1);
      for (const hash of component.hashes ?? []) {
        expect(['SHA-256', 'SHA-512']).toContain(hash.alg);
        expect(hash.content).toMatch(/^[a-f0-9]{64}$|^[a-f0-9]{128}$/u);
      }
    }
  });

  it('lists shipped and dev-only lockfile dependencies with purl, licence, URL and integrity', () => {
    const root = sbomFixture();
    const { document } = build(root, { revision: 'c005c91' });

    expect(document.components.map((component) => component.name)).toEqual(['@demo/util', 'dev-tool', 'ghost-lib', 'left-pad', 'no-license-tool']);
    expect(componentNamed(document, 'left-pad')).toMatchObject({
      type: 'library',
      version: '1.3.0',
      purl: 'pkg:npm/left-pad@1.3.0',
      scope: 'required',
      licenses: [{ license: { id: 'MIT' } }],
      hashes: [{ alg: 'SHA-512', content: 'ab'.repeat(64) }],
      externalReferences: [{ type: 'distribution', url: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz' }],
    });
    expect(propertyValue(componentNamed(document, 'left-pad'), 'sfscanner:lockfile-integrity')).toBe(PACKED_SRI);
    expect(propertyValue(componentNamed(document, 'left-pad'), 'sfscanner:observed-in-packed-artifact')).toBe('true');
    expect(propertyValue(componentNamed(document, 'left-pad'), 'sfscanner:observed-source-path')).toBe('node_modules/left-pad/index.js');
    expect(componentNamed(document, '@demo/util')).toMatchObject({ purl: 'pkg:npm/%40demo/util@0.1.0', scope: 'required', licenses: [{ license: { id: 'Apache-2.0' } }] });
    expect(propertyValue(componentNamed(document, '@demo/util'), 'sfscanner:lockfile-path')).toBe('packages/util');
    expect(componentNamed(document, 'dev-tool')).toMatchObject({ version: '2.0.0', scope: 'excluded', licenses: [{ license: { name: 'SEE LICENSE IN LICENSE.txt' } }], hashes: [{ alg: 'SHA-256', content: 'cd'.repeat(32) }] });
    expect(propertyValue(componentNamed(document, 'dev-tool'), 'sfscanner:observed-in-packed-artifact')).toBe('false');
    expect(componentNamed(document, 'ghost-lib')).toMatchObject({ scope: 'optional', licenses: [{ license: { id: 'MIT' } }] });
    expect(propertyValue(componentNamed(document, 'ghost-lib'), 'sfscanner:observed-in-packed-artifact')).toBe('false');
    expect(propertyValue(componentNamed(document, 'ghost-lib'), 'sfscanner:observed-source-path')).toBeUndefined();
    expect(componentNamed(document, 'no-license-tool').licenses).toBeUndefined();
    expect(propertyValue(componentNamed(document, 'no-license-tool'), 'sfscanner:license-declared')).toBe('none declared in package-lock.json or node_modules/no-license-tool/package.json');
    expect(document.dependencies).toContainEqual({ ref: 'pkg:npm/demo-pkg@1.2.3', dependsOn: ['pkg:npm/%40demo/util@0.1.0', 'pkg:npm/left-pad@1.3.0'] });
    expect(document.dependencies).toContainEqual({ ref: 'pkg:npm/dev-tool@2.0.0', dependsOn: [] });

    expect(propertyValue(document.metadata.component, 'sfscanner:lifecycle-script:build')).toBe('node build.mjs');
    expect(propertyValue(document.metadata.component, 'sfscanner:lifecycle-script:test')).toBe('vitest run');
    expect(propertyValue(document.metadata, 'sfscanner:source-revision')).toBe('c005c91');
    for (const name of ['sfscanner:source-lockfile-sha256', 'sfscanner:source-package-sha256']) expect(propertyValue(document.metadata, name)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('marks a component shipped only when the packed artifact evidence contains it', () => {
    const root = sbomFixture();
    const { document } = build(root);

    for (const component of document.components) {
      const observed = propertyValue(component, 'sfscanner:observed-in-packed-artifact');
      expect(observed).toMatch(/^(?:true|false)$/u);
      if (component.scope === 'required') expect(observed).toBe('true');
      else expect(observed).toBe('false');
    }
    expect(document.components.filter(({ scope }) => scope === 'required').map(({ name }) => name)).toEqual(['@demo/util', 'left-pad']);
    expect(propertyValue(document.metadata, 'sfscanner:packed-artifact-evidence')).toMatch(/^packages\/demo\/dist\/ source maps: 1 file\(s\), 3 source path\(s\), sha256 [a-f0-9]{64}$/u);
  });

  it('refuses to guess the shipped set when the packed artifact has no source-map evidence', () => {
    const root = sbomFixture();
    fs.rmSync(path.join(root, 'packages/demo/dist'), { recursive: true, force: true });

    expect(() => build(root)).toThrow(ScannerSbomSourceError);
    expect(() => build(root)).toThrow(/no dist source maps/u);
    expect(fs.readdirSync(root)).not.toContain('out');
  });

  it('is byte-identical across runs with the same injected timestamp and differs when a dependency changes', () => {
    const root = sbomFixture();
    const first = build(root);
    const second = build(root);
    expect(first.json).toBe(second.json);
    expect(fs.readFileSync(first.outputPath, 'utf8')).toBe(second.json);

    const lockfile = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    lockfile.packages['node_modules/left-pad'].version = '1.4.0';
    writeJson(root, 'package-lock.json', lockfile);

    expect(build(root).json).not.toBe(first.json);
  });

  it('injects timestamps, omits them with an unavailable note and leaks no private paths', () => {
    const root = sbomFixture();
    const environment = process.env.SOURCE_DATE_EPOCH;
    delete process.env.SOURCE_DATE_EPOCH;
    try {
      const injected = build(root, { timestamp: undefined, sourceDateEpoch: 1_700_000_000 });
      expect(JSON.parse(injected.json).metadata.timestamp).toBe('2023-11-14T22:13:20.000Z');
      expect(injected.json.endsWith('\n')).toBe(true);
      expect(injected.json).not.toContain('\r');
      expect(injected.json).not.toContain(root);
      expect(injected.json).not.toMatch(/(?:^|[^A-Za-z0-9+.-])[A-Za-z]:[\\/]/u);
      expect(injected.outputPath.startsWith(root)).toBe(true);

      expect(() => build(root, { timestamp: undefined, sourceDateEpoch: undefined, timestamp: '2026-10-17T10:00:00' })).toThrow(/TIMESTAMP_INVALID|explicit UTC offset/u);
      expect(JSON.parse(build(root, { timestamp: '2026-10-17T10:00:00+02:00' }).json).metadata.timestamp).toBe('2026-10-17T08:00:00.000Z');

      const unavailable = build(root, { timestamp: undefined }).document;
      expect(unavailable.metadata.timestamp).toBeUndefined();
      expect(propertyValue(unavailable.metadata, 'sfscanner:timestamp-unavailable')).toContain('SOURCE_DATE_EPOCH');
    } finally {
      if (environment !== undefined) process.env.SOURCE_DATE_EPOCH = environment;
    }
  });

  it('fails with a typed error naming the missing lockfile instead of emitting an empty document', () => {
    const root = fixture();
    writeJson(root, 'packages/demo/package.json', { name: 'demo-pkg', version: '0.0.0' });

    expect(() => build(root)).toThrow(ScannerSbomSourceError);
    expect(() => build(root)).toThrow(/missing package-lock\.json/u);
    expect(fs.readdirSync(root)).not.toContain('out');
  });

  it('rejects traversal and absolute checksum records', () => {
    const root = fixture();
    write(root, 'dist/main.js', 'bundle\n');
    write(root, 'bad.sha256', `${'a'.repeat(64)}  ../outside\n`);

    expect(verifyScannerChecksums({ artifactRoot: root, checksumFile: path.join(root, 'bad.sha256') })).toEqual({ ok: false, errors: ['checksum path is not a safe relative path: ../outside'] });
  });

  it('rejects absolute source-map paths and secret-like source content', () => {
    expect(() => validateScannerSourceMap({ sources: ['D:/work/src/main.ts'] })).toThrow(/absolute source-map path/u);
    expect(() => validateScannerSourceMap({ sources: ['../src/main.ts'], sourcesContent: ['TOKEN = "sk-proj-live-value"'] })).toThrow(/secret-like source-map content/u);
  });
});
