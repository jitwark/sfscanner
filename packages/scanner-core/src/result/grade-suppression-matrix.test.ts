import { describe, expect, it } from 'vitest';
import { V2_PROJECTION_FIXTURE } from '../compat/__fixtures__/projection';
import { projectResultV2ToV1 } from '../compat/v1-projector';
import { V1_DIAGNOSTIC_CROSSWALK } from '../compat/v1-registry';
import { classifyDiagnostic, DIAGNOSTIC_CODES_V2, type DiagnosticCodeV2 } from '../diagnostics/registry';
import type { AnalysisDiagnosticCode } from '../policy/policy';
import { ANALYSIS_DIAGNOSTIC_COMPLETENESS, classifyAnalysisStatus } from './analysis-completeness';

/**
 * The grade-suppression contract as a matrix.
 *
 * `app/src/scanner/engine.ts` attaches `riskAssessment`/`humanSummary`/`summary` only when the
 * derived status is not INDETERMINATE, and the core v1 projection does the same. The
 * per-diagnostic classification in `result/analysis-completeness.ts` is therefore the single
 * input deciding whether a scan that could not analyse its subject still renders a grade — and a
 * grade on such a scan is a false assurance, not a low-risk verdict.
 *
 * These cases pin that contract per registered code and per capability requiredness, and assert
 * the suppression on the projected v1 result object itself.
 */
const GRADED_KEYS = ['riskAssessment', 'humanSummary', 'summary'] as const;

/**
 * The pre-existing `UNKNOWN_REPORT_ONLY_RULE` drift that used to be excluded here is resolved: the
 * v1 crosswalk claimed a fixed `INDETERMINATE` status while `DIAGNOSTIC_REGISTRY` emits a fixed
 * `DEGRADED`/eligible row for an unknown rule from an optional report-only capability, so the
 * projector's non-`VARIABLE` branch rejected the only aggregate effect the registry can produce and
 * the entire v2→v1 projection failed. The exempt set is now empty and the guard below still fails
 * if any *future* code stops projecting, so a new code cannot quietly skip this matrix.
 */
const NON_PROJECTABLE: readonly DiagnosticCodeV2[] = [];
const MATRIX_CODES = DIAGNOSTIC_CODES_V2.filter(
  (code) => !NON_PROJECTABLE.some((drifted) => drifted === code),
);

const diagnosticFor = (code: DiagnosticCodeV2, required: boolean) => ({
  id: 'c'.repeat(64),
  code,
  capabilityId: 'structural-policies',
  ...classifyDiagnostic(code, required),
});

/** The projector is a hostile-input parser that re-validates every field at run time, so the
 * matrix feeds it a run-time-built fixture; the compile-time v2 emission contract is extended
 * by the slice that first emits a v2 diagnostic of a given code. */
function projectWithDiagnostic(diagnostic: unknown) {
  const input = structuredClone(V2_PROJECTION_FIXTURE) as unknown as {
    analysis: { status: string; capabilities: readonly unknown[]; diagnostics: unknown[] };
  };
  input.analysis = { ...input.analysis, diagnostics: [diagnostic] };
  return projectResultV2ToV1(input as unknown as Parameters<typeof projectResultV2ToV1>[0]);
}

const gradedKeysOf = (result: Record<string, unknown>) => GRADED_KEYS.filter((key) => key in result);

const projectCode = (code: DiagnosticCodeV2, required: boolean) =>
  projectWithDiagnostic(diagnosticFor(code, required));

