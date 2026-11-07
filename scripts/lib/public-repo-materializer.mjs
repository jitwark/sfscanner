import fs from 'node:fs';
import path from 'node:path';
import { issue, sortIssues } from './public-repo-materializer-common.mjs';
import {
  copyManifestFiles,
  inspectDestination,
  removeCreatedDestination,
  validateSourceSnapshot,
} from './public-repo-materializer-safety.mjs';
import {
  manifestIsUsable,
  verifyPublicRepositoryMaterialization,
} from './public-repo-materializer-verifier.mjs';

export { verifyPublicRepositoryMaterialization };

export function materializePublicRepositoryFromManifest({ repositoryRoot, destinationRoot, manifest } = {}) {
  const destinationCheck = inspectDestination(repositoryRoot, destinationRoot);
  const destination = destinationCheck.path;
  const base = { ...manifest, destinationRoot: destination, materialized: false, verification: null };
  const finish = (extraIssues, verification = null, materialized = false) => {
    const issues = sortIssues([...(manifest?.issues ?? []), ...extraIssues]);
    return { ...base, issues, ok: issues.length === 0, materialized, verification };
  };

  if (!destinationCheck.ok) return finish(destinationCheck.issues);
  if (!manifestIsUsable(manifest)) {
    return finish([issue('invalid-manifest', '<manifest>', 'only a valid manifest may be materialized')]);
  }
  const sourceRoot = path.resolve(repositoryRoot ?? process.cwd());
  const sourceIssues = validateSourceSnapshot(sourceRoot, manifest);
  if (sourceIssues.length > 0) return finish(sourceIssues);

  try {
    fs.mkdirSync(destination);
    copyManifestFiles(sourceRoot, destination, manifest);
  } catch (error) {
    removeCreatedDestination(destination);
    return finish([issue('materialization-failed', destination, error instanceof Error ? error.message : 'copy failed')]);
  }
  const verification = verifyPublicRepositoryMaterialization({ destinationRoot: destination, manifest });
  if (!verification.ok) removeCreatedDestination(destination);
  return finish(verification.issues, verification, verification.ok);
}
