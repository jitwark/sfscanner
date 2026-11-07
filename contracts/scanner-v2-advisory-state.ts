type Properties = Readonly<Record<string, unknown>>;
export const ADVISORY_IDENTITY_KEYS_V1 = Object.freeze([
  'sourceId', 'pinDigest', 'coverageDigest', 'rightsReceiptDigest', 'provenanceReceiptDigest',
  'boundsDigest', 'admissionReceiptDigest', 'pinnedSnapshotSha256', 'snapshotSha256',
  'capturedAt', 'admittedAt', 'evaluatedAt', 'catalogueVersion', 'catalogueDigest',
]);
const ADMITTED = ['snapshotSha256', 'capturedAt', 'admittedAt', 'catalogueVersion', 'catalogueDigest'];
const PIN = ['sourceId', 'pinDigest', 'coverageDigest', 'rightsReceiptDigest', 'provenanceReceiptDigest', 'pinnedSnapshotSha256'];
const COUNTS = ['packagesRequested', 'packagesCovered', 'packageRowsOmitted', 'recordsExamined', 'recordsApplicable', 'recordsNotApplicable', 'recordsUnknown'];
/** Scalar/list shape is checked first by the fact reader. This checks the state matrix itself. */
export function validateAdvisoryStateV1(p: Properties): boolean {
  const numbers = COUNTS.map((key) => p[key]);
  if (!numbers.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return false;
  const [requested, covered, omitted, examined, applicable, notApplicable, unknown] = numbers as number[];
  const evaluated = applicable + notApplicable + unknown;
  if (!Number.isSafeInteger(evaluated) || evaluated > examined || omitted > requested || covered > requested - omitted) return false;
  if (!Array.isArray(p.omissionReasons) || typeof p.coverageClaimed !== 'boolean' || p.targetDigest === null) return false;
  const reasons = p.omissionReasons as string[];
  if (reasons.includes('PACKAGE_LIMIT') !== (omitted > 0)) return false;
  if (reasons.includes('ROW_LIMIT') && examined === evaluated || reasons.includes('VERSION_UNKNOWN') && examined === evaluated) return false;
  if ((reasons.includes('ROW_LIMIT') || reasons.includes('VERSION_UNKNOWN')) !== (examined > evaluated)) return false;
  if (p.snapshotSha256 !== null && p.snapshotSha256 !== p.pinnedSnapshotSha256) return false;
  if (p.sourceId === null ? PIN.some((key) => p[key] !== null) : PIN.some((key) => p[key] === null)) return false;
  if (p.snapshotSha256 !== null && (ADMITTED.some((key) => p[key] === null) || p.sourceId === null)) return false;
  if (p.snapshotSha256 === null && ADMITTED.some((key) => p[key] !== null)) return false;
  if (p.capturedAt !== null && p.admittedAt !== null && String(p.admittedAt) < String(p.capturedAt)) return false;
  if (p.evaluatedAt !== null && (p.admittedAt === null || String(p.evaluatedAt) < String(p.admittedAt))) return false;
  if (p.evaluationState === 'NOT_REQUESTED' || p.evaluationState === 'NO_DECLARED_PACKAGES') {
    return numbers.every((n) => n === 0) && !p.coverageClaimed && reasons.length === 0
      && ADVISORY_IDENTITY_KEYS_V1.every((key) => p[key] === null);
  }
  if (p.evaluationState === 'UNAVAILABLE') return requested > 0 && !p.coverageClaimed && covered === 0 && omitted === 0
    && examined === 0 && reasons.length === 0 && [...ADMITTED, 'evaluatedAt', 'admissionReceiptDigest'].every((key) => p[key] === null)
    && (p.sourceId !== null || p.boundsDigest === null);
  if (p.evaluationState === 'REFUSED') {
    if (p.coverageClaimed || p.evaluatedAt !== null || examined !== 0 || covered !== 0 || omitted !== 0 || reasons.length !== 0) return false;
    if (p.evaluationReason === 'INVENTORY_UNVERIFIED') return requested === 0 && ADVISORY_IDENTITY_KEYS_V1.every((key) => p[key] === null);
    if (p.evaluationReason === 'BOUNDS_INVALID') return p.boundsDigest === null && p.admissionReceiptDigest === null;
    return requested > 0 && p.snapshotSha256 !== null;
  }
  if (!['PARTIAL', 'COMPLETE'].includes(p.evaluationState as string) || requested === 0
    || ADVISORY_IDENTITY_KEYS_V1.some((key) => p[key] === null)) return false;
  const complete = p.coverageClaimed === true && requested === covered && omitted === 0 && examined === evaluated && unknown === 0 && reasons.length === 0;
  return p.evaluationState === 'COMPLETE' ? complete : !complete;
}
