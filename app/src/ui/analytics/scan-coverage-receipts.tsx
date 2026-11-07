import React from 'react';

/**
 * Renders a cryptographic digest with clean selectable styling.
 * Keeps the full hash in the DOM as a single element for exact text matching in tests.
 */
export function DigestItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded border border-hairline/60 bg-raised/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <dt className="font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
        <span className="font-mono text-3xs text-ink-faint">SHA-256</span>
      </div>
      <dd className="break-all font-mono text-xs text-ink-muted select-all">
        {value}
      </dd>
    </div>
  );
}

export function IdentityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1">
      <dt className="font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-words text-right font-mono text-xs text-ink-muted">{value}</dd>
    </div>
  );
}
