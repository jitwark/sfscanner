import type { NormalizedWorkflow } from '../workflow';
import type { AnalysisDiagnostic } from '../policy/policy';

export type AnalysisDiagnosticsInput = {
  workflow: NormalizedWorkflow;
  analyzerDiagnostics: readonly AnalysisDiagnostic[];
  spanUnresolvedCount: number;
  policyRejectedCount: number;
  policyFailedCount: number;
  findingCollapsedCount: number;
  scanCapExceeded: boolean;
};

/** Converts stage-level omissions into the versioned diagnostic vocabulary. */
export function collectAnalysisDiagnostics(input: AnalysisDiagnosticsInput): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [...input.analyzerDiagnostics];
  if (input.workflow.graph.diagnostics.length > 0) {
    diagnostics.push({ code: 'GRAPH_ANALYSIS_DEGRADED', category: 'GRAPH' });
  }
  if (input.workflow.graph.views.unknown.length > 0) {
    diagnostics.push({ code: 'UNCLASSIFIED_CONNECTION_TYPE', category: 'GRAPH' });
  }
  for (const diagnostic of input.workflow.graph.diagnostics) {
    if (diagnostic.code === 'MALFORMED_CONNECTION_INDEX') {
      diagnostics.push({ code: diagnostic.code, category: 'GRAPH', location: { path: diagnostic.pointer } });
    }
  }
  if (input.spanUnresolvedCount > 0) {
    diagnostics.push({ code: 'SOURCE_SPAN_UNAVAILABLE', category: 'SOURCE' });
  }
  if (input.workflow.parseDiagnostics.some(({ code }) => code === 'DUPLICATE_JSON_KEY')) {
    diagnostics.push({ code: 'DUPLICATE_JSON_KEY', category: 'SOURCE' });
  }
  for (const diagnostic of input.workflow.parseDiagnostics) {
    if (diagnostic.code === 'MALFORMED_NODE_PARAMETERS') {
      diagnostics.push({ code: diagnostic.code, category: 'SOURCE', location: { path: diagnostic.pointer } });
    }
  }
  if (input.policyRejectedCount > 0 || input.policyFailedCount > 0) {
    diagnostics.push({ code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' });
  }
  if (input.findingCollapsedCount > 0) {
    diagnostics.push({ code: 'DUPLICATE_FINDING_COLLAPSED', category: 'POLICY' });
  }
  if (input.scanCapExceeded) {
    diagnostics.push({ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' });
  }
  return diagnostics;
}
