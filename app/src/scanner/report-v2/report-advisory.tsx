import type { SafeFactV2 } from '@hub/contracts/scanner-v2-evidence';
import { ADVISORY_EVALUATION_STATES_V1 } from '@hub/contracts/scanner-v2-advisory';
import { safeReportText } from '../report/report-safe-content';

const STATES: Readonly<Record<string, string>> = {
  NOT_REQUESTED: 'Advisory checks were not requested.',
  NO_DECLARED_PACKAGES: 'No package versions were declared for the requested advisory check. This does not establish that no packages are installed.',
  UNAVAILABLE: 'Advisory data is unavailable. Package applicability has not been established.',
  REFUSED: 'The requested advisory check could not proceed. Package applicability has not been established.',
  PARTIAL: 'Advisory evaluation is partial. Unknown or omitted work prevents a complete conclusion.',
  COMPLETE: 'Advisory evaluation completed for the declared package versions. This does not establish runtime safety.',
};
const REASONS: Readonly<Record<string, string>> = {
  NO_ADMITTED_SNAPSHOT: 'No verified advisory data is available.',
  INVENTORY_UNVERIFIED: 'The installed package inventory has not been verified.',
  EVALUATED_AT_BEFORE_CAPTURE: 'The advisory evaluation time is invalid.',
  SNAPSHOT_STALE_AT_EVALUATION: 'The advisory data is too old for this check.',
  BOUNDS_INVALID: 'The advisory check limits could not be validated.',
  DECLARED: 'This exact package version is covered by the advisory data.',
  NO_COMPLETENESS_PROOF: 'Complete advisory coverage has not been established.',
  PACKAGE_NOT_IN_COVERAGE: 'This package version is outside the verified coverage.',
  VERSION_MISSING: 'An installed version was not supplied.',
  VERSION_INVALID: 'The installed version could not be interpreted.',
  SNAPSHOT_UNAVAILABLE: 'Advisory data is unavailable for this package version.',
  EVALUATION_REFUSED: 'The advisory check could not proceed.',
  IN_AFFECTED_RANGE: 'The declared version and known prerequisites match this advisory.',
  FIXED_VERSION_INSTALLED: 'The declared version is a listed fixed version.',
  OUTSIDE_AFFECTED_RANGE: 'The declared version is outside the affected range.',
  PREREQUISITE_MISMATCH: 'A known prerequisite excludes this target context.',
  TARGET_VERSION_UNKNOWN: 'The installed package version is unknown.',
  TARGET_PREREQUISITE_UNKNOWN: 'Required target context is unknown.',
  ADVISORY_NOT_ADMITTED: 'This advisory is not approved for an applicability conclusion.',
  INSTALLED_VERSION_INVALID: 'The installed package version could not be interpreted.',
  PACKAGE_LIMIT: 'Some package versions were omitted because the package limit was reached.',
  ROW_LIMIT: 'Some advisory records were omitted because the record limit was reached.',
  VERSION_UNKNOWN: 'Some advisory records could not be evaluated because installed versions are unknown.',
};

function reason(value: unknown): string {
  return typeof value === 'string' && Object.hasOwn(REASONS, value)
    ? REASONS[value] : 'The advisory check could not establish a complete applicability conclusion.';
}
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? safeReportText(value, 160) : fallback;
}
function count(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : 'Unknown';
}
function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => safeReportText(item, 100)) : [];
}
function state(value: unknown, allowed: readonly string[]): string {
  return typeof value === 'string' && allowed.includes(value) ? value : 'UNKNOWN';
}

/** Read only useful, explicitly selected fields, never identity receipts or extra properties. */
export function AdvisoryFactDetails({ fact }: { fact: SafeFactV2 }) {
  const p = fact.properties;
  if (fact.kind === 'advisory.evaluation.v1') {
    const evaluation = state(p.evaluationState, ADVISORY_EVALUATION_STATES_V1);
    const counts = [
      ['Package versions requested', p.packagesRequested], ['Package versions covered', p.packagesCovered],
      ['Package versions omitted', p.packageRowsOmitted], ['Advisory records examined', p.recordsExamined],
      ['Applicable records', p.recordsApplicable], ['Not applicable records', p.recordsNotApplicable], ['Unknown records', p.recordsUnknown],
    ] as const;
    return <div className="mt-2 space-y-2 text-sm leading-6 text-ink">
      <p className="font-semibold">Advisory status: {evaluation}</p>
      <p>{STATES[evaluation] ?? 'Advisory evaluation metadata is unavailable. Applicability remains UNKNOWN.'}</p>
      {p.evaluationReason !== 'NONE' && <p>{reason(p.evaluationReason)}</p>}
      <dl className="grid gap-2 sm:grid-cols-2">{counts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{count(value)}</dd></div>)}</dl>
      {names(p.omissionReasons).map((item) => <p key={item}>{reason(item)}</p>)}
    </div>;
  }
  if (fact.kind === 'advisory.package-coverage.v1') return <div className="mt-2 text-sm leading-6 text-ink">
    <p className="font-mono">{text(p.packageName, 'Unidentified package')} · {text(p.packageVersion, 'Version not supplied')}</p>
    <p>Package coverage: {state(p.coverageState, ['COVERED', 'UNKNOWN'])}</p>
    <p>{reason(p.coverageReason)}</p>
  </div>;
  if (fact.kind === 'advisory.applicability.v3') {
    const matched = names(p.matchedPrerequisites);
    const unknown = names(p.unknownPrerequisites);
    return <div className="mt-2 space-y-1 text-sm leading-6 text-ink">
      <p className="font-mono font-semibold">{text(p.advisoryId, 'Unidentified advisory')}</p>
      <p>{text(p.packageName, 'Unidentified package')} · {text(p.installedVersion, 'Version not supplied')}</p>
      <p>Advisory applicability: {state(p.applicability, ['APPLICABLE', 'NOT_APPLICABLE', 'UNKNOWN'])}</p>
      <p>{reason(p.rowReason)}</p>
      <p>Review: {state(p.reviewState, ['ADMITTED', 'WITHDRAWN', 'REJECTED'])}</p>
      <p>{matched.length} matched prerequisite{matched.length === 1 ? '' : 's'}{matched.length > 0 ? `: ${matched.join(', ')}` : ''}</p>
      <p>{unknown.length} unknown prerequisite{unknown.length === 1 ? '' : 's'}{unknown.length > 0 ? `: ${unknown.join(', ')}` : ''}</p>
    </div>;
  }
  return null;
}

export function ReportAdvisoryStatus({ facts }: { facts: readonly SafeFactV2[] }) {
  const evaluations = facts.filter((fact) => fact.kind === 'advisory.evaluation.v1');
  const coverage = facts.filter((fact) => fact.kind === 'advisory.package-coverage.v1');
  return <div className="mt-4">
    <h3 className="font-display text-base font-semibold text-ink">Advisory check</h3>
    {evaluations.length === 1 ? <AdvisoryFactDetails fact={evaluations[0]} />
      : <p className="mt-2 text-sm text-ink-muted">Advisory status: UNKNOWN. Evaluation metadata is unavailable; applicability has not been established.</p>}
    {coverage.length > 0 && <ul aria-label="Advisory package coverage" className="mt-3 space-y-2">
      {coverage.map((fact) => <li key={fact.factId} className="rounded-control border border-hairline p-3"><AdvisoryFactDetails fact={fact} /></li>)}
    </ul>}
  </div>;
}
