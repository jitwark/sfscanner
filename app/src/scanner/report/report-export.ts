import type { ScanWorkflowResult } from '../engine';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { redactScanPresentation } from '@hub/scanner-core/presentation-redaction';

function attachedV2(scan: ScanWorkflowResult): ScannerReportModelV2 | undefined {
  const candidate = scan as unknown as Partial<ScannerReportModelV2>;
  return candidate.v2?.schemaVersion === 'scanner-result-v2' ? candidate as ScannerReportModelV2 : undefined;
}

/**
 * An attached v2 scan exports its real, worker-validated envelope. Serialising the
 * compatibility projection would report INDETERMINATE and invent
 * POLICY_EXECUTION_FAILED because no capability emits the v1 risk summary. v1
 * scans keep the projection payload they have always exported.
 */
export function buildExportReport(scan: ScanWorkflowResult): string {
  const model = attachedV2(scan);
  return JSON.stringify({
    notice: 'This local scanner report is advisory. Review the workflow before import.',
    report: redactScanPresentation(model ? model.v2 : scan),
  }, null, 2);
}

export { buildSarifReport } from './report-sarif';
