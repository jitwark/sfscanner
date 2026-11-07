import { validateAdvisoryStateV1 } from './scanner-v2-advisory-state';
import { isAdvisoryFactKindV1 } from './scanner-v2-advisory';
import {
  ADVISORY_APPLICABILITY_V3, ADVISORY_COVERAGE_REASONS_V1, ADVISORY_EVALUATION_STATES_V1,
  ADVISORY_EVALUATION_V1, ADVISORY_OMISSION_REASONS_V1, ADVISORY_PACKAGE_COVERAGE_V1,
  ADVISORY_EVALUATION_PROPERTIES_V1, ADVISORY_PACKAGE_COVERAGE_PROPERTIES_V1, ADVISORY_APPLICABILITY_PROPERTIES_V3,
  ADVISORY_REFUSED_REASONS_V1, ADVISORY_ROW_REASONS_V1, ADVISORY_UNAVAILABLE_REASONS_V1,
} from './scanner-v2-advisory';
import { isStrictTargetSemver } from './scanner-target-v3';

type Value = string | number | boolean | null | readonly (string | number | boolean | null)[];
type Output = Record<string, Value>;
const HEX = /^[0-9a-f]{64}$/u;
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ADVISORY_ID = /^[A-Z0-9][A-Z0-9._:-]*$/u;
const PACKAGE = /^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/u;
const PREREQUISITE = /^(?:edition|deployment|role|taskRunner|n8nVersion|package:(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)|configuration:[A-Za-z0-9._-]+)$/u;
const SPECIAL_UNKNOWN = new Set(['packageVersion', 'advisoryReviewState']);
const STATES = new Set<string>(ADVISORY_EVALUATION_STATES_V1);
const UNAVAILABLE = new Set<string>(ADVISORY_UNAVAILABLE_REASONS_V1);
const REFUSED = new Set<string>(ADVISORY_REFUSED_REASONS_V1);
const COVERAGE = new Set<string>(ADVISORY_COVERAGE_REASONS_V1);
const ROW = new Set<string>(ADVISORY_ROW_REASONS_V1);
const OMISSION = new Set<string>(ADVISORY_OMISSION_REASONS_V1);

function fail(): never { throw 'INVALID_PROPERTY'; }
function value(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !('value' in descriptor)) return fail();
  return descriptor.value;
}
function text(input: unknown): string { if (typeof input !== 'string' || input.length > 4096 || /[\u0000-\u001f\u007f]/u.test(input)) return fail(); return input; }
function enumText(input: unknown, values: ReadonlySet<string>): string { const item = text(input); if (!values.has(item)) fail(); return item; }
function integer(input: unknown): number { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) fail(); return input; }
function boolean(input: unknown): boolean { if (typeof input !== 'boolean') fail(); return input; }
function digest(input: unknown): string | null { if (input === null) return null; const item = text(input); if (!HEX.test(item)) fail(); return item; }
function timestamp(input: unknown): string | null {
  if (input === null) return null;
  const item = text(input);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(item)) fail();
  const parsed = Date.parse(item);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== item) fail();
  return item;
}
function packageName(input: unknown): string { const item = text(input); if (new TextEncoder().encode(item).byteLength > 214 || !PACKAGE.test(item)) fail(); return item; }
function semver(input: unknown, nullable: boolean): string | null {
  if (input === null && nullable) return null;
  const item = text(input);
  if (!isStrictTargetSemver(item)) return fail();
  return item;
}
function canonicalId(input: unknown): string { const item = text(input); if (new TextEncoder().encode(item).byteLength > 255 || !ADVISORY_ID.test(item)) fail(); return item; }
function compare(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1; }
function stringList(input: unknown, allowed?: (item: string) => boolean): readonly string[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > 1_000 || Object.getOwnPropertyNames(input).length !== input.length + 1 || Object.getOwnPropertySymbols(input).length !== 0) fail();
  const output: string[] = [];
  for (let index = 0; index < input.length; index += 1) { const item = text(value(input, String(index))); if (allowed && !allowed(item)) fail(); output.push(item); }
  if (output.some((item, index) => index > 0 && compare(output[index - 1]!, item) >= 0)) fail();
  return output;
}
function prerequisite(item: string): boolean { return PREREQUISITE.test(item) || SPECIAL_UNKNOWN.has(item); }

