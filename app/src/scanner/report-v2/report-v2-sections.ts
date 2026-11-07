import { createElement, Fragment, type RefObject } from 'react';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { ReportApplicability } from './report-applicability';
import { ReportCoverage } from './report-coverage';
import { ReportEvidence } from './report-evidence';
import { ReportTrace } from './report-trace';

export type ReportV2SectionsProps = {
  model: ScannerReportModelV2;
  outcomeHeadingRef?: RefObject<HTMLHeadingElement | null>;
};

export function ReportV2Sections({ model, outcomeHeadingRef }: ReportV2SectionsProps) {
  return createElement(
    Fragment,
    null,
    createElement(ReportCoverage, { model, outcomeHeadingRef }),
    createElement(ReportEvidence, { model }),
    createElement(ReportApplicability, { model }),
    createElement(ReportTrace, { model }),
  );
}

