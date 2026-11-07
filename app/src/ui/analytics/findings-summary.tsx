import type { CorpusAnalytics } from '@hub/contracts';
import { SEVERITY_LABEL, SEVERITY_ORDER, SEVERITY_TOKEN } from './severity';

export type FindingsSummaryProps = {
  findings: CorpusAnalytics['findings'];
  /** Every catalogued entry the flagged count was measured over, scanned or not. */
  total: number;
  /** Completed scans — the only population a clean count can be drawn from. */
  completed: number;
};

/**
 * The headline the rest of the security section hangs off: how much of the
 * catalogue the scanner flagged at all, and how those flags distribute by
 * severity.
 *
 * A clean count needs a denominator, or "clean" silently means "nothing was
 * recorded", which is also what an entry nobody scanned looks like. So the
 * clean figure is stated against the completed scans it came from, and the
 * entries that merely have no findings recorded are named as such.
 *
 * A single stacked rule rather than a pie: the parts sum to a meaningful whole,
 * and a stack compares parts against that whole without asking anyone to judge
 * angles. Each segment is separated by a 2px surface gap and every segment is
 * also listed below with its label and count, so the stack is a summary of the
 * list rather than the only place the numbers live.
 */
export function FindingsSummary({ findings, total, completed }: FindingsSummaryProps) {
  const graded = Math.max(1, total);
  const flaggedShare = (findings.workflowsWithFindings / graded) * 100;
  const occurrences = Math.max(1, findings.totalOccurrences);
  const hasFindings = findings.totalOccurrences > 0;
  // Always non-negative: every clean scan is one of the entries with no findings recorded.
  const recordedButNotClean = findings.noFindingsRecorded - findings.cleanScanned;

  return (
    <section className="min-w-0 rounded-panel border border-hairline bg-panel p-5">
      <h3 className="font-display text-base font-semibold text-ink">Findings across the corpus</h3>
      <p className="mt-1 max-w-[60ch] text-sm leading-6 text-ink-muted">
        {hasFindings ? (
          <>
            <strong className="text-ink">{findings.workflowsWithFindings.toLocaleString('en-US')}</strong>{' '}
            workflows ({flaggedShare.toFixed(1)}%) carry at least one finding;{' '}
            <strong className="text-ink">{findings.cleanScanned.toLocaleString('en-US')}</strong> of the{' '}
            <strong className="text-ink">{completed.toLocaleString('en-US')}</strong> scans that completed
            carry none. Another{' '}
            <strong className="text-ink">{recordedButNotClean.toLocaleString('en-US')}</strong> entries have
            no findings recorded but were not scanned under the current scanner, so they are not counted
            clean. Most findings are low severity, and low severity means &ldquo;worth a look&rdquo;.
          </>
        ) : (
          <strong className="text-ink">No findings were recorded in this release.</strong>
        )}
      </p>

      <div className="mt-4 flex h-3 w-full gap-[2px] overflow-hidden rounded-full border border-hairline/60 bg-raised p-[1px]" aria-hidden="true">
        {SEVERITY_ORDER.map((severity) => {
          const count = findings.bySeverity[severity];
          if (count === 0) return null;
          return (
            <div
              key={severity}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${(count / occurrences) * 100}%`, background: SEVERITY_TOKEN[severity] }}
            />
          );
        })}
      </div>

      <table className="mt-4 w-full border-collapse">
        <caption className="sr-only">Findings by severity</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Severity</th>
            <th scope="col">Findings</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {SEVERITY_ORDER.map((severity) => {
            const count = findings.bySeverity[severity];
            return (
              <tr key={severity}>
                <th scope="row" className="py-1 text-left align-middle text-sm font-normal text-ink">
                  <span className="inline-flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: SEVERITY_TOKEN[severity] }}
                    />
                    {SEVERITY_LABEL[severity]}
                  </span>
                </th>
                <td className="py-1 text-right align-middle font-mono text-2xs tabular-nums text-ink-muted">
                  {count.toLocaleString('en-US')}
                </td>
                <td className="w-0 whitespace-nowrap py-1 pl-3 text-right align-middle font-mono text-2xs tabular-nums text-ink-faint">
                  {((count / occurrences) * 100).toFixed(1)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
