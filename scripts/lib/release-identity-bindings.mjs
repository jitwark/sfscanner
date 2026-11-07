/**
 * The non-artifact bindings a release identity must carry, and the checks that refuse an
 * identity assembled without them. Kept apart from `release-identity.mjs` because the
 * identity module is the only reader of these and it is already long enough: the split is
 * one direction (`release-identity` → here → `release-artifacts`), so there is no cycle
 * between the writer's derivation and its binding rules.
 */
import path from 'node:path';
import { fail, record } from './release-artifacts.mjs';

const COMMIT = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const INVENTORY_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/** A repo-relative source when the input lives in the release tree, else its own path. */
export function sourceLabel(repoRoot, directory) {
  const relative = path.relative(repoRoot, directory);
  const inRepository = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  return (inRepository ? relative : directory).replaceAll(path.sep, '/');
}

/**
 * One released family as the descriptor records it: where it came from, how it was
 * produced, the rights scope it ships under, the bytes it covers, and the rollback unit
 * that restores it. The per-file digests stay in the section itself, so this is the
 * summary an operator reads and the section is the evidence they can re-hash.
 */
export function artifactEntry({ name, provenance, rightsScope, source, section, rollbackUnit }) {
  const artifacts = Array.isArray(section?.artifacts) ? section.artifacts : null;
  if (artifacts === null || !DIGEST.test(String(section?.sha256))) fail(`the release identity needs a complete ${name} section`);
  return Object.freeze({
    name,
    source,
    provenance,
    rightsScope,
    rollbackUnit,
    artifactCount: artifacts.length,
    byteSize: artifacts.reduce((sum, artifact) => sum + artifact.byteSize, 0),
    sha256: section.sha256,
  });
}

/** The tree, toolchain and input bindings, or an explicit refusal naming the missing one. */
export function assertDescriptorBindings({ tree, tools, inputs, optionalArtifacts }) {
  if (!record(tree) || !COMMIT.test(String(tree.commit)) || typeof tree.clean !== 'boolean' || !Array.isArray(tree.dirtyFiles)) {
    fail('the release identity needs the staged tree\'s commit and dirty-tree declaration');
  }
  if (!record(tools) || typeof tools.node !== 'string' || typeof tools.npm !== 'string' ||
    !record(tools.lockfile) || !DIGEST.test(String(tools.lockfile.sha256)) || !Number.isSafeInteger(tools.lockfile.lockfileVersion)) {
    fail('the release identity needs the node, npm and lockfile tool identities');
  }
  if (!record(inputs) || !DIGEST.test(String(inputs.sha256)) || !INVENTORY_DIGEST.test(String(inputs.inventoryDigest)) ||
    !Number.isSafeInteger(inputs.fileCount) || !Number.isSafeInteger(inputs.totalBytes) || typeof inputs.path !== 'string') {
    fail('the release identity needs the frozen input inventory record');
  }
  if (!Array.isArray(optionalArtifacts) || optionalArtifacts.length === 0) fail('the release identity needs its optional-artifact declarations');
}
