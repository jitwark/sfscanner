import type { CorpusAnalytics } from '@hub/contracts';
import { SectionHeading } from './composition-sections';

/**
 * Catalogue coverage of node semantics — **not** a measure of security accuracy.
 *
 * A modelled node type means the scanner understands that node's ports, effects,
 * credentials and destination. An unmodelled type is not "safe": the structural
 * policies still audit its parameters, but the dataflow through the node is
 * unknown, which is exactly what this section says out loud. Counts are taken
 * over the bound readable inputs the extractor observed — including inputs the
 * engine later refused, whose nodes were still present in the body — never over
 * the whole catalogue, and every share names that denominator.
 */
export function NodeCoveragePanel({
  nodeCoverage,
  readableInputs,
  refused,
}: {
  nodeCoverage: CorpusAnalytics['nodeCoverage'];
  readableInputs: number;
  refused: number;
}) {
  const {
    observedNodeTypes,
    observedNodeInstances,
    modelledTypes,
    partlyModelledTypes,
    unmodelledTypes,
    versions,
    unknownTypes,
  } = nodeCoverage;

  const sortedUnknown = [...unknownTypes].sort((a, b) => b.workflows - a.workflows);
  const shownUnknown = sortedUnknown.slice(0, 15);
  const allModelled = observedNodeTypes > 0 && modelledTypes === observedNodeTypes;
  const modelledVersionCount = versions.filter((row) => row.semantics === 'MODELLED').length;
  const modelledVersions = versions
    .filter((row) => row.semantics === 'MODELLED')
    .sort((a, b) => b.workflows - a.workflows)
    .slice(0, 12);

  const shape: { label: string; count: number; tone: string }[] = [
    { label: 'Modelled', count: modelledTypes, tone: 'var(--color-sev-low)' },
    { label: 'Partly modelled', count: partlyModelledTypes, tone: 'var(--color-sev-medium)' },
    { label: 'Unmodelled', count: unmodelledTypes, tone: 'var(--color-sev-unknown)' },
  ];

  return (
    <section aria-labelledby="nodes-heading" className="flex flex-col gap-4">
      <SectionHeading
        id="nodes-heading"
        title="Node semantics coverage"
        aside={`${observedNodeTypes.toLocaleString('en-US')} types · ${observedNodeInstances.toLocaleString('en-US')} instances observed`}
      />
      <p className="max-w-[80ch] text-sm leading-6 text-ink-muted">
        Whether the scanner models a node type&rsquo;s inputs, outputs, credential use and destination —{' '}
        <strong className="text-ink">catalogue coverage, not security accuracy</strong>. Counted over the{' '}
        {readableInputs.toLocaleString('en-US')} bound readable inputs, including the{' '}
        {refused.toLocaleString('en-US')} engine {refused === 1 ? 'refusal' : 'refusals'} whose bodies were still parsed — not over the whole
        catalogue, and not a count of native results. A type in the unmodelled column is not safe and is not
        failed: the structural policies still audit its parameters, and versions outside a catalogued range are
        reported as unknown rather than assumed compatible.
      </p>

      <div className="grid grid-cols-1 min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="min-w-0 rounded-panel border border-hairline bg-panel p-5">
          <h3 className="font-display text-base font-semibold text-ink">Types by modelling depth</h3>
          <div className="mt-4 flex h-3 w-full gap-[2px] overflow-hidden rounded-full border border-hairline/60 bg-raised p-[1px]" aria-hidden="true">
            {shape.map((row) =>
              row.count > 0 ? (
                <div
                  key={row.label}
                  className="h-full"
                  style={{ width: `${(row.count / Math.max(1, observedNodeTypes)) * 100}%`, background: row.tone }}
                />
              ) : null,
            )}
          </div>
          <table className="mt-4 w-full border-collapse">
            <caption className="sr-only">Observed node types by modelling depth</caption>
            <thead>
              <tr className="border-b border-hairline text-left font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
                <th scope="col" className="py-2 pr-3 font-normal">Depth</th>
                <th scope="col" className="py-2 pr-3 text-right font-normal">Types</th>
                <th scope="col" className="py-2 pl-3 text-right font-normal">Of observed types</th>
              </tr>
            </thead>
            <tbody>
              {shape.map((row) => (
                <tr key={row.label} className="border-b border-hairline/60 last:border-0">
                  <th scope="row" className="py-1.5 pr-3 text-left text-sm font-normal text-ink">
                    <span className="inline-flex items-center gap-2">
                      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: row.tone }} />
                      {row.label}
                    </span>
                  </th>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-2xs tabular-nums text-ink-muted">
                    {row.count.toLocaleString('en-US')}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pl-3 text-right font-mono text-2xs tabular-nums text-ink-faint">
                    {observedNodeTypes > 0 ? `${((row.count / observedNodeTypes) * 100).toFixed(1)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="min-w-0 rounded-panel border border-hairline bg-panel p-5">
          <h3 className="font-display text-base font-semibold text-ink">Most used unmodelled types</h3>
          <p className="mt-1 text-sm leading-6 text-ink-muted">
            {shownUnknown.length < sortedUnknown.length
              ? `The ${shownUnknown.length} most widely used of ${sortedUnknown.length.toLocaleString('en-US')} fully unmodelled types observed in scanned bodies, by workflow reach.`
              : 'Every fully unmodelled type observed in scanned bodies, by workflow reach.'}
          </p>
          {shownUnknown.length === 0 ? (
            <p className="mt-4 text-sm text-ink-muted">
              {allModelled
                ? 'Every observed node type is modelled.'
                : `No fully unmodelled types; ${partlyModelledTypes.toLocaleString('en-US')} observed ${partlyModelledTypes === 1 ? 'type is' : 'types are'} partly modelled, so some observed versions are not in the catalogue.`}
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[28rem] border-collapse">
                <caption className="sr-only">Unmodelled node types by workflows and observed versions</caption>
                <thead>
                  <tr className="border-b border-hairline text-left font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
                    <th scope="col" className="py-2 pr-3 font-normal">Node type</th>
                    <th scope="col" className="py-2 pr-3 text-right font-normal">Workflows</th>
                    <th scope="col" className="py-2 pl-3 font-normal">Versions observed</th>
                  </tr>
                </thead>
                <tbody>
                  {shownUnknown.map((row) => (
                    <tr key={row.nodeType} className="border-b border-hairline/60 last:border-0">
                      <th scope="row" className="break-all py-2 pr-3 text-left align-middle font-mono text-xs font-normal text-ink">
                        {row.nodeType}
                      </th>
                      <td className="whitespace-nowrap py-2 pr-3 text-right align-middle font-mono text-2xs tabular-nums text-ink-muted">
                        {row.workflows.toLocaleString('en-US')}
                      </td>
                      <td className="py-2 pl-3 align-middle font-mono text-2xs text-ink-faint">
                        {row.versions.length > 0 ? row.versions.join(', ') : 'unversioned'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {modelledVersions.length > 0 && (
        <div className="min-w-0 rounded-panel border border-hairline bg-panel p-5">
          <h3 className="font-display text-base font-semibold text-ink">Modelled versions in use</h3>
          <p className="mt-1 text-sm leading-6 text-ink-muted">
            {modelledVersionCount > modelledVersions.length
              ? `The ${modelledVersions.length} most widely used of ${modelledVersionCount.toLocaleString('en-US')} modelled (type, version) pairs,`
              : `Every modelled (type, version) pair observed (${modelledVersionCount.toLocaleString('en-US')}),`}{' '}
            counted over the {readableInputs.toLocaleString('en-US')} bound readable inputs. A version is
            modelled only when it appears in the catalogue; the nearest-neighbour guess that older rules used to
            make here is gone.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[30rem] border-collapse">
              <caption className="sr-only">Modelled node versions ranked by workflow reach</caption>
              <thead>
                <tr className="border-b border-hairline text-left font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
                  <th scope="col" className="py-2 pr-3 font-normal">Node type</th>
                  <th scope="col" className="py-2 pr-3 font-normal">Version</th>
                  <th scope="col" className="py-2 pr-3 text-right font-normal">Workflows</th>
                  <th scope="col" className="py-2 pl-3 text-right font-normal">Instances</th>
                </tr>
              </thead>
              <tbody>
                {modelledVersions.map((row) => (
                  <tr key={`${row.nodeType}@${row.version}`} className="border-b border-hairline/60 last:border-0">
                    <th scope="row" className="break-all py-2 pr-3 text-left align-middle font-mono text-xs font-normal text-ink">
                      {row.nodeType}
                    </th>
                    <td className="whitespace-nowrap py-2 pr-3 align-middle font-mono text-2xs text-ink-muted">{row.version}</td>
                    <td className="whitespace-nowrap py-2 pr-3 text-right align-middle font-mono text-2xs tabular-nums text-ink-muted">
                      {row.workflows.toLocaleString('en-US')}
                    </td>
                    <td className="whitespace-nowrap py-2 pl-3 text-right align-middle font-mono text-2xs tabular-nums text-ink-faint">
                      {row.instances.toLocaleString('en-US')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
