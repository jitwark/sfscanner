import type { AnalysisDiagnostic, AnalysisDiagnosticCode, AnalysisStatus } from '../policy/policy';

/** Every diagnostic must be reviewed as either a degraded or required-stage omission. */
export const ANALYSIS_DIAGNOSTIC_COMPLETENESS: Record<
  AnalysisDiagnosticCode,
  'DEGRADED' | 'INDETERMINATE'
> = {
  ANALYSIS_LIMIT_EXCEEDED: 'DEGRADED',
  SOURCE_SPAN_UNAVAILABLE: 'DEGRADED',
  DUPLICATE_JSON_KEY: 'DEGRADED',
  MALFORMED_NODE_PARAMETERS: 'INDETERMINATE',
  UNSUPPORTED_CODE_NODE_VARIANT: 'DEGRADED',
  JAVASCRIPT_PARSE_FAILED: 'DEGRADED',
  JAVASCRIPT_SOURCE_UNAVAILABLE: 'DEGRADED',
  PYTHON_SOURCE_UNAVAILABLE: 'DEGRADED',
  PYTHON_PARSE_FAILED: 'DEGRADED',
  PYTHON_PARSER_UNAVAILABLE: 'DEGRADED',
  EXPRESSION_PARSE_FAILED: 'DEGRADED',
  POLICY_EXECUTION_FAILED: 'INDETERMINATE',
  GRAPH_ANALYSIS_DEGRADED: 'DEGRADED',
  DUPLICATE_FINDING_COLLAPSED: 'DEGRADED',
  UNCLASSIFIED_CONNECTION_TYPE: 'DEGRADED',
  // A malformed connection target index drops one edge from an otherwise-usable graph —
  // the same class of graph-structural omission as GRAPH_ANALYSIS_DEGRADED (e.g. an
  // unresolved connection target), so it is graded the same way rather than as
  // INDETERMINATE (reserved for cases like MALFORMED_NODE_PARAMETERS/
  // POLICY_EXECUTION_FAILED where a whole unit of analysis could not run at all).
  MALFORMED_CONNECTION_INDEX: 'DEGRADED',
  // A required stage that could not run at all leaves the result without the evidence that
  // stage exists to produce, so the grade is suppressed (INDETERMINATE) rather than reported
  // over a scan of unknown coverage — unlike the cosmetic omissions above.
  REQUIRED_STAGE_FAILURE: 'INDETERMINATE',
};

export function classifyAnalysisStatus(diagnostics: readonly AnalysisDiagnostic[]): AnalysisStatus {
  if (diagnostics.length === 0) return 'COMPLETE';
  return diagnostics.some(
    (diagnostic) => ANALYSIS_DIAGNOSTIC_COMPLETENESS[diagnostic.code] === 'INDETERMINATE',
  ) ? 'INDETERMINATE' : 'DEGRADED';
}

/**
 * Failure-vs-omission ladder — the frozen v1 engine LOGIC contract, declared once for every v1
 * surface (the browser engine and the pipeline CLI both call `asRequiredStageFailure`).
 *
 * These analyzer diagnostics state a *failure*, not a bounded omission: the analyzer that the
 * hardened profile configures to read a unit could not read it at all (unreadable source,
 * unparseable source, an unparseable expression, a code-node variant the scanner does not
 * analyse). The coverage claim rests on that stage, so its loss leaves the scan without the
 * evidence the stage exists to produce, and v1 has no per-diagnostic requiredness flag the way v2
 * does (`classifyDiagnostic` is fixed-row for this class, so the emitter chooses the code). Each
 * one is therefore emitted as the Slice-0 `REQUIRED_STAGE_FAILURE` code, which v1 grades
 * INDETERMINATE, so the grade is suppressed rather than reported over unknown coverage.
 *
 * Cosmetic omissions keep their own DEGRADED-class codes and stay graded: unavailable source
 * spans, duplicate JSON keys, unclassified connection labels, graph-shape omissions
 * (`GRAPH_ANALYSIS_DEGRADED`, `MALFORMED_CONNECTION_INDEX`) and analyzer caps
 * (`ANALYSIS_LIMIT_EXCEEDED`) are bounded losses the scan still scores.
 */
export const REQUIRED_STAGE_FAILURES: Readonly<Partial<Record<AnalysisDiagnosticCode, true>>> = {
  EXPRESSION_PARSE_FAILED: true,
  JAVASCRIPT_PARSE_FAILED: true,
  JAVASCRIPT_SOURCE_UNAVAILABLE: true,
  PYTHON_PARSER_UNAVAILABLE: true,
  PYTHON_PARSE_FAILED: true,
  PYTHON_SOURCE_UNAVAILABLE: true,
  UNSUPPORTED_CODE_NODE_VARIANT: true,
};

/** Emits the explicit failure code for a stage that could not read its unit, keeping where. */
export function asRequiredStageFailure(diagnostic: AnalysisDiagnostic): AnalysisDiagnostic {
  return REQUIRED_STAGE_FAILURES[diagnostic.code] === true
    ? { ...diagnostic, code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY' }
    : diagnostic;
}
