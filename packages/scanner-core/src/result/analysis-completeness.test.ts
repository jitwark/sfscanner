import { describe, expect, it } from 'vitest';
import type { AnalysisDiagnosticCode } from '../policy/policy';
import { ANALYSIS_DIAGNOSTIC_COMPLETENESS, classifyAnalysisStatus } from './analysis-completeness';

const diagnosticCodes: readonly AnalysisDiagnosticCode[] = [
  'ANALYSIS_LIMIT_EXCEEDED',
  'SOURCE_SPAN_UNAVAILABLE',
  'DUPLICATE_JSON_KEY',
  'MALFORMED_NODE_PARAMETERS',
  'UNSUPPORTED_CODE_NODE_VARIANT',
  'JAVASCRIPT_PARSE_FAILED',
  'JAVASCRIPT_SOURCE_UNAVAILABLE',
  'PYTHON_SOURCE_UNAVAILABLE',
  'PYTHON_PARSE_FAILED',
  'PYTHON_PARSER_UNAVAILABLE',
  'EXPRESSION_PARSE_FAILED',
  'POLICY_EXECUTION_FAILED',
  'GRAPH_ANALYSIS_DEGRADED',
  'DUPLICATE_FINDING_COLLAPSED',
  'UNCLASSIFIED_CONNECTION_TYPE',
  'MALFORMED_CONNECTION_INDEX',
  'REQUIRED_STAGE_FAILURE',
];

describe('ANALYSIS_DIAGNOSTIC_COMPLETENESS', () => {
  it('classifies every package diagnostic code', () => {
    expect(Object.keys(ANALYSIS_DIAGNOSTIC_COMPLETENESS).sort()).toEqual([...diagnosticCodes].sort());
    for (const code of diagnosticCodes) {
      expect(['DEGRADED', 'INDETERMINATE']).toContain(ANALYSIS_DIAGNOSTIC_COMPLETENESS[code]);
    }
  });
});

describe('classifyAnalysisStatus', () => {
  it('returns COMPLETE without diagnostics', () => {
    expect(classifyAnalysisStatus([])).toBe('COMPLETE');
  });

  it('returns DEGRADED when diagnostics are non-required', () => {
    expect(classifyAnalysisStatus([
      { code: 'SOURCE_SPAN_UNAVAILABLE', category: 'SOURCE' },
      { code: 'GRAPH_ANALYSIS_DEGRADED', category: 'GRAPH' },
    ])).toBe('DEGRADED');
  });

  it('returns DEGRADED (never COMPLETE) when a connection target index is malformed', () => {
    expect(classifyAnalysisStatus([
      { code: 'MALFORMED_CONNECTION_INDEX', category: 'GRAPH', location: { path: '/connections/Source/main/0/0/index' } },
    ])).toBe('DEGRADED');
  });

  it('returns INDETERMINATE when any required stage fails', () => {
    expect(classifyAnalysisStatus([
      { code: 'SOURCE_SPAN_UNAVAILABLE', category: 'SOURCE' },
      { code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' },
    ])).toBe('INDETERMINATE');
  });
});