describe('grade suppression matrix', () => {
  it('suppresses the grade when a required stage fails', () => {
    const v1Code: AnalysisDiagnosticCode = 'REQUIRED_STAGE_FAILURE';
    expect(DIAGNOSTIC_CODES_V2).toContain(v1Code);
    expect(ANALYSIS_DIAGNOSTIC_COMPLETENESS[v1Code]).toBe('INDETERMINATE');
    // The shipped browser engine suppresses a grade whenever the status is INDETERMINATE, so
    // this classification alone is what stops a failed required stage from rendering a grade.
    expect(classifyAnalysisStatus([{ code: v1Code, category: 'POLICY' }])).toBe('INDETERMINATE');

    const projected = projectCode(v1Code, true);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result.analysisDiagnostics).toContainEqual({
      code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY',
    });
    expect(projected.result.analysisStatus).toBe('INDETERMINATE');
    expect(gradedKeysOf(projected.result as Record<string, unknown>)).toEqual([]);
  });

  it.each(MATRIX_CODES)('%s: graded exactly when nothing failed', (code) => {
    for (const required of [true, false]) {
      const classification = classifyDiagnostic(code, required);
      const projected = projectCode(code, required);
      expect(projected.ok).toBe(true);
      if (!projected.ok) continue;
      const graded = gradedKeysOf(projected.result as Record<string, unknown>);
      // Whole-object suppression: a half-graded result (riskAssessment without its summary)
      // fails here too, and the grade exists only alongside a non-indeterminate status.
      expect(graded).toEqual(
        projected.result.analysisStatus === 'DEGRADED' ? [...GRADED_KEYS] : [],
      );
      if (classification.aggregateEffect === 'INDETERMINATE') {
        expect(projected.result.analysisStatus).toBe('INDETERMINATE');
      }
    }
  });

  it('projects every registered code and exempts none', () => {
    const observed = DIAGNOSTIC_CODES_V2.filter((code) => !projectCode(code, true).ok);
    expect(observed).toEqual([...NON_PROJECTABLE]);
  });

  it('keeps the grade for non-required omissions', () => {
    const omissions = ['UNCLASSIFIED_CONNECTION_TYPE', 'OPTIONAL_LIMIT_EXCEEDED'] as const;
    for (const code of omissions) {
      const projected = projectCode(code, false);
      expect(projected.ok).toBe(true);
      if (!projected.ok) continue;
      expect(projected.result.analysisStatus).toBe('DEGRADED');
      expect(gradedKeysOf(projected.result as Record<string, unknown>)).toEqual([...GRADED_KEYS]);
    }
  });

  it('grades the same analyzer failure only while the analyzer stays optional', () => {
    const optional = projectCode('JAVASCRIPT_PARSE_FAILED', false);
    const required = projectCode('JAVASCRIPT_PARSE_FAILED', true);
    expect(optional.ok && required.ok).toBe(true);
    if (!optional.ok || !required.ok) return;
    expect(optional.result.analysisStatus).toBe('DEGRADED');
    expect(gradedKeysOf(optional.result as Record<string, unknown>)).toEqual([...GRADED_KEYS]);
    expect(required.result.analysisStatus).toBe('INDETERMINATE');
    expect(gradedKeysOf(required.result as Record<string, unknown>)).toEqual([]);
  });

  it('projects an unknown report-only rule as a degraded sentinel rather than failing', () => {
    const projected = projectCode('UNKNOWN_REPORT_ONLY_RULE', false);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    // v1 has no code for "an optional report-only capability's rule was unknown", so the
    // projection keeps the documented location-free `POLICY_EXECUTION_FAILED` sentinel and takes
    // its status from the registry row: `DEGRADED`. A report-only rule cannot contribute to the
    // score (the assessment excludes report-only findings), so its loss cannot move the graded
    // conclusion; the severity of the missing *reporting* is still visible as DEGRADED rather
    // than INDETERMINATE, which is reserved for a stage that may have hidden scored risk.
    expect(projected.result.analysisDiagnostics).toEqual([
      { code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' },
    ]);
    expect(projected.result.analysisStatus).toBe('DEGRADED');
    expect(gradedKeysOf(projected.result as Record<string, unknown>)).toEqual([...GRADED_KEYS]);
  });

  it('backs every v1 indeterminate classification with an indeterminate projection', () => {
    const indeterminateV1 = (Object.keys(ANALYSIS_DIAGNOSTIC_COMPLETENESS) as AnalysisDiagnosticCode[])
      .filter((code) => ANALYSIS_DIAGNOSTIC_COMPLETENESS[code] === 'INDETERMINATE');
    expect(indeterminateV1).toContain<AnalysisDiagnosticCode>('REQUIRED_STAGE_FAILURE');
    const unbacked = indeterminateV1.filter(
      (v1Code) => !V1_DIAGNOSTIC_CROSSWALK.some((row) => row.v1Code === v1Code && row.status === 'INDETERMINATE'),
    );
    expect(unbacked).toEqual([]);
  });
});
