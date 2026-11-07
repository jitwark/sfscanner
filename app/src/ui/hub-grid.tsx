import { isIndexable, toSearchDisplayItem, type Entry } from '@hub/contracts';
import { ResultCard, type ResultCardItem } from './result-card';

export type HubGridProps = {
  entries: Entry[];
};

export function entryToCardItem(entry: Entry): ResultCardItem {
  return toSearchDisplayItem(entry, {
    isIndexable: isIndexable(entry),
    isPrerendered: entry.isPrerendered ?? false,
  });
}

export function HubGrid({ entries }: HubGridProps) {
  if (entries.length === 0) {
    return (
      <div className="p-8 rounded-panel bg-panel border border-hairline text-center text-ink-muted">
        No workflows found in this hub.
      </div>
    );
  }

  return (
    <div className="divide-y divide-hairline overflow-hidden rounded-panel border border-hairline bg-panel">
      {entries.map((entry) => (
        <ResultCard key={entry.id} item={entryToCardItem(entry)} />
      ))}
    </div>
  );
}
