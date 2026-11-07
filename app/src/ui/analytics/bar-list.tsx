export type BarRow = {
  label: string;
  count: number;
  /** Optional explicit colour token. Omit for the single-hue magnitude default. */
  color?: string;
};

export type BarListProps = {
  title: string;
  description?: string;
  rows: BarRow[];
  /** Denominator for the share column. Defaults to the largest row. */
  total?: number;
  /** Ordered scales keep their given order; magnitude scales sort descending. */
  sort?: boolean;
};

/**
 * A ranked magnitude chart that is literally a data table.
 *
 * Bars are drawn inside table cells rather than beside an invented ARIA
 * structure, so the "table view" an accessible chart is supposed to offer is not
 * a fallback bolted on afterwards — it is what the markup already is. Every row
 * carries its own label and value, so colour never has to be read.
 */
export function BarList({ title, description, rows, total, sort = true }: BarListProps) {
  const ordered = sort ? [...rows].sort((a, b) => b.count - a.count) : rows;
  const max = Math.max(1, ...ordered.map((row) => row.count));
  const denominator = total ?? max;

  return (
    <section className="min-w-0 rounded-panel border border-hairline bg-panel p-5">
      <h3 className="font-display text-base font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1 text-sm leading-6 text-ink-muted">{description}</p>}

      {/*
        `label` and the count+share column are both `whitespace-nowrap` by
        design — a magnitude chart reads badly with a wrapped label — so an
        auto-layout table's minimum content width is whatever the longest
        label needs, unbounded. On a narrow viewport with a long label (an
        integration or node-type name; this list is data-driven, not a fixed
        catalogue), that minimum can exceed the section's width and push the
        whole page wider than the viewport. `policy-table.tsx` and
        `risk-matrix.tsx` already solve this the same way: contain the
        overflow inside a scrollable wrapper that is itself the "data
        container", rather than letting an auto-layout table stretch the
        document.
      */}
      <div className="mt-4 overflow-x-auto min-w-0">
        <table className="w-full border-collapse">
          <caption className="sr-only">{title}</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Workflows</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((row) => {
              const share = denominator > 0 ? (row.count / denominator) * 100 : 0;
              return (
                <tr key={row.label} className="group">
                  <th
                    scope="row"
                    title={row.label}
                    className="w-0 max-w-[9rem] truncate py-1.5 pr-3 text-left align-middle text-sm font-normal text-ink sm:max-w-none sm:whitespace-nowrap"
                  >
                    {row.label}
                  </th>
                  <td className="w-full py-1.5 align-middle">
                    {/* Thin mark, rounded data-end, anchored to a recessive track. */}
                    <div className="h-2 w-full min-w-[6rem] overflow-hidden rounded-full bg-raised border border-hairline/50">
                      <div
                        className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
                        style={{
                          width: `${Math.max(1.5, (row.count / max) * 100)}%`,
                          background: row.color ?? 'var(--color-accent)',
                        }}
                      />
                    </div>
                  </td>
                  <td className="w-0 whitespace-nowrap py-1.5 pl-3 text-right align-middle font-mono text-2xs tabular-nums text-ink-muted">
                    {row.count.toLocaleString('en-US')}
                    <span className="ml-2 text-ink-faint">{share.toFixed(1)}%</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
