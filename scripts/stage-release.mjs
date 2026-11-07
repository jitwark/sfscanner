/**
 * Stage one immutable release: the noindex site snapshot, the corpus it serves and the
 * published dataset, copied and hashed into `releases/<releaseId>/`, bound by the trusted
 * ledger, and optionally made the active release pointer.
 *
 * Every value in the release record is derived from an artifact and reconciled against
 * its neighbours; nothing is typed in. The command refuses to write inside the repository,
 * so `data/`, `app/public/data/` and `app/out` can only ever be read as inputs. It also
 * refuses to run at all without `--mode release`, which is what keeps the writer out of
 * the general gate sequence.
 *
 * Usage: node scripts/stage-release.mjs --mode release --root <release-root>
 *          [--site <dir>] [--data <dir>] [--export <dir>] [--snapshot <file>]
 *          [--activate] [--json]
 */
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSection, fail, inside, verifySection } from './lib/release-artifacts.mjs';
import { DEFAULT_INPUT_SNAPSHOT, assertWriterMode, defaultSources, readReleaseEnvironment } from './lib/release-descriptor.mjs';
import { deriveIdentity, releaseIdFrom, releaseRecord, sealIdentity } from './lib/release-identity.mjs';
import { ledgerEntry, nextSequence, previousRelease, readLedger, readPointer, releaseJsonSha256, writeLedger, writePointer } from './lib/release-ledger.mjs';
import { FIXTURE_MARKER_FILE, MARKER_FILE, readRootMarker, STAGED_SCHEMAS } from './lib/release-schemas.mjs';
import { inspectNoindex, stageSite, stageTree } from './lib/release-staging.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

/** Never the repository, and never a directory that contains it: those are production inputs. */
async function authorizedRoot(input) {
  if (typeof input !== 'string' || input.length === 0) fail('release root is required');
  const requested = path.resolve(input);
  const repository = await realpath(repoRoot);
  const candidate = await realpath(requested).catch(() => null);
  if (candidate && (inside(repository, candidate) || inside(candidate, repository))) {
    fail('repository and production paths are not valid release roots');
  }
  const root = candidate ?? requested;
  if (!candidate) fail(`release root does not exist: ${root}`);
  if (await readFile(path.join(root, FIXTURE_MARKER_FILE), 'utf8').catch(() => null) !== null) {
    fail('refusing to stage a release into a fixture root');
  }
  return root;
}

async function authorizeMarker(root) {
  const marker = await readRootMarker(root);
  if (marker === null) {
    await writeFile(path.join(root, MARKER_FILE), `${JSON.stringify({ schemaVersion: STAGED_SCHEMAS.marker, scope: STAGED_SCHEMAS.scope, writtenBy: 'scripts/stage-release.mjs' }, null, 2)}\n`, 'utf8');
    return STAGED_SCHEMAS;
  }
  if (marker.family !== 'staged') fail('release root is authorized for a different release family');
  return marker.schemas;
}

async function readLedgerIfPresent(root) {
  return readLedger(root, STAGED_SCHEMAS).catch((error) => {
    if (error instanceof Error && error.message.includes('is missing')) return { schemaVersion: STAGED_SCHEMAS.ledger, releases: [] };
    throw error;
  });
}

/**
 * `environment` is the test seam: production reads the tree, tools, input inventory and
 * optional-artifact declarations from the repository, while a drill injects the same
 * shape so it can stage without a clean git tree. The injected values are validated by
 * `deriveIdentity` exactly like the read ones, so a drill cannot stage a descriptor that
 * production could not.
 */
