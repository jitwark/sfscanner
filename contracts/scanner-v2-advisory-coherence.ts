import { ADVISORY_APPLICABILITY_V3, ADVISORY_EVALUATION_V1, ADVISORY_PACKAGE_COVERAGE_V1, isAdvisoryFactKindV1 } from './scanner-v2-advisory';
import { readAdvisoryFactPropertiesV1 } from './scanner-v2-advisory-validation';
import type { TargetContextV3 } from './scanner-v2-result';

type Fact = Readonly<{ kind: string; properties: Readonly<Record<string, unknown>> }>;
const pair = (name: unknown, version: unknown): string => JSON.stringify([name, version]);
/** Run after closed fact validation and before a carrier is returned or projected. */
export function validateAdvisoryCoherenceV1(target: TargetContextV3, facts: readonly Fact[]): readonly string[] {
  const advisory = facts.filter((fact) => isAdvisoryFactKindV1(fact.kind));
  if (advisory.length === 0) return ['advisory facts require exactly one evaluation'];
  const errors: string[] = [];
  const evaluations = advisory.filter((fact) => fact.kind === ADVISORY_EVALUATION_V1);
  if (evaluations.length !== 1) return ['advisory facts require exactly one evaluation'];
  for (const fact of advisory) if (readAdvisoryFactPropertiesV1(fact.kind, fact.properties) === undefined) errors.push('advisory fact properties are invalid');
  if (errors.length) return errors;
  const p = evaluations[0].properties;
  if (p.targetDigest !== target.contextDigest) errors.push('advisory targetDigest disagrees with result target');
  const coverage = advisory.filter((fact) => fact.kind === ADVISORY_PACKAGE_COVERAGE_V1);
  const rows = advisory.filter((fact) => fact.kind === ADVISORY_APPLICABILITY_V3);
  const state = p.evaluationState;
  const requested = p.packagesRequested as number;
  const omitted = p.packageRowsOmitted as number;
  const covered = p.packagesCovered as number;
  const targetPairs = new Set(target.communityPackages.map(({ name, version }) => pair(name, version ?? null)));
  const coverageKeys = coverage.map((fact) => pair(fact.properties.packageName, fact.properties.packageVersion));
  const coverageSet = new Set(coverageKeys);
  if (coverageSet.size !== coverage.length) errors.push('advisory package coverage identities are invalid or duplicated');
  for (const key of coverageKeys) if (!targetPairs.has(key)) errors.push('advisory coverage pair is absent from target');
  const unrequested = state === 'NOT_REQUESTED' || state === 'NO_DECLARED_PACKAGES' || p.evaluationReason === 'INVENTORY_UNVERIFIED';
  if (!unrequested && requested !== targetPairs.size) errors.push('advisory requested count disagrees with declared target pairs');
  if (state === 'NO_DECLARED_PACKAGES' && targetPairs.size !== 0) errors.push('empty declared scope disagrees with target');
  if (coverage.length !== requested - omitted) errors.push('advisory coverage does not match visited scope');
  if (covered !== coverage.filter((fact) => fact.properties.coverageState === 'COVERED').length) errors.push('advisory covered count disagrees with coverage facts');
  const evaluated = state === 'PARTIAL' || state === 'COMPLETE';
  if (!evaluated && rows.length !== 0) errors.push('unevaluated advisory state invents applicability rows');
  for (const item of coverage) {
    const c = item.properties;
    if (!evaluated && (c.coverageState !== 'UNKNOWN'
      || c.coverageReason !== (state === 'UNAVAILABLE' ? 'SNAPSHOT_UNAVAILABLE' : 'EVALUATION_REFUSED'))) errors.push('unevaluated advisory state claims invalid package coverage');
    if (evaluated && (c.packageVersion === null ? c.coverageReason !== 'VERSION_MISSING' : c.coverageReason === 'VERSION_MISSING')) errors.push('advisory missing-version coverage is inconsistent');
    if (c.coverageState === 'COVERED' && p.coverageClaimed !== true) errors.push('advisory coverage lacks completeness proof');
    if (evaluated && !p.coverageClaimed && c.packageVersion !== null && c.coverageReason !== 'NO_COMPLETENESS_PROOF') errors.push('advisory package coverage lacks proof reason');
  }
  const rowKeys = new Set<string>();
  for (const row of rows) {
    const r = row.properties;
    if (!coverageSet.has(pair(r.packageName, r.installedVersion))) errors.push('advisory row is outside visited package scope');
    const key = JSON.stringify([r.packageName, r.installedVersion, r.advisoryId]);
    if (rowKeys.has(key)) errors.push('advisory row identity is duplicated');
    rowKeys.add(key);
  }
  for (const [counter, verdict] of [['recordsApplicable', 'APPLICABLE'], ['recordsNotApplicable', 'NOT_APPLICABLE'], ['recordsUnknown', 'UNKNOWN']]) {
    if (p[counter] !== rows.filter((row) => row.properties.applicability === verdict).length) errors.push(`advisory ${verdict} row count disagrees with facts`);
  }
  const missingRows = coverage.some((item) => item.properties.packageVersion === null);
  if ((p.omissionReasons as string[]).includes('VERSION_UNKNOWN') && !missingRows) errors.push('advisory version omission lacks missing-version coverage');
  return Object.freeze(errors);
}
