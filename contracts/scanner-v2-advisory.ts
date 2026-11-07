export const ADVISORY_EVALUATION_V1 = 'advisory.evaluation.v1' as const;
export const ADVISORY_PACKAGE_COVERAGE_V1 = 'advisory.package-coverage.v1' as const;
export const ADVISORY_APPLICABILITY_V3 = 'advisory.applicability.v3' as const;

export const ADVISORY_FACT_KINDS_V1 = Object.freeze([
  ADVISORY_EVALUATION_V1,
  ADVISORY_PACKAGE_COVERAGE_V1,
  ADVISORY_APPLICABILITY_V3,
] as const);

export const ADVISORY_EVALUATION_PROPERTIES_V1 = Object.freeze([
  'evaluationState', 'evaluationReason', 'targetDigest', 'sourceId', 'pinDigest',
  'coverageDigest', 'rightsReceiptDigest', 'provenanceReceiptDigest', 'boundsDigest',
  'admissionReceiptDigest', 'pinnedSnapshotSha256', 'snapshotSha256', 'capturedAt',
  'admittedAt', 'evaluatedAt', 'catalogueVersion', 'catalogueDigest', 'coverageClaimed',
  'packagesRequested', 'packagesCovered', 'packageRowsOmitted', 'recordsExamined',
  'recordsApplicable', 'recordsNotApplicable', 'recordsUnknown', 'omissionReasons',
] as const);

export const ADVISORY_PACKAGE_COVERAGE_PROPERTIES_V1 = Object.freeze([
  'packageName', 'packageVersion', 'coverageState', 'coverageReason',
] as const);

export const ADVISORY_APPLICABILITY_PROPERTIES_V3 = Object.freeze([
  'advisoryId', 'packageName', 'installedVersion', 'reviewState', 'applicability',
  'rowReason', 'matchedPrerequisites', 'unknownPrerequisites',
] as const);

export const ADVISORY_EVALUATION_STATES_V1 = Object.freeze([
  'NOT_REQUESTED', 'NO_DECLARED_PACKAGES', 'UNAVAILABLE', 'REFUSED', 'PARTIAL', 'COMPLETE',
] as const);

export const ADVISORY_UNAVAILABLE_REASONS_V1 = Object.freeze([
  'NO_ADMITTED_SNAPSHOT', 'TRANSPORT_TIMEOUT', 'TRANSPORT_CANCELLED', 'TRANSPORT_FAILED',
  'HTTP_STATUS', 'REDIRECT_REFUSED', 'BODY_OVERSIZED', 'PIN_INVALID',
  'SNAPSHOT_DIGEST_MISMATCH', 'INVALID_UTF8', 'INVALID_JSON', 'DUPLICATE_KEY',
  'SNAPSHOT_SCHEMA_UNSUPPORTED', 'SOURCE_MISMATCH', 'CAPTURE_MISMATCH', 'SNAPSHOT_STALE',
  'SNAPSHOT_FUTURE', 'RECORD_LIMIT', 'DUPLICATE_ADVISORY', 'RECORD_INVALID',
  'CATALOGUE_ADMISSION_FAILED',
] as const);

export const ADVISORY_REFUSED_REASONS_V1 = Object.freeze([
  'INVENTORY_UNVERIFIED', 'EVALUATED_AT_BEFORE_CAPTURE', 'SNAPSHOT_STALE_AT_EVALUATION',
  'BOUNDS_INVALID',
] as const);

export const ADVISORY_COVERAGE_REASONS_V1 = Object.freeze([
  'DECLARED', 'NO_COMPLETENESS_PROOF', 'PACKAGE_NOT_IN_COVERAGE', 'VERSION_MISSING',
  'VERSION_INVALID', 'SNAPSHOT_UNAVAILABLE', 'INVENTORY_UNVERIFIED', 'EVALUATION_REFUSED',
] as const);

export const ADVISORY_ROW_REASONS_V1 = Object.freeze([
  'IN_AFFECTED_RANGE', 'FIXED_VERSION_INSTALLED', 'OUTSIDE_AFFECTED_RANGE',
  'PREREQUISITE_MISMATCH', 'TARGET_VERSION_UNKNOWN', 'TARGET_PREREQUISITE_UNKNOWN',
  'ADVISORY_NOT_ADMITTED', 'INSTALLED_VERSION_INVALID',
] as const);

export const ADVISORY_OMISSION_REASONS_V1 = Object.freeze([
  'PACKAGE_LIMIT', 'ROW_LIMIT', 'VERSION_UNKNOWN',
] as const);

export function isAdvisoryFactKindV1(value: unknown): boolean {
  return value === ADVISORY_EVALUATION_V1
    || value === ADVISORY_PACKAGE_COVERAGE_V1
    || value === ADVISORY_APPLICABILITY_V3;
}
