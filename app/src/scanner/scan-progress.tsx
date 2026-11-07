'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { Button } from '@/src/ui/primitives/button';

/**
 * Phase vocabulary of the worker (scan.worker.ts:33-34, posted at lines 90/129/138).
 * The *label* is what the polite live region announces — never the percentage and
 * never the ticking clock — so a deep 30s scan announces three times, not once a second.
 * Consumed by scanner-client.tsx, which owns the announcement and passes the label down.
 */
export const PHASE_LABELS: Readonly<Record<string, string>> = {
  parse: 'Reading workflow JSON…',
  analyse: 'Analyzing workflow topology…',
  render: 'Preparing findings…',
};
export const PENDING_PHASE_LABEL = 'Scanning workflow…';

/** `m:ss`. The local time budget is tens of seconds, so minutes only ever read 0. */
export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The in-flight surface for one local scan. It is the `aria-busy` container: the
 * label, elapsed time, and progress bar all describe live work, and the polite
 * live region that announces phases deliberately lives *outside* this subtree
 * (scanner-client.tsx) because `aria-busy` lets AT defer updates inside it.
 */
export function ScanProgress({ label, pct, startedAt, onCancel, now = Date.now }: {
  /** Human label for the current phase; an unseen phase gets the generic one. */
  label: string;
  pct: number;
  /** Epoch ms the run started: the elapsed timer's origin. */
  startedAt: number;
  onCancel: () => void;
  /** Injected clock, so elapsed rendering is deterministic under test. */
  now?: () => number;
}) {
  const [elapsedMs, setElapsedMs] = useState(() => now() - startedAt);
  // Held in a ref so an inline `now` prop cannot restart the tick: this component
  // re-renders on every progress message, and the interval must survive all of them.
  // The ref is written in an effect, never during render: a render-time write is unsafe
  // under concurrent rendering (`react-hooks/refs`) and would let a discarded render leak
  // its `now` into the live interval. A no-dependency effect runs after every render, so
  // the interval still reads the latest prop.
  const clockRef = useRef(now);
  useEffect(() => {
    clockRef.current = now;
  });

  useEffect(() => {
    const timer = setInterval(() => setElapsedMs(clockRef.current() - startedAt), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const percent = Math.min(100, Math.max(0, pct));

  return (
    <div aria-busy="true" className="rounded-panel border border-accent-border/40 bg-panel p-4 text-ink">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-mono text-xs font-medium">
          <RefreshCw className="h-4 w-4 animate-spin text-accent-text motion-reduce:animate-none" aria-hidden="true" />
          <span>{label}</span>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {/* role="timer" is not a live region: ticks are readable on demand, never announced. */}
          <span role="timer" aria-label="Elapsed time" className="font-mono text-xs tabular-nums text-ink-muted">
            {formatElapsed(elapsedMs)}
          </span>
          <Button variant="secondary" size="44" onClick={onCancel}>
            <X className="h-4 w-4" aria-hidden="true" /><span>Cancel scan</span>
          </Button>
        </div>
      </div>
      <div role="progressbar" aria-label="Scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
        className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-raised">
        <div className="h-full bg-accent transition-all duration-150" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
