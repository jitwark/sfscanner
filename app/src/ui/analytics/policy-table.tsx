import type { PolicyRow } from '@hub/contracts';
import { SEVERITY_LABEL, SEVERITY_TOKEN } from './severity';

export type PolicyTableProps = {
  policies: PolicyRow[];
  /**
   * Denominator for the reach bar: every catalogued workflow the `workflows`
   * counts were taken over, including entries whose findings come from a retired
   * scanner. It is not the scanned population — the numerator is not drawn from
   * that, and dividing by it would overstate reach.
   */
  denominator: number;
};

/**
 * What the scanner actually found, per rule, across the whole corpus.
 *
 * Two numbers, deliberately kept apart: `workflows` is reach, `occurrences` is
 * volume. A rule that fires nineteen times inside one workflow affects one
 * workflow, and collapsing the two would let a single noisy file dominate a
 * chart about prevalence. The bar encodes reach; volume stays a plain figure.
 *
 * Severity is drawn as a labelled chip rather than a coloured row, so the rank
 * order is never carried by colour alone.
 */
export function PolicyTable({ policies, denominator }: PolicyTableProps) {
  const bounded = Math.max(1, denominator);

  return (
    <section className="min-w-0 rounded-panel border border-hairline bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-display text-base font-semibold text-ink">Policies</h3>
        <p className="font-mono text-2xs tabular-nums text-ink-faint">
          Reach across {bounded.toLocaleString('en-US')} workflows
        </p>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse">
          <caption className="sr-only">Scanner policies by number of workflows affected</caption>
          <thead>
            <tr className="border-b border-hairline text-left font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
              <th scope="col" className="py-2 pr-3 font-normal">Policy</th>
              <th scope="col" className="py-2 pr-3 font-normal">Severity</th>
              <th scope="col" className="w-full py-2 pr-3 font-normal">Workflows reached</th>
              <th scope="col" className="py-2 pl-3 text-right font-normal">Findings</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((policy) => {
              const share = (policy.workflows / bounded) * 100;
              return (
                <tr key={policy.id} className="border-b border-hairline/60 last:border-0">
                  <th scope="row" className="whitespace-nowrap py-2.5 pr-3 text-left align-middle text-sm font-normal text-ink">
                    <span className="block">{policy.title}</span>
                    <span className="block font-mono text-2xs text-ink-faint">{policy.id}</span>
                  </th>
                  <td className="whitespace-nowrap py-2.5 pr-3 align-middle">
                    <span className="inline-flex items-center gap-1.5 font-mono text-2xs text-ink-muted">
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: SEVERITY_TOKEN[policy.severity] }}
                      />
                      {SEVERITY_LABEL[policy.severity]}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 align-middle">
                    <div className="flex items-center gap-3">
                      <div className="h-2 w-full min-w-[6rem] overflow-hidden rounded-full bg-raised border border-hairline/50">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.max(1.5, share)}%`, background: SEVERITY_TOKEN[policy.severity] }}
                        />
                      </div>
                      <span className="whitespace-nowrap font-mono text-2xs tabular-nums text-ink-muted">
                        {policy.workflows.toLocaleString('en-US')}
                        <span className="ml-2 text-ink-faint">{share.toFixed(1)}%</span>
                      </span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap py-2.5 pl-3 text-right align-middle font-mono text-2xs tabular-nums text-ink-muted">
                    {policy.occurrences.toLocaleString('en-US')}
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