export async function stageRelease({ root: requested, site, data, export: exportSource, activate = false, mode, snapshotPath, environment }) {
  assertWriterMode(mode);
  const root = await authorizedRoot(requested);
  const schemas = await authorizeMarker(root);
  const defaults = defaultSources(repoRoot);
  const sources = {
    site: path.resolve(site ?? defaults.site),
    data: path.resolve(data ?? defaults.data),
    export: path.resolve(exportSource ?? defaults.export),
  };
  const resolvedSnapshot = snapshotPath === undefined ? path.join(repoRoot, DEFAULT_INPUT_SNAPSHOT) : path.resolve(snapshotPath);
  const env = environment ?? await readReleaseEnvironment(repoRoot, resolvedSnapshot);

  const staging = path.join(root, `.staging-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await stageSite(sources.site, path.join(staging, 'site'));
    await stageTree(sources.data, path.join(staging, 'data'));
    await stageTree(sources.export, path.join(staging, 'export'));
    const noindex = await inspectNoindex(path.join(staging, 'site'));
    if (noindex.missingMeta.length > 0 || !noindex.robotsIsDisallowAll) {
      fail(`the staged site is not noindex: ${String(noindex.missingMeta.length)} html file(s) without the directive`);
    }
    const sections = {
      site: await describeSection(path.join(staging, 'site'), schemas.artifact),
      data: await describeSection(path.join(staging, 'data'), schemas.artifact),
      export: await describeSection(path.join(staging, 'export'), schemas.artifact),
    };
    const identity = sealIdentity(await deriveIdentity({
      repoRoot,
      siteSource: sources.site,
      dataSource: sources.data,
      exportSource: sources.export,
      sections, noindex, tree: env.tree, tools: env.tools, inputs: env.inputs, optionalArtifacts: env.optionalArtifacts,
    }), {
      site: sections.site.sha256, data: sections.data.sha256, export: sections.export.sha256,
    });
    const releaseId = releaseIdFrom(identity);
    const ledger = await readLedgerIfPresent(root);
    const existing = ledger.releases.find((entry) => entry.releaseId === releaseId);
    const sequence = existing === undefined ? nextSequence(ledger) : existing.sequence;
    const record = releaseRecord({
      identity, releaseId, sequence, schemas, sections, previousRelease: previousRelease(ledger, sequence),
    });
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    const target = path.join(root, 'releases', releaseId);

    if (existing !== undefined) {
      const current = await readFile(path.join(target, 'release.json'), 'utf8').catch(() => null);
      if (current !== bytes.toString('utf8')) fail(`release ${releaseId} already exists with different bytes`);
      for (const name of Object.keys(sections)) await verifySection(target, name, record[name], schemas.artifact);
      await rm(staging, { recursive: true, force: true });
      if (activate) await writePointer(root, schemas, releaseId);
      return { releaseId, sequence, root, released: false, activated: activate, noindex, identity, record };
    }

    await mkdir(path.join(root, 'releases'), { recursive: true });
    await writeFile(path.join(staging, 'release.json'), bytes);
    await rename(staging, target);
    await writeLedger(root, schemas, [...ledger.releases, ledgerEntry({ releaseId, sequence, releaseJsonSha256: releaseJsonSha256(bytes), sectionHashes: identity.sections })]);
    if (activate) {
      const pointer = await readPointer(root, schemas).catch(() => null);
      if (pointer !== null) {
        const active = ledger.releases.find((entry) => entry.releaseId === pointer.releaseId);
        if (active !== undefined && active.sequence >= sequence) fail(`release ${releaseId} is not newer than the active release ${pointer.releaseId}`);
      }
      await writePointer(root, schemas, releaseId);
    }
    return { releaseId, sequence, root, released: true, activated: activate, noindex, identity, record };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

const USAGE = 'usage: stage-release --mode release --root <release-root> [--site <dir>] [--data <dir>] [--export <dir>] [--snapshot <file>] [--activate] [--json]';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--activate') { values.activate = true; continue; }
    if (flag === '--json') { values.json = true; continue; }
    if (flag === '--help' || flag === '-h') return null;
    if (!['--mode', '--root', '--site', '--data', '--export', '--snapshot'].includes(flag)) fail(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail(`${flag} requires a value`);
    values[flag.slice(2)] = value;
  }
  assertWriterMode(values.mode);
  if (!values.root) fail(USAGE);
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args) console.log(USAGE);
    else {
      const result = await stageRelease({
        root: args.root, site: args.site, data: args.data, export: args.export,
        snapshotPath: args.snapshot, activate: args.activate === true, mode: args.mode,
      });
      if (args.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`stage-release: ${result.released ? 'staged' : 'already staged'} release ${result.releaseId} (sequence ${String(result.sequence)}) in ${result.root}`);
        console.log(`  tree: ${result.identity.tree.commit} ${result.identity.tree.clean ? '(clean)' : '(dirty)'}; tools: node ${result.identity.tools.node}, npm ${result.identity.tools.npm}, lockfile ${result.identity.tools.lockfile.sha256.slice(0, 12)}`);
        console.log(`  input inventory: ${result.identity.inputs.path} ${result.identity.inputs.inventoryDigest} (${String(result.identity.inputs.fileCount)} bodies / ${String(result.identity.inputs.totalBytes)} bytes)`);
        console.log(`  sections: ${Object.entries(result.identity.sections).map(([name, hash]) => `${name}=${hash}`).join(' ')}`);
        console.log(`  artifacts: ${result.identity.artifacts.map((artifact) => `${artifact.name}(${artifact.provenance}, ${artifact.rightsScope}, ${String(artifact.artifactCount)} files, ${String(artifact.byteSize)} bytes)`).join(' ')}`);
        console.log(`  noindex: ${String(result.noindex.htmlFiles)} html files, robots.txt disallow-all ${String(result.noindex.robotsIsDisallowAll)}`);
        console.log(`  rollback unit: ${result.record.rollbackIdentity.unit}; previous release: ${result.record.rollbackIdentity.previousReleaseId ?? 'none'}`);
        console.log(`  active pointer: ${result.activated ? result.releaseId : 'unchanged'}`);
      }
    }
  } catch (error) {
    console.error(`stage-release refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
