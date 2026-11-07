import type { NodeCountBin } from '@hub/contracts';

export type HistogramProps = {
  title: string;
  description?: string;
  bins: NodeCountBin[];
  /** Marked on the axis so the shape has a reference point. */
  median?: number;
  unit?: string;
};

/**
 * A distribution, drawn as vertical columns in bin order.
 *
 * Bin order is the whole point: sorting a histogram by magnitude destroys the
 * shape it exists to show. Empty bins are kept for the same reason — a gap is
 * information. Columns are labelled directly, so the figure is readable without
 * a tooltip and without JavaScript.
 */
export function Histogram({ title, description, bins, median, unit = 'workflows' }: HistogramProps) {
  const max = Math.max(1, ...bins.map((bin) => bin.count));
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);

  const isMedianBin = (bin: NodeCountBin) => {
    if (median === undefined) return false;
    if (bin.max !== undefined && bin.max !== null) {
      return median >= bin.min && median <= bin.max;
    }
    return median >= bin.min;
  };

  return (
    <section className="min-w-0 rounded-panel border border-hairline bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-base font-semibold text-ink">{title}</h3>
        {median !== undefined && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-raised/70 px-2.5 py-0.5 font-mono text-2xs text-ink-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
            Median: <strong className="text-ink">{median}</strong> nodes
          </span>
        )}
      </div>
      {description && <p className="mt-1 text-sm leading-6 text-ink-muted">{description}</p>}

      <div className="mt-5 overflow-x-auto min-w-0">
        <div className="relative min-w-[280px]">
          {/* Subtle horizontal reference gridlines */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-36 flex flex-col justify-between border-b border-hairline/40 opacity-40" aria-hidden="true">
            <div className="border-t border-hairline/60 w-full" />
            <div className="border-t border-hairline/30 w-full" />
            <div className="border-t border-hairline/30 w-full" />
          </div>

          <table className="relative w-full table-fixed border-collapse">
            <caption className="sr-only">
              {title} — {total.toLocaleString('en-US')} {unit} across {bins.length} bands
            </caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Band</th>
                <th scope="col">Workflows</th>
              </tr>
            </thead>
            {/* Exactly two table rows preserved for semantic reading order and tests */}
            <tbody>
              <tr style={{ height: '9rem' }} className="h-36">
                {bins.map((bin) => {
                  const hasData = bin.count > 0;
                  const percent = Math.max(2, (bin.count / max) * 100);
                  const isMed = isMedianBin(bin);

                  return (
                    <td key={bin.label} className="h-36 min-w-0 p-0 align-bottom">
                      <div className="flex h-36 min-w-0 flex-col justify-end gap-1 px-1 group">
                        {isMed && (
                          <span className="self-center font-mono text-[9px] uppercase tracking-wider text-accent-text font-semibold">
                            Med
                          </span>
                        )}
                        <span className={`text-center font-mono text-2xs tabular-nums transition-colors ${
                          hasData ? 'text-ink-muted group-hover:text-ink' : 'text-ink-faint/50'
                        }`}>
                          {bin.count.toLocaleString('en-US')}
                        </span>
                        {hasData ? (
                          <div
                            className={`w-full rounded-t-[3px] border-t-2 border-x transition-all duration-200 ${
                              isMed
                                ? 'bg-accent border-accent-border shadow-[0_0_10px_rgba(118,185,0,0.25)]'
                                : 'bg-accent/85 border-accent-border/60 hover:bg-accent'
                            }`}
                            style={{ height: `${percent}%`, minHeight: '3px' }}
                          />
                        ) : (
                          <div className="w-full h-[2px] bg-hairline/60 rounded-t-[1px]" />
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
              <tr className="border-t border-hairline">
                {bins.map((bin) => (
                  <th
                    key={bin.label}
                    scope="col"
                    className="min-w-0 px-0.5 pt-2 text-center font-mono text-2xs font-normal text-ink-faint"
                  >
                    {bin.label}
                  </th>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
