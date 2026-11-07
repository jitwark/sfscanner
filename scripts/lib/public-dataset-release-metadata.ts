/**
 * Turns loaded corpus entries plus loaded release identity into the two
 * shapes `buildPublicProjection` needs from its caller: the row counts it
 * cross-checks itself against (`assertComputedCounts`), and the
 * `PublicReleaseMetadata` object those counts live inside.
 */
import crypto from 'node:crypto';
import type { Entry } from '@hub/contracts';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION, type PublicReleaseCounts, type PublicReleaseMetadata } from '../../contracts/public-data-model.js';

/**
 * Mirrors `buildPublicProjection`'s own inclusion filter exactly
 * (`entry.rights.status !== 'excluded'`) — these numbers are pre-computed
 * so `assertComputedCounts` (`pipeline/export/public-projection.ts`) sees
 * the caller agree with the rows it is about to build, rather than
 * discovering a mismatch after the fact.
 */
export function computeReleaseCounts(entries: readonly Entry[]): PublicReleaseCounts {
  const included = entries.filter((entry) => entry.rights?.status !== 'excluded');
  const redistributable = included.filter((entry) => entry.rights?.status === 'redistributable').length;
  const linkOnly = included.filter((entry) => entry.rights?.status === 'link_only').length;
  const findings = included.reduce((sum, entry) => sum + (entry.security?.findings?.length ?? 0), 0);
  return { workflows: included.length, redistributable, linkOnly, excluded: entries.length - included.length, findings };
}

/**
 * A content hash of the scanner-core rule catalog, standing in for
 * `policyVersion`. `packages/scanner-core/src/policies/profile.ts` ties its
 * own `PolicyProfileEntry.version` to `SCANNER_VERSION` — the same string as
 * `scannerVersion` — but the public schema documents `policyVersion` as a
 * distinct "policy identity only" field
 * (`pipeline/export/public-data-dictionary.ts`), so aliasing it to the
 * scanner build would under-source it: the rule catalog can change severity,
 * add a rule, or change a CWE mapping without a scanner version bump.
 * Hashing the catalog's own content gives it an independent, still fully
 * deterministic identity.
 */
export function hashRuleCatalog(catalog: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
}

export type ReleaseMetadataInput = {
  releaseId: string;
  generatedAt: string;
  toolVersion: string;
  scannerVersion: string;
  policyVersion: string;
  searchIndexVersion: string;
  buildRevision: string;
  manifestSha256: string;
  corpusSha256: string;
  counts: PublicReleaseCounts;
};

export function buildReleaseMetadata(input: ReleaseMetadataInput): PublicReleaseMetadata {
  const { counts } = input;
  return {
    releaseId: input.releaseId,
    schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    toolVersion: input.toolVersion,
    scannerVersion: input.scannerVersion,
    policyVersion: input.policyVersion,
    searchIndexVersion: input.searchIndexVersion,
    buildRevision: input.buildRevision,
    manifestSha256: input.manifestSha256,
    corpusSha256: input.corpusSha256,
    counts,
    facetCounts: { rights: { redistributable: counts.redistributable, linkOnly: counts.linkOnly, excluded: counts.excluded } },
  };
}
