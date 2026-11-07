import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createAdvisoryCatalogueDigest } from '../../../scanner-core/src/advisories/advisory-admission';
import type { SnapshotPinV1 } from './supply-chain-snapshot';

export const capturedAt = '2026-10-24T00:00:00.000Z';
export const record = (overrides: Record<string, unknown> = {}) => ({
  id: 'ADV-1', aliases: ['ADV-1'], packageName: 'example-nodes', rawAffectedRange: '<1.2.3',
  affected: { clauses: [[{ op: 'LT', version: '1.2.3' }]] },
  fixedVersions: ['1.2.3'], fixedBranches: [], prerequisites: [], reviewState: 'ADMITTED',
  sourceUrl: 'https://example.test/advisories/ADV-1', sourceDigest: 'a'.repeat(64),
  reviewedAt: capturedAt, reviewer: 'synthetic-fixture', ...overrides,
});
export function fixture(records: readonly Record<string, unknown>[] = [record()], capture = capturedAt): { bytes: Uint8Array; pin: SnapshotPinV1 } {
  const catalogue = { schemaVersion: 'scanner-advisories-v2', version: '1.0.0', records };
  let digest = '0'.repeat(64);
  try { digest = createAdvisoryCatalogueDigest(catalogue); } catch { /* intentionally invalid vector */ }
  const bytes = new TextEncoder().encode(JSON.stringify({ ...catalogue, digest, sourceId: 'synthetic-source', capturedAt: capture }));
  return { bytes, pin: { sourceId: 'synthetic-source', url: 'https://example.test/snapshot.json', sha256: bytesToHex(sha256(bytes)), schemaVersion: 'scanner-advisories-v2', capturedAt: capture, maxAgeMs: 3_600_000 } };
}
