import type { AnalyzerContextV2 } from '../../capabilities/scheduler';
import { toNativeWorkflow } from '../../capabilities/adapter-workflow';
import { analyzeWorkflowTaint } from './taint-analysis';
import type { TaintOutcomeV1 } from './scan-local-taint';

/** The legacy analyzer owns propagation; the scan-local accessor owns failure and memoization. */
export function produceScanLocalTaintV1(context: AnalyzerContextV2): TaintOutcomeV1 {
  const result = analyzeWorkflowTaint(toNativeWorkflow(context));
  const limited = result.propagation?.limitExceeded === true
    || result.diagnostics.some((diagnostic) => diagnostic.code === 'ANALYSIS_LIMIT_EXCEEDED');
  return { status: limited ? 'LIMITED' : 'COMPLETE', ...result };
}
