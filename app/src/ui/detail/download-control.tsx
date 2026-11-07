'use client';

import { useState } from 'react';
import type { Entry } from '@hub/contracts';
import { downloadWorkflow } from '../../catalogue/download';

type DownloadControlProps = { entry: Entry };

export function DownloadControl({ entry }: DownloadControlProps) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const downloading = progress !== null;

  async function handleDownload() {
    if (downloading) return;
    setError(null);
    setProgress(0);
    try {
      await downloadWorkflow(entry, undefined, (ratio) => setProgress(Math.round(ratio * 100)));
      setProgress(null);
    } catch (cause) {
      setProgress(null);
      setError(cause instanceof Error ? cause.message : 'Download failed.');
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        data-download-pack={entry.download?.pack}
        data-download-offset={entry.download?.offset}
        data-download-length={entry.download?.length}
        data-download-slug={entry.slug}
        onClick={handleDownload}
        disabled={downloading}
        aria-busy={downloading}
        className="inline-flex min-h-11 items-center rounded-control bg-accent px-4 font-mono text-sm font-semibold text-page hover:bg-accent/90 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-accent-border"
      >
        {downloading ? `Downloading ${progress}%` : 'Download workflow'}
      </button>
      {/* `data-download-status` is how the lean tier's behaviour script finds
          this region: that tier renders this control once and never runs React,
          so the announcement has to be writable from the markup. */}
      <span className="sr-only" aria-live="polite" data-download-status="">
        {downloading ? `Download progress ${progress}%` : error ?? ''}
      </span>
      <span className="max-w-56 text-right text-2xs leading-4 text-ink-muted">
        Includes the upstream licence notice.
      </span>
      {error && <span className="max-w-56 text-right text-xs text-sev-critical">{error}</span>}
    </div>
  );
}