function evaluation(input: object): Output {
  const state = enumText(value(input, 'evaluationState'), STATES);
  const rawReason = value(input, 'evaluationReason');
  const reason = rawReason === null ? null : text(rawReason);
  if (reason !== null && reason !== 'NONE' && !UNAVAILABLE.has(reason) && !REFUSED.has(reason)) fail();
  if (state === 'NOT_REQUESTED' || state === 'NO_DECLARED_PACKAGES' || state === 'COMPLETE' || state === 'PARTIAL') { if (reason !== 'NONE') fail(); }
  else if (state === 'UNAVAILABLE') { if (reason === null || !UNAVAILABLE.has(reason)) fail(); }
  else if (reason === null || !REFUSED.has(reason)) fail();
  const sourceId = value(input, 'sourceId');
  if (sourceId !== null && !SOURCE_ID.test(text(sourceId))) fail();
  const reasons = stringList(value(input, 'omissionReasons'), (item) => OMISSION.has(item));
  return {
    evaluationState: state, evaluationReason: reason, targetDigest: digest(value(input, 'targetDigest')),
    sourceId: sourceId === null ? null : text(sourceId), pinDigest: digest(value(input, 'pinDigest')), coverageDigest: digest(value(input, 'coverageDigest')),
    rightsReceiptDigest: digest(value(input, 'rightsReceiptDigest')), provenanceReceiptDigest: digest(value(input, 'provenanceReceiptDigest')),
    boundsDigest: digest(value(input, 'boundsDigest')), admissionReceiptDigest: digest(value(input, 'admissionReceiptDigest')),
    pinnedSnapshotSha256: digest(value(input, 'pinnedSnapshotSha256')), snapshotSha256: digest(value(input, 'snapshotSha256')),
    capturedAt: timestamp(value(input, 'capturedAt')), admittedAt: timestamp(value(input, 'admittedAt')),
    evaluatedAt: timestamp(value(input, 'evaluatedAt')), catalogueVersion: semver(value(input, 'catalogueVersion'), true),
    catalogueDigest: digest(value(input, 'catalogueDigest')), coverageClaimed: boolean(value(input, 'coverageClaimed')),
    packagesRequested: integer(value(input, 'packagesRequested')), packagesCovered: integer(value(input, 'packagesCovered')),
    packageRowsOmitted: integer(value(input, 'packageRowsOmitted')), recordsExamined: integer(value(input, 'recordsExamined')),
    recordsApplicable: integer(value(input, 'recordsApplicable')), recordsNotApplicable: integer(value(input, 'recordsNotApplicable')),
    recordsUnknown: integer(value(input, 'recordsUnknown')), omissionReasons: reasons,
  };
}

function coverage(input: object): Output {
  const state = text(value(input, 'coverageState'));
  const reason = enumText(value(input, 'coverageReason'), COVERAGE);
  if (!['COVERED', 'UNKNOWN'].includes(state) || (state === 'COVERED') !== (reason === 'DECLARED')) fail();
  if (state === 'COVERED' && value(input, 'packageVersion') === null) fail();
  return { packageName: packageName(value(input, 'packageName')), packageVersion: semver(value(input, 'packageVersion'), true), coverageState: state, coverageReason: reason };
}

function applicability(input: object): Output {
  const applicabilityValue = text(value(input, 'applicability'));
  const reason = enumText(value(input, 'rowReason'), ROW);
  if (!['APPLICABLE', 'NOT_APPLICABLE', 'UNKNOWN'].includes(applicabilityValue)) fail();
  if (applicabilityValue === 'APPLICABLE' && reason !== 'IN_AFFECTED_RANGE'
    || applicabilityValue === 'NOT_APPLICABLE' && !['FIXED_VERSION_INSTALLED', 'OUTSIDE_AFFECTED_RANGE', 'PREREQUISITE_MISMATCH'].includes(reason)
    || applicabilityValue === 'UNKNOWN' && !['TARGET_VERSION_UNKNOWN', 'TARGET_PREREQUISITE_UNKNOWN', 'ADVISORY_NOT_ADMITTED', 'INSTALLED_VERSION_INVALID'].includes(reason)) fail();
  const unknown = stringList(value(input, 'unknownPrerequisites'), prerequisite);
  if (applicabilityValue === 'UNKNOWN' ? unknown.length === 0 : unknown.length !== 0) fail();
  if (reason === 'ADVISORY_NOT_ADMITTED' && (unknown.length !== 1 || unknown[0] !== 'advisoryReviewState')
    || (reason === 'TARGET_VERSION_UNKNOWN' || reason === 'INSTALLED_VERSION_INVALID') && (unknown.length !== 1 || unknown[0] !== 'packageVersion')
    || reason === 'TARGET_PREREQUISITE_UNKNOWN' && unknown.some((key) => SPECIAL_UNKNOWN.has(key))) fail();
  const review = enumText(value(input, 'reviewState'), new Set(['ADMITTED', 'WITHDRAWN', 'REJECTED']));
  if (review !== 'ADMITTED' && (applicabilityValue !== 'UNKNOWN' || reason !== 'ADVISORY_NOT_ADMITTED')) fail();
  if (applicabilityValue !== 'UNKNOWN' && value(input, 'installedVersion') === null) fail();
  return {
    advisoryId: canonicalId(value(input, 'advisoryId')), packageName: packageName(value(input, 'packageName')),
    installedVersion: semver(value(input, 'installedVersion'), true), reviewState: review,
    applicability: applicabilityValue, rowReason: reason,
    matchedPrerequisites: stringList(value(input, 'matchedPrerequisites'), (item) => PREREQUISITE.test(item)),
    unknownPrerequisites: unknown,
  };
}

export function readAdvisoryFactPropertiesV1(kind: string, input: object): Output | undefined {
  if (!isAdvisoryFactKindV1(kind)) return undefined;
  try {
    const keys = kind === ADVISORY_EVALUATION_V1 ? ADVISORY_EVALUATION_PROPERTIES_V1
      : kind === ADVISORY_PACKAGE_COVERAGE_V1 ? ADVISORY_PACKAGE_COVERAGE_PROPERTIES_V1 : ADVISORY_APPLICABILITY_PROPERTIES_V3;
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length
      || Object.getOwnPropertyNames(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) return undefined;
    if (kind === ADVISORY_EVALUATION_V1) { const output = evaluation(input); return validateAdvisoryStateV1(output) ? output : undefined; }
    if (kind === ADVISORY_PACKAGE_COVERAGE_V1) return coverage(input);
    if (kind === ADVISORY_APPLICABILITY_V3) return applicability(input);
    return undefined;
  } catch { return undefined; }
}
