/**
 * Verify one staged release from a clean tree, and refuse it if any byte moved.
 *
 * Four independent readings have to agree, and a mismatch in any of them is a failure:
 *
 * 1. every released byte re-hashed from the release root against the release record and
 *    the trusted ledger;
 * 2. every section re-derived from the repository inputs the release was staged from —
 *    including the site, whose published form is the staged transform of `app/out`;
 * 3. the whole descriptor re-derived from the tree, tools and frozen input inventory, so
 *    a descriptor that names a different commit, toolchain or input snapshot than this
 *    checkout is refused even if every byte still matches;
 * 4. the section contents against the corpus manifest and the dataset bundle, so the set
 *    of bound bytes is the set those artifacts declare.
 *
 * The active-release pointer is read, never written: verification is a read-only act.
 *
 * Usage: node scripts/release-verify.mjs --root <release-root> [--release-id <id>]
 *          [--site <dir>] [--data <dir>] [--export <dir>] [--snapshot <file>] [--json]
 */
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredSections, describeSection, fail, inside, jsonFile, record, verifySection } from './lib/release-artifacts.mjs';
import { assertDataCoverage, assertExportCoverage, assertSiteCoverage } from './lib/release-coverage.mjs';
import { DEFAULT_INPUT_SNAPSHOT, defaultSources, readReleaseEnvironment } from './lib/release-descriptor.mjs';
import { deriveIdentity, releaseIdFrom, sealIdentity } from './lib/release-identity.mjs';
import { assertLedgerBinding, previousRelease, readLedger, readPointer, releaseJsonSha256 } from './lib/release-ledger.mjs';
import { LEDGER_FILE, MARKER_FILE, POINTER_FILE, readRootMarker, STAGED_SCHEMAS } from './lib/release-schemas.mjs';
import { inspectNoindex, snapshotSiteBytes } from './lib/release-staging.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

/** Canonical JSON, so two derivations of the same object compare equal whatever the key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

/** The first few paths at which two derivations disagree; the message is for a human at 3am. */
function differences(expected, actual, prefix = '', found = []) {
  if (found.length >= 5) return found;
  if (record(expected) && record(actual)) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      differences(expected[key], actual[key], prefix === '' ? key : `${prefix}.${key}`, found);
    }
    return found;
  }
  if (canonical(expected) !== canonical(actual)) found.push(`${prefix}: recorded ${JSON.stringify(expected) ?? 'undefined'}, this tree derives ${JSON.stringify(actual) ?? 'undefined'}`);
  return found;
}

async function authorizedRoot(input) {
  if (typeof input !== 'string' || input.length === 0) fail('release root is required');
  const requested = path.resolve(input);
  const repository = await realpath(repoRoot);
  const candidate = await realpath(requested).catch(() => null);
  if (!candidate) fail(`release root does not exist: ${requested}`);
  if (inside(repository, candidate) || inside(candidate, repository)) fail('repository and production paths are not valid release roots');
  const marker = await readRootMarker(candidate);
  if (marker === null || marker.family !== 'staged') fail('the release root is not authorized for a staged release');
  return candidate;
}

