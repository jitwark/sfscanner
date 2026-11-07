import type { StrictSemver } from '../semantics/semver';
import type { VersionRangeV2 } from '../semantics/version-range';

export type { StrictSemver, VersionRangeV2 };

export type AdvisoryPrerequisiteV2 = Readonly<{ key: string; expected: string }>;
export type AdvisoryCvssV2 = Readonly<{ version: '3.1' | '4.0'; publisher: string; vector: string }>;
export type AdvisoryReviewStateV2 = 'ADMITTED' | 'QUARANTINED' | 'WITHDRAWN' | 'REJECTED';

export type AdvisoryRecordV2 = Readonly<{
  id: string;
  aliases: readonly string[];
  packageName: string;
  rawAffectedRange: string;
  affected: VersionRangeV2;
  fixedVersions: readonly StrictSemver[];
  fixedBranches: readonly string[];
  prerequisites: readonly AdvisoryPrerequisiteV2[];
  cvss?: AdvisoryCvssV2;
  sourceUrl: string;
  sourceDigest: string;
  reviewedAt: string;
  reviewer: string;
  reviewState: AdvisoryReviewStateV2;
}>;

export type AdvisoryCatalogueInputV2 = Readonly<{
  schemaVersion: 'scanner-advisories-v2';
  version: string;
  records: readonly AdvisoryRecordV2[];
  digest: string;
}>;

export type AdvisoryCatalogueV2 = Readonly<{
  version: string;
  records: readonly AdvisoryRecordV2[];
  digest: string;
}>;
