import type { Manifest } from '../catalogue/manifest';

export type ArtifactExpectation = { sha256: string; byteSize?: number };
export type ArtifactHashStatus = 'match' | 'mismatch';

/**
 * AUDIT-SEARCH-003. The single lookup every optional search artifact
 * (extended index, facets, semantic index) uses to find its manifest-bound
 * identity, mirroring the primary index's binding in
 * `searchReleaseIdentityFromManifest` (fetch-index.ts) without repeating it.
 *
 * Returns `undefined` — never throws — when `manifest` is absent (the caller
 * already tried and failed to load it) or simply has no entry for `path`.
 * Callers must treat that as "cannot verify this release" and accept a
 * schema-valid payload unverified: these three artifacts are optional, and a
 * verification gap must never hard-block them the way a primary-index
 * manifest failure does. That harder requirement is fetch-index.ts's
 * `fetchSearchIndexWithRelease`, not this function.
 */
export function expectedArtifact(manifest: Manifest | undefined, path: string): ArtifactExpectation | undefined {
  const artifact = manifest?.artifacts.find((candidate) => candidate.path === path);
  return artifact ? { sha256: artifact.sha256, byteSize: artifact.byteSize } : undefined;
}

/**
 * Hashes `text` with the already-shipped `@noble/hashes` build (same
 * dynamic-import pattern as `fetchSearchIndexWithRelease`, so the bytes are
 * only pulled in when a verification actually runs) and compares it against
 * `expected`.
 *
 * `byteSize` is checked first, against the UTF-8 encoded length we already
 * need for hashing — a cheap comparison that short-circuits an obviously
 * truncated or padded response before paying for the sha256 pass over a
 * multi-megabyte artifact.
 */
export async function verifyArtifactBytes(text: string, expected: ArtifactExpectation): Promise<ArtifactHashStatus> {
  const encoded = new TextEncoder().encode(text);
  if (expected.byteSize !== undefined && encoded.byteLength !== expected.byteSize) return 'mismatch';
  const [{ sha256 }, { bytesToHex }] = await Promise.all([
    import('@noble/hashes/sha2.js'),
    import('@noble/hashes/utils.js'),
  ]);
  return bytesToHex(sha256(encoded)) === expected.sha256 ? 'match' : 'mismatch';
}
