import type { CorpusAnalytics } from '@hub/contracts';
import { SectionHeading } from './composition-sections';
import { DigestItem, IdentityRow } from './scan-coverage-receipts';

type Coverage = CorpusAnalytics['scanCoverage'];
type Evidence = CorpusAnalytics['v2Evidence'];

/**
 * How much of the corpus the current scanner actually read, as row states that
 * partition the catalogue rather than a single "scanned" number.
 *
 * `scanned` is an admitted **result** population, not a verdict population: an
 * indeterminate result publishes no assessment, and a degraded one may have its
 * assessment withheld. The table therefore has one row per disjoint state, and
 * the current-result figure is stated as the sum of the first three — the two are
 * never peer rows, because that would double count.
 *
 * The distinction the table exists to protect: an entry with no body, an entry
 * whose upstream source could not be re-acquired, and an entry carrying a result
 * from a retired engine are three different facts. Folding any of them into
 * "scanned" would overstate coverage; folding them into a clean count would call
 * an unread workflow safe.
 */
export function ScanCoveragePanel({
  coverage,
  evidence,
  release,
}: {
  coverage: Coverage;
  evidence: Evidence;
  release: { generatedAt: string; corpusSha256: string };
}) {
  const { total } = coverage;
  const rows = [
    {
      key: 'completed',
      label: 'Completed',
      count: coverage.completed,
      detail: 'Every required capability ran; nothing was skipped, omitted or truncated.',
    },
    {
      key: 'degraded',
      label: 'Degraded',
      count: coverage.degraded,
      detail: 'A result exists, but recorded skips or omissions mean its assessment may be withheld or may have missed findings.',
    },
    {
      key: 'indeterminate',
      label: 'Indeterminate',
      count: coverage.indeterminate,
      detail: 'An admitted native result exists, but a required capability was skipped, failed or truncated, so no assessment is published.',
    },
    {
      key: 'noResult',
      label: 'No result (refused)',
      count: coverage.noResult,
      detail: 'The current engine read the body and refused it: no native result exists. Not historical — there is no retired verdict — and not unread. No grade is published.',
    },
    {
      key: 'noBody',
      label: 'No body to scan',
      count: coverage.noBody,
      detail: 'Metadata-only entries. There are no bytes, so there is nothing to read.',
    },
    {
      key: 'historical',
      label: 'Historical only',
      count: coverage.historical,
      detail: 'A verdict from a retired engine, never re-run. Not presented as a current result.',
    },
    {
      key: 'sourceUnavailable',
      label: 'Source unavailable',
      count: coverage.sourceUnavailable,
      detail: `Body recorded but the pinned upstream source could not be re-acquired. ${evidence.excludedByRuling.toLocaleString('en-US')} of these are owner-ruled exclusions.`,
    },
  ];
  const stateTotal = rows.reduce((sum, row) => sum + row.count, 0);
  const signatureVerified = evidence.signatureStatus.toLowerCase() === 'verified';

  return (
    <section aria-labelledby="coverage-heading" className="flex flex-col gap-4">
      <SectionHeading
        id="coverage-heading"
        title="Scan coverage"
        aside={`${coverage.scanned.toLocaleString('en-US')} admitted native results · ${coverage.noResult.toLocaleString('en-US')} engine refusals`}
      />
      <div className="grid grid-cols-1 min-w-0 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0 rounded-panel border border-hairline bg-panel p-5">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] border-collapse">
              <caption className="sr-only">
                Disjoint scan row states against the {total.toLocaleString('en-US')} catalogued entries, and their meanings
              </caption>
              <thead>
                <tr className="border-b border-hairline text-left font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
                  <th scope="col" className="py-2 pr-3 font-normal">State</th>
                  <th scope="col" className="py-2 pr-3 text-right font-normal">Entries</th>
                  <th scope="col" className="py-2 pl-3 text-right font-normal">Of catalogue</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-b border-hairline/60">
                    <th scope="row" className="py-2.5 pr-3 text-left align-top text-sm font-normal text-ink">
                      <span className="block">{row.label}</span>
                      <span className="mt-0.5 block max-w-[52ch] text-xs leading-5 text-ink-muted">{row.detail}</span>
                    </th>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-right align-top font-mono text-sm tabular-nums text-ink">
                      {row.count.toLocaleString('en-US')}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pl-3 text-right align-top font-mono text-2xs tabular-nums text-ink-faint">
                      {total > 0 ? `${((row.count / total) * 100).toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-accent-dim/40">
                  <th scope="row" className="py-2.5 pr-3 text-left text-sm font-normal text-ink">
                    Total · every entry lands in exactly one state
                  </th>
                  <td className="whitespace-nowrap py-2.5 pr-3 text-right font-mono text-sm font-semibold tabular-nums text-ink">
                    {stateTotal.toLocaleString('en-US')}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pl-3 text-right font-mono text-2xs tabular-nums text-ink-faint">
                    {total > 0 ? `${((stateTotal / total) * 100).toFixed(1)}%` : '—'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-3 border-t border-hairline pt-3 text-xs leading-5 text-ink-muted">
            <strong className="text-ink">{coverage.scanned.toLocaleString('en-US')}</strong> rows are admitted
            native results ({coverage.completed.toLocaleString('en-US')} completed,{' '}
            {coverage.degraded.toLocaleString('en-US')} degraded,{' '}
            {coverage.indeterminate.toLocaleString('en-US')} indeterminate).{' '}
            <strong className="text-ink">{coverage.noResult.toLocaleString('en-US')}</strong> more were read by
            the current engine and refused: no result exists, so they are reported as no-result — not
            historical, not unread, and never current or clean. Together they are the{' '}
            {evidence.inventory.available.toLocaleString('en-US')} bound readable inputs.
          </p>
          <p className="mt-2 text-xs leading-5 text-ink-muted">
            These states partition the catalogue and reconcile: {total.toLocaleString('en-US')} total ={' '}
            {coverage.bodyAvailable.toLocaleString('en-US')} entries with a body +{' '}
            {coverage.noBody.toLocaleString('en-US')} without one; bodies ={' '}
            {coverage.scanned.toLocaleString('en-US')} admitted native results +{' '}
            {coverage.noResult.toLocaleString('en-US')} engine refusals +{' '}
            {coverage.historical.toLocaleString('en-US')} historical +{' '}
            {coverage.sourceUnavailable.toLocaleString('en-US')} source-unavailable. A row with no admitted
            native result is never counted as current, and a row with no assessment is{' '}
            <strong className="text-ink">unknown</strong>, not clean.
          </p>
        </div>

        <div className="min-w-0 rounded-panel border border-hairline bg-panel p-5">
          <h3 className="font-display text-base font-semibold text-ink">What produced these numbers</h3>
          <p className="mt-1 text-sm leading-6 text-ink-muted">
            The identity the admitted receipts were checked against. A result is admitted only when the whole
            tuple and the entry&rsquo;s own body digest match — an engine version string alone is not evidence.
          </p>
          <dl className="mt-4 divide-y divide-hairline/60">
            <IdentityRow label="Scanner" value={evidence.scannerVersion} />
            <IdentityRow
              label="Ruleset"
              value={`${evidence.rulesetId} v${evidence.rulesetVersion} · signature ${evidence.signatureStatus}`}
            />
            <IdentityRow label="Profile" value={`${evidence.profileId} v${evidence.profileVersion}`} />
            <IdentityRow label="Semantics" value={`${evidence.semanticsId} v${evidence.semanticsVersion}`} />
            <IdentityRow
              label="Inventory"
              value={`${evidence.inventory.available.toLocaleString('en-US')} available · ${evidence.inventory.missing.toLocaleString('en-US')} missing · ${evidence.inventory.sourceUnavailable.toLocaleString('en-US')} source-unavailable`}
            />
            <IdentityRow
              label="Corpus snapshot"
              value={`${release.generatedAt} · ${release.corpusSha256}`}
            />
          </dl>
          {!signatureVerified && (
            <p className="mt-3 text-xs leading-5 text-ink-muted">
              The ruleset signature is <strong className="text-ink">{evidence.signatureStatus}</strong>. Results
              were still admitted and published; this states the verification status of the rules the scanner
              ran, not a verdict about any workflow.
            </p>
          )}
          <div className="mt-4 border-t border-hairline pt-4">
            <h4 className="font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
              Cryptographic Receipts &amp; Digests
            </h4>
            <p className="mt-0.5 text-xs text-ink-muted">
              Admitted verification digests ensuring provenance and uncorrupted engine state.
            </p>
            <dl className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <DigestItem label="Engine build" value={evidence.engineBuildDigest} />
              <DigestItem label="Ruleset digest" value={evidence.rulesetDigest} />
              <DigestItem label="Semantics digest" value={evidence.semanticsDigest} />
              <DigestItem label="Limits digest" value={evidence.limitsDigest} />
              <DigestItem label="Inventory sha256" value={evidence.inventorySha256} />
              <DigestItem label="Corpus sha256" value={release.corpusSha256} />
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}
