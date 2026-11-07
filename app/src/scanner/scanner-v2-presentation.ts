import type { ScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import { projectResultV2ToV1, type ProjectionResultV1, type V1ProjectionOptions } from '@hub/scanner-core/compat/v1-projector';
import { redactScanPresentation } from '@hub/scanner-core/presentation-redaction';
import type { ScanWorkflowResult } from './engine';

export type ScannerReportModelV2 = ScanWorkflowResult & Readonly<{
  v2: ScannerResultV2;
  limits: ScannerResultV2['limits'];
  assessment: ScannerResultV2['assessment'];
}>;

function projectionFallback(result: ScannerResultV2): ProjectionResultV1 {
  const { engine, profile, workflow } = result;
  return {
    schemaVersion: 'scanner-result-v1',
    scannerVersion: engine.version,
    policyProfile: profile.id,
    analysisStatus: 'INDETERMINATE',
    analysisDiagnostics: [{ code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' }],
    workflow: {
      name: workflow.name,
      nodeCount: workflow.nodeCount,
      rawNodeCount: workflow.rawNodeCount,
      annotationNodeCount: workflow.annotationNodeCount,
      triggerCount: workflow.triggerCount,
      actionCount: workflow.actionCount,
      integrationCount: workflow.integrationCount,
      connectionCount: workflow.edgeCount,
      payloadBytes: workflow.payloadBytes,
      complexity: workflow.complexity,
      isSubWorkflow: workflow.isSubWorkflow,
    },
    functionSummary: {
      basicPurpose: 'Unknown',
      triggerDescription: 'Unknown',
      dataFlowSummary: 'Unknown',
      businessCategory: 'Unknown',
      confidence: 'LOW',
    },
    integrations: [],
    findings: [],
  };
}

export function toScannerReportModelV2(result: ScannerResultV2, options: V1ProjectionOptions = {}): ScannerReportModelV2 {
  const projection = projectResultV2ToV1(result, options);
  const legacy = projection.ok ? projection.result : projectionFallback(result);
  const report = {
    ...legacy,
    v2: result,
    limits: result.limits,
    assessment: result.assessment,
  } as unknown as ScannerReportModelV2;
  return redactScanPresentation(report);
}
