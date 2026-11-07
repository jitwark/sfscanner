import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Scanner artifacts that live under `data/` but are inputs to the release, not
 * outputs of the packager: the v2 advisory catalogue, its quarantine sibling, and
 * the v2 calibration corpus manifest. Their paths are mandated by
 * `openspec/changes/world-class-scanner-cli/implementation/phase-04-05.md` (WC-0405)
 * and `phase-10-12.md` (WC-1001), and `docs/scanner/` cites the calibration
 * manifest as the corpus source of truth.
 *
 * They have to be *declared*, because `data/manifest.json` is what owns `data/`:
 * `scripts/check-data-sync.mjs` derives the allowed path set from
 * `manifest.artifacts` alone, so any file mirrored into `app/public/data/` without
 * a record fails the gate as an extra. Exempting `scanner/` inside the gate was
 * tried (60a3d0f) and reverted (a35aa87): the owner's requirement is that the
 * release manifest owns these bytes, not that the gate looks away from them. The
 * difference that matters is that a declared artifact has its byte size and
 * sha256 recorded and compared, so it cannot drift unnoticed.
 *
 * Declared here rather than at each call site so every writer of the manifest —
 * `enrich-corpus`, and the `repackage-from-data` / `demote-source-rights` /
 * `repair-connection-counts` repair paths — owns them without having to remember.
 */
export const SCANNER_SIDECAR_PATHS: readonly string[] = [
  'scanner/advisories-v2.json',
  'scanner/advisory-quarantine-v1.json',
  'scanner/calibration-v2-manifest.json',
];
const VERSIONED_SIDECARS = ['scanner/preflight-prerequisites.ndjson'] as const;

/**
 * `required` — the default — is for a manifest that will be promoted into `data/`:
 * a declared sidecar that is not staged is a build failure, because the alternative
 * is a manifest that silently omits it and then *passes* `check:data-sync`
 * (`manifest.artifacts` is the only source of expected paths) while the release
 * ships without a mandatory artifact.
 *
 * `optional` is for a caller that is deliberately building a manifest somewhere
 * that is not a release tree, and has to say so by name.
 */
export type ScannerSidecarPolicy = 'required' | 'optional';

export type ScannerSidecarArtifact = {
  relativePath: string;
  absolutePath: string;
};

/**
 * The declared sidecars of `outputDir`, or a failure naming every one that is
 * missing when the caller needs a release manifest.
 */
export function scannerSidecarArtifacts(
  outputDir: string,
  policy: ScannerSidecarPolicy = 'required',
): ScannerSidecarArtifact[] {
  const artifacts: ScannerSidecarArtifact[] = [];
  const missing: string[] = [];
  for (const relativePath of SCANNER_SIDECAR_PATHS) {
    const absolutePath = path.join(outputDir, relativePath);
    if (fs.existsSync(absolutePath)) artifacts.push({ relativePath, absolutePath });
    else missing.push(relativePath);
  }
  // Optional in historical V3 trees; once present, every repackage manifest owns it.
  for (const relativePath of VERSIONED_SIDECARS) {
    const absolutePath = path.join(outputDir, relativePath);
    if (fs.existsSync(absolutePath)) artifacts.push({ relativePath, absolutePath });
  }
  if (missing.length > 0 && policy === 'required') {
    throw new Error(
      `Declared scanner sidecar missing from ${outputDir}: ${missing.join(', ')}. ` +
      'Stage them (stageScannerSidecars), or pass { scannerSidecars: \'optional\' } to build a manifest that is not a release manifest.',
    );
  }
  return artifacts;
}

/**
 * Copy the declared sidecars from a release data directory into a staging
 * directory.
 *
 * The repair paths rebuild a tree under `pipeline/.work` and promote it over
 * `data/` with `prepare-release-data.mjs --replace`, which moves the staging tree
 * wholesale. A staging tree without the sidecars therefore *deletes* them from the
 * release, and its manifest — which is the promoted one — has no record of them.
 * Staging them keeps the reparcelled tree a complete release tree, so the promoted
 * manifest owns them and the files survive.
 */
export function stageScannerSidecars(sourceDir: string, outputDir: string): string[] {
  const staged: string[] = [];
  const manifestPath = path.join(sourceDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { artifacts?: { path: string; sha256: string; byteSize: number }[] };
    for (const relativePath of VERSIONED_SIDECARS) {
      if (fs.existsSync(path.join(outputDir, relativePath))) continue;
      const owned = manifest.artifacts?.filter((artifact) => artifact.path === relativePath) ?? [];
      if (owned.length === 0 && fs.existsSync(path.join(sourceDir, relativePath))) {
        throw new Error('Unowned preflight sidecar; rerun corpus maintenance.');
      }
      if (owned.length > 1 || (owned.length === 1 && !fs.existsSync(path.join(sourceDir, relativePath)))) {
        throw new Error('Manifest-owned preflight sidecar missing; rerun corpus maintenance.');
      }
      if (owned.length === 1) {
        const bytes = fs.readFileSync(path.join(sourceDir, relativePath));
        if (bytes.length !== owned[0]!.byteSize || crypto.createHash('sha256').update(bytes).digest('hex') !== owned[0]!.sha256) {
          throw new Error('Manifest-owned preflight sidecar checksum mismatch; rerun corpus maintenance.');
        }
      }
    }
  }
  for (const { relativePath, absolutePath } of scannerSidecarArtifacts(sourceDir)) {
    const target = path.join(outputDir, relativePath);
    // A regeneration may already have derived fresh bytes for this versioned sidecar.
    if (VERSIONED_SIDECARS.some((name) => name === relativePath) && fs.existsSync(target)) continue;
    if (VERSIONED_SIDECARS.some((name) => name === relativePath) && !fs.existsSync(manifestPath)) {
      throw new Error('Preflight sidecar requires its owning manifest; rerun corpus maintenance.');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(absolutePath, target);
    staged.push(relativePath);
  }
  return staged;
}
