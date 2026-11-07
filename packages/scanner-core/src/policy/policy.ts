export type ScanSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type FindingConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type AnalysisStatus = 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE';

/**
 * The one declaration of the v1 analysis diagnostic vocabulary. This module is the single
 * authority for it: the completeness map, the projection ledger, the generated documentation and
 * the app-layer response validator all read these values, and each type is derived from its
 * value list so a code cannot exist as a type without existing as a value (and cannot be
 * emitted without appearing in the generated reference).
 */
export const ANALYSIS_DIAGNOSTIC_CODES = [
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
] as const;

export type AnalysisDiagnosticCode = (typeof ANALYSIS_DIAGNOSTIC_CODES)[number];

export const ANALYSIS_DIAGNOSTIC_CATEGORIES = [
  'LIMIT',
  'SOURCE',
  'PARSER',
  'POLICY',
  'GRAPH',
] as const;

export type AnalysisDiagnosticCategory = (typeof ANALYSIS_DIAGNOSTIC_CATEGORIES)[number];

/** Boundary guard for a diagnostic code crossing into the scanner from a host document. */
export function isAnalysisDiagnosticCodeValue(value: unknown): value is AnalysisDiagnosticCode {
  return (ANALYSIS_DIAGNOSTIC_CODES as readonly unknown[]).includes(value);
}

/** Boundary guard for a diagnostic category crossing into the scanner from a host document. */
export function isAnalysisDiagnosticCategoryValue(value: unknown): value is AnalysisDiagnosticCategory {
  return (ANALYSIS_DIAGNOSTIC_CATEGORIES as readonly unknown[]).includes(value);
}

export type SourcePosition = { line: number; column: number; offset: number };
export type SourceSpan = { start: SourcePosition; end: SourcePosition };

export type NormalizedWorkflowNode = {
  id: string;
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  sourcePath: string;
  sourceSpan?: SourceSpan;
};

export type NormalizedWorkflow = { nodes: NormalizedWorkflowNode[] };

export type AnalysisDiagnostic = {
  code: AnalysisDiagnosticCode;
  category: AnalysisDiagnosticCategory;
  location?: {
    nodeId?: string;
    nodeName?: string;
    path?: string;
    sourceSpan?: SourceSpan;
  };
};

export type ScanFinding = {
  policyId: string;
  title: string;
  severity: ScanSeverity;
  location: {
    nodeId?: string;
    nodeName?: string;
    path?: string;
    sourceSpan?: SourceSpan;
  };
  evidence: Record<string, unknown>;
  message: string;
  explanation: string;
  whyItMatters: string;
  possibleImpact: string;
  remediation: string;
  remediationSteps: string[];
  confidence: FindingConfidence;
};

export type PolicyEffect = 'LEGACY_SCORE' | 'REPORT_ONLY';
export type CanonicalScanFinding = ScanFinding & { policyEffect: PolicyEffect };

export type ScanPolicy = {
  id: string;
  name: string;
  description: string;
  evaluate: (workflow: NormalizedWorkflow) => ScanFinding[];
  /** Optional completeness diagnostics for outcomes the policy cannot decide. */
  diagnose?: (workflow: NormalizedWorkflow) => AnalysisDiagnostic[];
};

export type ScanSummary = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
};
