import { createElement } from 'react';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { ReportApplicability } from './report-applicability';
import { ReportCoverage } from './report-coverage';
import { ReportEvidence } from './report-evidence';
import { ReportTrace } from './report-trace';

export type ReportV2SectionsProps = {
  model: ScannerReportModelV2;
};

export function ReportV2Sections({ model }: ReportV2SectionsProps) {
  return createElement(
    'details',
    { open: true, className: 'rounded-panel border border-hairline bg-panel p-4 sm:p-5' },
    createElement(
      'summary',
      { className: 'cursor-pointer font-display text-lg font-semibold text-ink focus-visible:outline focus-visible:ring-2 focus-visible:ring-accent-border' },
      'Technical evidence',
      createElement(
        'span',
        { className: 'mt-1 block font-sans text-sm font-normal leading-6 text-ink-muted' },
        'Coverage, canonical facts, applicability, and traces. The decision and priority actions above do not depend on reading this section first.',
      ),
    ),
    createElement(
      'div',
      { className: 'mt-4 flex flex-col gap-4' },
      createElement(ReportCoverage, { model }),
      createElement(ReportEvidence, { model }),
      createElement(ReportApplicability, { model }),
      createElement(ReportTrace, { model }),
    ),
  );
}