export async function verifyRelease({ root: requested, releaseId: requestedId, site, data, export: exportSource, snapshotPath, environment }) {
  const root = await authorizedRoot(requested);
  const schemas = STAGED_SCHEMAS;
  const ledger = await readLedger(root, schemas);
  const pointerExists = await lstat(path.join(root, POINTER_FILE)).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  const pointer = requestedId !== undefined && !pointerExists ? null : await readPointer(root, schemas);
  const releaseId = requestedId ?? pointer?.releaseId;
  const entry = ledger.releases.find((candidate) => candidate.releaseId === releaseId);
  if (entry === undefined) fail(`release ${releaseId} is not in ${LEDGER_FILE}`);
  const releaseRoot = path.join(root, 'releases', releaseId);
  const { value: releaseValue, bytes: releaseBytes } = await jsonFile(path.join(releaseRoot, 'release.json'), 'release record', true);
  if (!record(releaseValue) || releaseValue.schemaVersion !== schemas.release || releaseValue.artifactSchemaVersion !== schemas.artifact ||
    releaseValue.releaseId !== releaseId || releaseValue.sequence !== entry.sequence) {
    fail(`release ${releaseId} has an invalid or mismatched release record`);
  }

  const sections = {};
  for (const name of declaredSections(releaseValue, schemas.artifact)) sections[name] = releaseValue[name];
  const sectionHashes = Object.fromEntries(Object.entries(sections).map(([name, section]) => [name, section.sha256]));
  assertLedgerBinding(entry, releaseValue, sectionHashes, releaseJsonSha256(releaseBytes), releaseId);

  // 1. the released bytes, re-hashed from the release root.
  for (const [name, section] of Object.entries(sections)) await verifySection(releaseRoot, name, section, schemas.artifact);

  // 2. the sections, re-derived from the inputs the release claims it was staged from.
  const defaults = defaultSources(repoRoot);
  const sources = {
    site: path.resolve(site ?? defaults.site),
    data: path.resolve(data ?? defaults.data),
    export: path.resolve(exportSource ?? defaults.export),
  };
  const stagedSite = await inspectNoindex(path.join(releaseRoot, 'site'));
  if (stagedSite.missingMeta.length > 0 || !stagedSite.robotsIsDisallowAll ||
    stagedSite.htmlFiles !== releaseValue.identity.noindex.htmlFiles) {
    fail('the released site is not the verified noindex snapshot the descriptor records');
  }
  const derivedSite = await describeSection(sources.site, schemas.artifact, snapshotSiteBytes);
  if (derivedSite.sha256 !== sections.site.sha256) fail('the release site is not the staged snapshot of the current site input');
  const derivedData = await describeSection(sources.data, schemas.artifact);
  if (derivedData.sha256 !== sections.data.sha256) fail('the release corpus is not the current corpus input');
  const derivedExport = await describeSection(sources.export, schemas.artifact);
  if (derivedExport.sha256 !== sections.export.sha256) fail('the release dataset is not the current dataset input');

  // 3. the descriptor, re-derived from this clean tree, toolchain and input inventory.
  const resolvedSnapshot = snapshotPath === undefined ? path.join(repoRoot, DEFAULT_INPUT_SNAPSHOT) : path.resolve(snapshotPath);
  const env = environment ?? await readReleaseEnvironment(repoRoot, resolvedSnapshot);
  const identity = sealIdentity(await deriveIdentity({
    repoRoot,
    siteSource: sources.site,
    dataSource: sources.data,
    exportSource: sources.export,
    sections, noindex: releaseValue.identity.noindex,
    tree: env.tree, tools: env.tools, inputs: env.inputs, optionalArtifacts: env.optionalArtifacts,
  }), releaseValue.identity.sections);
  // `sealIdentity` hashes the section map as given, so the recorded map is reused: its
  // values were just re-proved from the bytes, and its key order is what the digest was
  // computed over. Re-sealing with a re-derived map would compare key order, not content.
  if (canonical(releaseValue.identity.sections) !== canonical(sectionHashes)) fail('the release identity does not bind the section hashes the release record carries');
  const mismatch = differences(releaseValue.identity, identity);
  if (mismatch.length > 0) fail(`the release descriptor does not describe this tree: ${mismatch.join('; ')}`);
  if (releaseIdFrom(identity) !== releaseId) fail(`the release ID does not derive from this tree's identity: ${releaseIdFrom(identity)}`);

  // 4. the contents, against what the corpus manifest and the dataset bundle declare.
  const coverage = {
    site: await assertSiteCoverage(sections.site, path.join(releaseRoot, 'site')),
    data: await assertDataCoverage(sections.data, path.join(releaseRoot, 'data')),
    export: await assertExportCoverage(sections.export, path.join(releaseRoot, 'export')),
  };

  const rollback = releaseValue.rollbackIdentity;
  const expectedPrevious = previousRelease(ledger, releaseValue.sequence);
  if (!record(rollback) || rollback.releaseId !== releaseId || rollback.sequence !== releaseValue.sequence ||
    canonical([...rollback.restore].sort()) !== canonical(Object.keys(sections).sort()) ||
    rollback.previousReleaseId !== (expectedPrevious?.releaseId ?? null) || rollback.previousSequence !== (expectedPrevious?.sequence ?? null)) {
    fail(`release ${releaseId} does not declare the rollback identity the ledger describes`);
  }
  if (pointer && !ledger.releases.some((candidate) => candidate.releaseId === pointer.releaseId)) fail('the active-release pointer names a release the ledger does not hold');

  return Object.freeze({
    status: 'verified',
    root,
    releaseId,
    sequence: releaseValue.sequence,
    commit: releaseValue.identity.tree.commit,
    tools: releaseValue.identity.tools,
    inputs: releaseValue.identity.inputs,
    sections: Object.freeze({ ...sectionHashes }),
    artifacts: releaseValue.identity.artifacts,
    rollbackIdentity: rollback,
    activeRelease: pointer?.releaseId ?? null,
    activeIsVerified: pointer?.releaseId === releaseId,
    coverage: Object.freeze(coverage),
  });
}

const USAGE = 'usage: release-verify --root <release-root> [--release-id <id>] [--site <dir>] [--data <dir>] [--export <dir>] [--snapshot <file>] [--json]';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') { values.json = true; continue; }
    if (flag === '--help' || flag === '-h') return null;
    if (!['--root', '--release-id', '--site', '--data', '--export', '--snapshot'].includes(flag)) fail(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail(`${flag} requires a value`);
    values[flag === '--release-id' ? 'releaseId' : flag.slice(2)] = value;
  }
  if (!values.root) fail(USAGE);
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args) console.log(USAGE);
    else {
      const result = await verifyRelease({
        root: args.root, releaseId: args.releaseId, site: args.site, data: args.data,
        export: args.export, snapshotPath: args.snapshot,
      });
      if (args.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`release-verify: verified ${result.releaseId} (sequence ${String(result.sequence)}) from ${result.root}`);
        console.log(`  tree: ${result.commit}; tools: node ${result.tools.node}, npm ${result.tools.npm}, lockfile ${result.tools.lockfile.sha256.slice(0, 12)}`);
        console.log(`  input inventory: ${result.inputs.inventoryDigest} (${String(result.inputs.fileCount)} bodies / ${String(result.inputs.totalBytes)} bytes)`);
        console.log(`  sections: ${Object.entries(result.sections).map(([name, hash]) => `${name}=${hash}`).join(' ')}`);
        console.log(`  artifacts: ${result.artifacts.map((artifact) => `${artifact.name}(${artifact.artifactCount} files, ${String(artifact.byteSize)} bytes, ${artifact.rightsScope})`).join(' ')}`);
        console.log(`  coverage: site ${String(result.coverage.site.htmlFiles)} page(s), data ${String(result.coverage.data.declaredFiles)} declared file(s), export ${String(result.coverage.export.declaredFiles)} declared file(s) / ${String(result.coverage.export.shards)} ndjson shard(s)`);
        console.log(`  rollback unit: ${result.rollbackIdentity.unit}; previous release: ${result.rollbackIdentity.previousReleaseId ?? 'none'}`);
        console.log(`  active pointer: ${result.activeRelease}${result.activeIsVerified ? ' (this release)' : ''}`);
      }
    }
  } catch (error) {
    console.error(`release-verify refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
