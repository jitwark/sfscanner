import { useEffect, type RefObject } from 'react';
import type { ScanWorkflowResult } from '../engine';
import type { ReportPrerequisitesModel } from '../prerequisite-sidecar';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { ReportV2Sections } from '../report-v2/report-v2-sections';
import { ReportAnatomy } from './report-anatomy';
import { ReportDecision } from './report-decision';
import { ReportFindings } from './report-findings';
import { ReportIntegrations } from './report-integrations';
import { ReportSummary } from './report-summary';
import { ReportPrerequisites } from './report-prerequisites';

export type ReportResultProps = {
  scan: ScanWorkflowResult;
  prerequisites?: ReportPrerequisitesModel;
  outcomeHeadingRef: RefObject<HTMLHeadingElement | null>;
  onRetry: () => void;
};

export type { ReportPrerequisitesModel, ReportPrerequisiteEvidence } from '../prerequisite-sidecar';

function v2Model(scan: ScanWorkflowResult) {
  try {
    const candidate = scan as unknown as Partial<ScannerReportModelV2>;
    const v2 = candidate.v2;
    if (v2?.schemaVersion !== 'scanner-result-v2'
      || candidate.assessment === undefined
      || !v2.analysis
      || !Array.isArray(v2.analysis.capabilities)
      || !Array.isArray(v2.analysis.diagnostics)
      || !v2.target
      || !v2.limits
      || !Array.isArray(v2.limits.usage)
      || !Array.isArray(v2.facts)
      || !Array.isArray(v2.traces)
      || !Array.isArray(v2.findings)
      || !v2.stats) {
      return undefined;
    }
    return candidate as ScannerReportModelV2;
  } catch {
    return undefined;
  }
}

export function ReportResult({ scan, prerequisites, outcomeHeadingRef, onRetry }: ReportResultProps) {
  useEffect(() => {
    outcomeHeadingRef.current?.focus();
  }, [outcomeHeadingRef, scan]);

  const model = v2Model(scan);

  return (
    <div className="flex flex-col gap-6">
      {model ? <>
        <ReportDecision scan={scan} outcomeHeadingRef={outcomeHeadingRef} />
        <ReportFindings scan={scan} />
        <ReportAnatomy scan={scan} />
        {prerequisites ? <ReportPrerequisites model={prerequisites} /> : null}
        <ReportV2Sections model={model} />
      </> : <>
        <ReportSummary scan={scan} outcomeHeadingRef={outcomeHeadingRef} onRetry={onRetry} />
        {prerequisites ? <ReportPrerequisites model={prerequisites} /> : null}
        <ReportDecision scan={scan} />
        <ReportFindings scan={scan} />
        <ReportIntegrations scan={scan} />
        <ReportAnatomy scan={scan} />
      </>}
    </div>
  );
}
