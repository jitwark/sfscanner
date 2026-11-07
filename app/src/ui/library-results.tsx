import { useEffect, useMemo, useRef } from 'react';
import { ResultCard, type ResultCardItem } from './result-card';
import { Skeleton } from './primitives/skeleton';
import { MIN_ROW_HEIGHT } from './row-offsets';
import { useVirtualRows, type VirtualRowsResult } from './use-virtual-rows';

export type LibraryItem = ResultCardItem;

type LibraryResultsProps = {
  items: LibraryItem[];
  activeIndex: number;
  loading: boolean;
};

export function LibraryResults({ items, activeIndex, loading }: LibraryResultsProps) {
  const listRef = useRef<HTMLUListElement>(null);
  // The virtualizer measures rows, so it has to be able to tell one result set
  // from the next: `items.length` alone would let a new search inherit the
  // previous one's row heights.
  const rowKeys = useMemo(() => items.map((item) => item.id), [items]);
  const virtual = useVirtualRows(items.length, listRef, { selectedIndex: activeIndex, rowKeys });

  useEffect(() => {
    if (activeIndex < 0 || typeof document === 'undefined') return;
    const id = items[activeIndex]?.id;
    const target = id ? document.getElementById(`result-${id}`) : null;
    if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, items]);

  if (loading && items.length === 0) {
    return <div aria-label="Loading workflows" className="space-y-2">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} height={MIN_ROW_HEIGHT} className="w-full" />)}</div>;
  }
  if (items.length === 0) return null;
  return (
    <ul ref={listRef} id="search-results-list" aria-label="Workflow results" className="divide-y divide-hairline overflow-hidden rounded-panel border border-hairline bg-panel">
      {virtual.paddingTop > 0 ? <Spacer height={virtual.paddingTop} /> : null}
      {virtual.virtualItems.map((index, position) => <VirtualItem
        key={items[index]!.id}
        item={items[index]!}
        index={index}
        activeIndex={activeIndex}
        gap={gapBefore(virtual, index, virtual.virtualItems[position - 1])}
        measure={virtual.measureRow(items[index]!.id)}
      />)}
      {virtual.paddingBottom > 0 ? <Spacer height={virtual.paddingBottom} /> : null}
    </ul>
  );
}

/**
 * The rows between two rendered ones, when the window skipped them — the
 * selected row is rendered even when it sits outside the window, and the distance
 * between the two is the measured-or-seeded total of everything in between.
 */
function gapBefore(virtual: VirtualRowsResult, index: number, previousIndex?: number): number {
  if (previousIndex === undefined) return 0;
  const rowsBetween = index - previousIndex - 1;
  if (rowsBetween <= 0) return 0;
  return virtual.offsetOf(index) - virtual.offsetOf(previousIndex + 1);
}

function VirtualItem({ item, index, activeIndex, gap, measure }: {
  item: LibraryItem;
  index: number;
  activeIndex: number;
  gap: number;
  measure: (element: HTMLElement | null) => void;
}) {
  return <>
    {gap > 0 ? <Spacer height={gap} /> : null}
    <li ref={measure}><ResultCard item={item} isHighlighted={index === activeIndex} activeDescendantId={`result-${item.id}`} /></li>
  </>;
}

function Spacer({ height }: { height: number }) {
  return <li aria-hidden="true" style={{ height }} className="pointer-events-none" />;
}
