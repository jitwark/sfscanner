import { DownloadVerificationError } from './download-verify';

/**
 * AUDIT-DL-001. `verifyRecordIdentity` is a SHAPE check — same `rawNodeCount`
 * and node-type set passes — so a workflow crafted to mimic an entry could be
 * downloaded under that entry's filename and licence notice. The release now
 * publishes the packed record's own SHA-256, and when it is present it is
 * authoritative: shape no longer substitutes for identity.
 *
 * Optional by design. A corpus packaged before the field existed still
 * downloads and falls back to the structural check, which is no weaker than it
 * was. Async and dynamically imported so the hash never enters first-load
 * bytes — the same pattern `search/artifact-integrity.ts` uses.
 */
export async function verifyContentHash(jsonText: string, expected: string | undefined): Promise<void> {
  if (!expected) return;
  const [{ sha256 }, { bytesToHex }] = await Promise.all([
    import('@noble/hashes/sha2.js'),
    import('@noble/hashes/utils.js'),
  ]);
  if (bytesToHex(sha256(new TextEncoder().encode(jsonText))) !== expected) {
    throw new DownloadVerificationError(
      'CONTENT_HASH_MISMATCH',
      'Downloaded record does not match the content hash this release published for the requested entry.',
    );
  }
}
