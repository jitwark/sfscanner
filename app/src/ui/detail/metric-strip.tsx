import type { Entry } from '@hub/contracts';

type MetricStripProps = { entry: Entry };
type Metric = { label: string; value: string | number };

export function MetricStrip({ entry }: MetricStripProps) {
  const metrics: Metric[] = [
    { label: 'Active nodes', value: entry.structure.nodeCount },
    ...(entry.structure.rawNodeCount > entry.structure.nodeCount
      ? [{ label: 'Annotations', value: entry.structure.annotationNodeCount }]
      : []),
    { label: 'Connections', value: entry.structure.connectionCount },
    { label: 'Trigger', value: entry.structure.trigger || 'Unknown' },
    { label: 'Complexity', value: entry.structure.complexity },
  ];
  const columns = metrics.length === 5 ? 'sm:grid-cols-3 lg:grid-cols-5' : 'sm:grid-cols-4';
  return (
    <dl aria-label="Workflow metrics" className={`grid min-w-0 grid-cols-2 overflow-hidden rounded-panel border border-hairline bg-panel ${columns}`}>
      {metrics.map((metric) => (
        <div key={metric.label} className="flex min-h-20 min-w-0 flex-col justify-center gap-1 border-b border-r border-hairline bg-panel px-4 py-3 last:border-r-0">
          <dt className="text-2xs font-mono uppercase tracking-wider font-bold text-ink-muted">{metric.label}</dt>
          <dd className="truncate font-sans text-xl font-bold tabular-nums text-accent-text">{metric.value}</dd>
        </div>
      ))}
    </dl>
  );
}
