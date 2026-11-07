import { compareSemver, parseStrictSemver, type StrictSemver } from '../semantics/semver';
import { matchesVersionRange } from '../semantics/version-range';
import type { TargetContextV3 } from '../semantics/target-context';
import type { AdvisoryRecordV2 } from './advisory-schema';

type Applicability = 'APPLICABLE' | 'NOT_APPLICABLE' | 'UNKNOWN';
type PrerequisiteState = 'MISSING' | 'FAILED' | 'MATCHED';
export type AdvisoryApplicabilityEvaluationV1 = Readonly<{
  applicability: Applicability;
  reason: 'IN_AFFECTED_RANGE' | 'FIXED_VERSION_INSTALLED' | 'OUTSIDE_AFFECTED_RANGE' | 'PREREQUISITE_MISMATCH' | 'TARGET_VERSION_UNKNOWN' | 'TARGET_PREREQUISITE_UNKNOWN' | 'ADVISORY_NOT_ADMITTED' | 'INSTALLED_VERSION_INVALID';
  matchedPrerequisites: readonly string[];
  unknownPrerequisites: readonly string[];
}>;

function targetValue(key: string, target: TargetContextV3): string | undefined {
  if (key === 'n8nVersion') return target.n8nVersion;
  if (key === 'edition') return target.edition === 'UNKNOWN' ? undefined : target.edition;
  if (key === 'deployment') return target.deployment === 'UNKNOWN' ? undefined : target.deployment;
  if (key === 'role') return target.role === 'UNKNOWN' ? undefined : target.role;
  if (key === 'taskRunner') return target.taskRunner === 'UNKNOWN' ? undefined : target.taskRunner;
  if (key.startsWith('package:')) {
    const packageName = key.slice(8);
    const matches = target.communityPackages.filter((item) => item.name === packageName);
    return matches.length === 1 ? matches[0].version : undefined;
  }
  if (key.startsWith('configuration:')) {
    const configKey = key.slice(14);
    for (const item of target.configuration) if (item.key === configKey) return item.state === 'UNKNOWN' ? undefined : item.state;
    return undefined;
  }
  return undefined;
}

function packageVersion(advisory: AdvisoryRecordV2, target: TargetContextV3, installedVersion?: string): string | undefined {
  if (installedVersion !== undefined) return installedVersion;
  if (advisory.packageName === 'n8n') return target.n8nVersion;
  const matches = target.communityPackages.filter((item) => item.name === advisory.packageName);
  return matches.length === 1 ? matches[0].version : undefined;
}

function expectedValue(key: string, expected: string): string {
  if (key === 'edition' || key === 'deployment' || key === 'role' || key === 'taskRunner' || key.startsWith('configuration:')) return expected.toUpperCase();
  return expected;
}

function semverEquals(left: string, right: StrictSemver): boolean {
  try { return compareSemver(parseStrictSemver(left), right) === 0; } catch { return false; }
}

function prerequisitesMatch(prerequisites: readonly Readonly<{ key: string; expected: string }>[], target: TargetContextV3): boolean {
  for (const prerequisite of prerequisites) {
    const actual = targetValue(prerequisite.key, target);
    if (actual === undefined) return false;
    if (prerequisite.key === 'n8nVersion' || prerequisite.key.startsWith('package:')) {
      try { if (!semverEquals(actual, parseStrictSemver(expectedValue(prerequisite.key, prerequisite.expected)))) return false; } catch { return false; }
    } else if (actual !== expectedValue(prerequisite.key, prerequisite.expected)) return false;
  }
  return true;
}

function prerequisiteState(prerequisites: readonly Readonly<{ key: string; expected: string }>[], target: TargetContextV3): PrerequisiteState {
  for (const prerequisite of prerequisites) if (targetValue(prerequisite.key, target) === undefined) return 'MISSING';
  return prerequisitesMatch(prerequisites, target) ? 'MATCHED' : 'FAILED';
}

export function evaluateAdvisoryApplicability(advisory: AdvisoryRecordV2, target: TargetContextV3): Applicability {
  return evaluateAdvisoryApplicabilityDetail(advisory, target).applicability;
}

export function evaluateAdvisoryApplicabilityDetail(advisory: AdvisoryRecordV2, target: TargetContextV3, installedVersion?: string): AdvisoryApplicabilityEvaluationV1 {
  if (advisory.reviewState !== 'ADMITTED') return result('UNKNOWN', 'ADVISORY_NOT_ADMITTED', [], ['advisoryReviewState']);
  const versionText = packageVersion(advisory, target, installedVersion);
  if (versionText === undefined) return result('UNKNOWN', 'TARGET_VERSION_UNKNOWN', [], ['packageVersion']);
  let version: StrictSemver;
  try { version = parseStrictSemver(versionText); } catch { return result('UNKNOWN', 'INSTALLED_VERSION_INVALID', [], ['packageVersion']); }
  const missing = advisory.prerequisites.filter((item) => targetValue(item.key, target) === undefined).map((item) => item.key).sort();
  if (missing.length > 0) return result('UNKNOWN', 'TARGET_PREREQUISITE_UNKNOWN', [], missing);
  const matched = advisory.prerequisites.filter((item) => prerequisiteMatches(item, target)).map((item) => item.key).sort();
  for (const fixed of advisory.fixedVersions) {
    try { if (compareSemver(version, fixed) === 0) return result('NOT_APPLICABLE', 'FIXED_VERSION_INSTALLED', matched, []); } catch { return result('UNKNOWN', 'INSTALLED_VERSION_INVALID', [], ['packageVersion']); }
  }
  try { if (!matchesVersionRange(version, advisory.affected)) return result('NOT_APPLICABLE', 'OUTSIDE_AFFECTED_RANGE', matched, []); } catch { return result('UNKNOWN', 'INSTALLED_VERSION_INVALID', [], ['packageVersion']); }
  const state = prerequisiteState(advisory.prerequisites, target);
  if (state === 'MISSING') return result('UNKNOWN', 'TARGET_PREREQUISITE_UNKNOWN', [], missing);
  if (state === 'FAILED') return result('NOT_APPLICABLE', 'PREREQUISITE_MISMATCH', matched, []);
  return result('APPLICABLE', 'IN_AFFECTED_RANGE', matched, []);
}

function prerequisiteMatches(prerequisite: Readonly<{ key: string; expected: string }>, target: TargetContextV3): boolean {
  const actual = targetValue(prerequisite.key, target);
  if (actual === undefined) return false;
  if (prerequisite.key === 'n8nVersion' || prerequisite.key.startsWith('package:')) {
    try { return semverEquals(actual, parseStrictSemver(expectedValue(prerequisite.key, prerequisite.expected))); } catch { return false; }
  }
  return actual === expectedValue(prerequisite.key, prerequisite.expected);
}
function result(
  applicability: Applicability,
  reason: AdvisoryApplicabilityEvaluationV1['reason'],
  matchedPrerequisites: readonly string[],
  unknownPrerequisites: readonly string[],
): AdvisoryApplicabilityEvaluationV1 { return Object.freeze({ applicability, reason, matchedPrerequisites: Object.freeze([...matchedPrerequisites]), unknownPrerequisites: Object.freeze([...unknownPrerequisites]) }); }
