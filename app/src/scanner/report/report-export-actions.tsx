'use client';

import { useState } from 'react';
import { Check, Clipboard, Download } from 'lucide-react';
import type { ScanWorkflowResult } from '../engine';
import { buildExportReport, buildSarifReport } from './report-export';

type ReportExportActionsProps = { scan: ScanWorkflowResult };

const actionClass =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-control border border-hairline bg-raised px-3 font-mono text-xs font-semibold text-ink transition-all hover:border-accent-border hover:bg-accent-dim active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40';

export function ReportExportActions({ scan }: ReportExportActionsProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(buildExportReport(scan));
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }

  function downloadReport() {
    const blobUrl = URL.createObjectURL(new Blob([buildExportReport(scan)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = 'secureflow-scan-report.json';
    anchor.click();
    URL.revokeObjectURL(blobUrl);
  }

  function downloadSarif() {
    const blobUrl = URL.createObjectURL(new Blob([buildSarifReport(scan)], { type: 'application/sarif+json' }));
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = 'secureflow-scan-report.sarif';
    anchor.click();
    URL.revokeObjectURL(blobUrl);
  }

  return <>
    <div className="mt-4 flex flex-col gap-2 sm:flex-row">
      <button type="button" onClick={() => void copyReport()} className={actionClass}>
        {copyState === 'copied' ? <Check className="h-4 w-4 text-sev-low" aria-hidden="true" /> : <Clipboard className="h-4 w-4 text-accent-text" aria-hidden="true" />}
        <span>Copy redacted report</span>
      </button>
      <button type="button" onClick={downloadReport} className={actionClass}>
        <Download className="h-4 w-4 text-accent-text" aria-hidden="true" /><span>Download redacted JSON</span>
      </button>
      <button type="button" onClick={downloadSarif} className={actionClass}>
        <Download className="h-4 w-4 text-accent-text" aria-hidden="true" /><span>Download SARIF 2.1.0</span>
      </button>
    </div>
    <p className={`mt-2 min-h-5 font-mono text-xs ${copyState === 'error' ? 'text-sev-critical' : 'text-ink-muted'}`} aria-live="polite">
      {copyState === 'copied' ? 'Copied with redaction.' : copyState === 'error' ? 'Copy failed. Use Download redacted JSON instead.' : ''}
    </p>
  </>;
}
