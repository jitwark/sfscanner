'use client';

import dynamic from 'next/dynamic';
import { TriangleAlert } from 'lucide-react';
import type { ScanWorkflowResult } from '../engine';
import { remediationActions } from './report-safe-content';
import { loadReportExportActions } from './report-export-actions-loader';

export { buildExportReport, buildSarifReport } from './report-export';

type ReportAnatomyProps = { scan: ScanWorkflowResult };

const ReportExportActions = dynamic(
  loadReportExportActions,
  {
    ssr: false,
    loading: () => <ReportExportLoading />,
  },
);

function ReportExportLoading() {
  return (
    <div
      role="status"
      aria-label="Preparing report export actions"
      aria-live="polite"
      aria-busy="true"
      className="mt-4 min-h-11 rounded-control border border-hairline bg-raised/30 px-3 py-3 font-mono text-xs text-ink-muted"
    >
      Preparing export actions…
    </div>
  );
}

export function ReportAnatomy({ scan }: ReportAnatomyProps) {
  const actions = remediationActions(scan);

  return <>
    <section className="rounded-panel border border-hairline bg-panel p-4 sm:p-5">
      <h2 className="font-display text-lg font-semibold text-ink">Remediation</h2>
      <p className="mt-2 text-sm text-ink-muted">Treat these as review steps, not proof that execution will be harmless.</p>
      {actions.length > 0 ? <ol className="mt-4 space-y-3">
        {actions.map((action, index) => <li key={action} className="flex items-start gap-3 text-sm leading-6 text-ink">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent-border/40 bg-accent-dim font-mono text-2xs font-bold text-accent-text" aria-hidden="true">{index + 1}</span>
          <span>{action}</span>
        </li>)}
      </ol> : <p className="mt-3 text-sm text-ink-muted">No automated remediation was returned. Review each node and credential boundary manually.</p>}
    </section>

    <section className="rounded-panel border border-hairline bg-panel p-4 sm:p-5">
      <h2 className="font-display text-lg font-semibold text-ink">Export or copy</h2>
      <div className="mt-2 flex items-start gap-2 text-sm text-ink-muted" role="note">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-sev-medium" aria-hidden="true" />
        <p>Exports contain the advisory scan result only. Both formats are built from the redacted report model.</p>
      </div>
      <ReportExportActions scan={scan} />
    </section>
  </>;
}
