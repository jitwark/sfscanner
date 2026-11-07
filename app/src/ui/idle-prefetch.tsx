'use client';

import { useEffect } from 'react';

function shouldSkipPrefetch(): boolean {
  if (typeof navigator === 'undefined') return false;
  const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData) return true;
  if (conn?.effectiveType === 'slow-2g' || conn?.effectiveType === '2g') return true;
  return false;
}

function prefetchDocument(url: string): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`link[rel="prefetch"][href="${url}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.as = 'document';
  link.setAttribute('as', 'document');
  link.href = url;
  document.head.appendChild(link);
}

export function IdlePrefetch() {
  useEffect(() => {
    if (shouldSkipPrefetch()) return;

    const handleInteraction = (e: Event) => {
      const target = (e.target as Element | null)?.closest?.('a[href*="/w/"]');
      const href = target?.getAttribute('href');
      if (href) prefetchDocument(href);
    };

    document.addEventListener('mouseover', handleInteraction, { passive: true });
    document.addEventListener('touchstart', handleInteraction, { passive: true });

    return () => {
      document.removeEventListener('mouseover', handleInteraction);
      document.removeEventListener('touchstart', handleInteraction);
    };
  }, []);

  return null;
}
