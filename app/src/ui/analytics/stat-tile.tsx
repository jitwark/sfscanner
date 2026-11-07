import type { ReactNode } from 'react';

export type StatTileProps = {
  label: string;
  value: number | string;
  /** One short clause of context. A number without a denominator is a rumour. */
  detail?: ReactNode;
  /** 0–100. Renders a thin proportion rule under the value when supplied. */
  share?: number;
  emphasis?: boolean;
};

export function StatTile({ label, value, detail, share, emphasis = false }: StatTileProps) {
  const formatted = typeof value === 'number' ? value.toLocaleString('en-US') : value;

  return (
    <div
      className={`flex min-w-0 flex-col rounded-panel border p-5 ${
        emphasis ? 'border-accent-border/40 bg-accent-dim' : 'border-hairline bg-panel'
      }`}
    >
      <p className="font-mono text-2xs uppercase tracking-[0.16em] text-ink-faint">{label}</p>
      <p className="mt-2 font-display text-3xl font-semibold tabular-nums tracking-tight text-ink">
        {formatted}
      </p>
      {share !== undefined && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-raised border border-hairline/40" aria-hidden>
          <div
            className="h-full rounded-full bg-accent border border-accent-border/50"
            style={{ width: `${Math.min(100, Math.max(0, share))}%` }}
          />
        </div>
      )}
      {detail && <p className="mt-2 text-xs leading-5 text-ink-muted">{detail}</p>}
    </div>
  );
}
