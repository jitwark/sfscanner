'use client';

import { useId, useMemo, useState } from 'react';
import type { EntryReadiness, ReplaceableValue } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { HistoricalDerivationNote } from './readiness-section';

const KIND_LABELS: Record<ReplaceableValue['kind'], string> = {
  url: 'URLs and endpoints', email: 'Email addresses', phone: 'Phone numbers', chat_id: 'Chat or channel IDs', sheet_id: 'Spreadsheet IDs', id: 'Other identifiers',
};

function groupValues(values: EntryReadiness['replaceableValues']): Array<{ kind: ReplaceableValue['kind']; values: ReplaceableValue[] }> {
  const groups = new Map<ReplaceableValue['kind'], ReplaceableValue[]>();
  for (const value of values) groups.set(value.kind, [...(groups.get(value.kind) ?? []), value]);
  return [...groups.entries()].sort(([left], [right]) => compareCanonicalStrings(left, right)).map(([kind, grouped]) => ({ kind, values: grouped }));
}

function ValueItem({ value }: { value: ReplaceableValue }) {
  return <li className="min-w-0 break-words"><span className="font-semibold text-ink">{value.node}</span><span aria-hidden="true"> · </span><code className="font-mono break-all">{value.field}</code></li>;
}

export function ReplaceableValues({ values, isUnscanned = false }: { values: EntryReadiness['replaceableValues']; isUnscanned?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const groups = useMemo(() => groupValues(values), [values]);
  const visibleGroups = showAll ? groups : groups.slice(0, 6);
  return (
    <section aria-label="Values to replace before running" className="flex min-w-0 flex-col gap-2 rounded-control border border-hairline/80 bg-raised/50 p-3.5">
      <h3 className="flex items-center gap-2 text-xs font-mono font-semibold uppercase tracking-wider text-ink"><span aria-hidden="true" className="text-sm">↻</span><span>Values to replace before running</span><span className="text-ink-muted">({values.length})</span></h3>
      <p className="text-xs leading-5 text-ink-muted">The actual values are intentionally hidden. Replace these fields with your own URLs, addresses, or IDs before you run the workflow.</p>
      {isUnscanned && <HistoricalDerivationNote about="the nodes and fields in this list" />}
      <div id={listId} className="flex min-w-0 flex-col gap-2">
        {visibleGroups.map((group, index) => {
          const preview = showAll ? group.values : group.values.slice(0, 6);
          const hasMore = preview.length < group.values.length;
          return <details key={group.kind} open={showAll || index === 0} className="group min-w-0 rounded border border-hairline/70 bg-panel/50 px-2 open:border-hairline-strong open:bg-raised/60">
            <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-control px-1 text-xs font-semibold text-ink transition-colors marker:hidden hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border/50 active:bg-panel group-open:text-accent-text">
              <span aria-hidden="true" className="mr-2 text-ink-faint transition-transform group-open:rotate-90">›</span>
              <span>{KIND_LABELS[group.kind]}</span><span className="ml-2 font-mono text-ink-muted">{group.values.length}</span>
            </summary>
            <ul className="mt-2 flex min-w-0 flex-col gap-1.5 text-xs text-ink-muted">{preview.map((value, valueIndex) => <ValueItem key={`${value.node}-${value.field}-${valueIndex}`} value={value} />)}</ul>
            {hasMore && <p className="mt-2 text-2xs text-ink-faint">{group.values.length - preview.length} more hidden until you choose “Show all values”.</p>}
          </details>;
        })}
      </div>
      {!showAll && groups.length > 6 && <p className="text-2xs text-ink-faint">{groups.length - visibleGroups.length} categories are collapsed.</p>}
      {(groups.length > 1 || values.length > 6) && <button type="button" aria-expanded={showAll} aria-controls={listId} onClick={() => setShowAll((current) => !current)} className="min-h-11 self-start rounded border border-hairline px-3 text-xs font-medium text-ink transition-colors hover:border-accent-border hover:bg-raised hover:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border/50 active:bg-panel aria-expanded:border-accent-border aria-expanded:bg-accent/10 aria-expanded:text-accent-text">{showAll ? 'Show fewer values' : 'Show all values'}</button>}
    </section>
  );
}
