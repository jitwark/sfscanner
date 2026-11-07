"use client";

import dynamic from 'next/dynamic';
import { useState } from 'react';

const ScannerGuideContent = dynamic(
  () => import('../scanner/guide/scanner-guide-content').then((module) => module.ScannerGuideContent),
  { ssr: false },
);

export function ScannerGuide() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <section aria-labelledby="scanner-guide-heading" className="rounded-panel border border-hairline bg-panel p-4 sm:p-6">
      <h2 id="scanner-guide-heading" className="font-display text-lg font-semibold text-ink">
        Scanner methods and limits
      </h2>
      <p className="mt-1 text-sm text-ink-muted">Read how grades, checks, and local limits work.</p>
      <button type="button" aria-expanded={isOpen} aria-controls="scanner-guide-content" onClick={() => setIsOpen((open) => !open)}
        className="mt-4 min-h-11 rounded-control border border-hairline px-3 font-mono text-xs font-semibold text-ink transition-colors hover:border-accent-border hover:bg-accent-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border">
        {isOpen ? 'Hide scanner methods' : 'Read scanner methods'}
      </button>
      {isOpen ? <div id="scanner-guide-content" className="mt-6 flex flex-col gap-6"><ScannerGuideContent /></div> : null}
    </section>
  );
}
