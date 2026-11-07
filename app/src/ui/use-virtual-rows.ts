import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  MIN_ROW_HEIGHT,
  createRowOffsetModel,
  indexAtOffset,
  recordRowHeights,
  rowHeightAt,
  rowPrefixSums,
  type RowKey,
  type RowOffsetModel,
} from './row-offsets';
import { useRowObserver, type RowMeasurement } from './use-row-observer';

export type VirtualRowsOptions = {
  /**
   * Height to assume for a row nothing has measured yet. Defaults to
   * `MIN_ROW_HEIGHT`, the smallest pitch a row can have — a floor, so an
   * unmeasured gap is under-represented rather than invented, and every
   * measurement can only improve it.
   */
  estimatedRowHeight?: number;
  overscan?: number;
  threshold?: number;
  selectedIndex?: number;
  /**
   * Row identity, in order — one entry per row. Measurements belong to a row,
   * not to the slot it happened to occupy, so that appended, filtered and
   * replaced results cannot inherit each other's heights. Without it, heights
   * are keyed by position and are dropped whenever the row count changes.
   */
  rowKeys?: readonly RowKey[];
};

export type VirtualRowsResult = {
  isVirtual: boolean;
  startIndex: number;
  endIndex: number;
  /** Space before the first rendered row. */
  paddingTop: number;
  /** Space after the last rendered row. */
  paddingBottom: number;
  virtualItems: number[];
  /** The height a row occupies: measured if known, the seed if not. */
  rowHeightOf: (index: number) => number;
  /** Distance from the top of the list to the start of a row. */
  offsetOf: (index: number) => number;
  /**
   * Ref for one rendered row, taken by row identity. Rows report their real
   * height back through the observer this registers with, which is what keeps the
   * offsets honest when a row's content reflows (a chip row wrapping at 320px) or
   * when it is first rendered at all.
   */
  measureRow: (key: RowKey) => (element: HTMLElement | null) => void;
};

export function useVirtualRows(
  totalCount: number,
  containerRef?: RefObject<HTMLElement | null>,
  options: VirtualRowsOptions = {}
): VirtualRowsResult {
  const seed = options.estimatedRowHeight ?? MIN_ROW_HEIGHT;
  const overscan = options.overscan ?? 6;
  const threshold = options.threshold ?? 100;
  const selectedIndex = options.selectedIndex;
  const rowKeys = options.rowKeys;

  const isVirtual = totalCount > threshold;

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(800);
  const [offsets, setOffsets] = useState<RowOffsetModel>(createRowOffsetModel);
  const [keyedCount, setKeyedCount] = useState(totalCount);

  // Without row identity the only thing left to key a height by is the slot it
  // was measured in, so a different row count means the slots may hold rows the
  // measurements never described. Adjusting state during render is React's
  // documented pattern for state derived from a changed prop; it keeps this from
  // committing a frame of another list's geometry.
  const countChanged = !rowKeys && keyedCount !== totalCount;
  if (countChanged) {
    setKeyedCount(totalCount);
    setOffsets(createRowOffsetModel());
  }
  const model = countChanged ? createRowOffsetModel() : offsets;

  const keys = useMemo<readonly RowKey[]>(() => {
    // One key per row. A caller that hands over a list of another length would
    // otherwise index the prefix sums past their end and space the list with
    // `NaN`; falling back to positions is the behaviour an absent `rowKeys` has.
    if (rowKeys && rowKeys.length === totalCount) return rowKeys;
    return Array.from({ length: totalCount }, (_, index) => index);
  }, [rowKeys, totalCount]);
  const sums = useMemo(() => rowPrefixSums(model, keys, seed), [model, keys, seed]);

  const onMeasurements = useCallback((measurements: RowMeasurement[]) => {
    setOffsets((current) => recordRowHeights(current, measurements, seed));
  }, [seed]);
  const measureRow = useRowObserver(onMeasurements);

  const lastWidth = useRef(0);
  useEffect(() => {
    if (!isVirtual) return;

    const element = containerRef?.current;
    lastWidth.current = element?.clientWidth ?? 0;

    const handleScroll = () => {
      if (element) {
        // Row heights are a function of the width they are laid out at, so a new
        // width invalidates every measurement — including the ones for rows that
        // are not on screen to re-measure themselves. A container that reports 0
        // has not been laid out yet (a hidden tab, a stylesheet that has not
        // applied), and recording that first real width is what makes a later
        // change a change at all.
        const width = element.clientWidth;
        if (width !== 0) {
          if (lastWidth.current !== 0 && width !== lastWidth.current) setOffsets(createRowOffsetModel());
          lastWidth.current = width;
        }
      }
      if (element && element.scrollHeight > element.clientHeight) {
        setScrollTop(element.scrollTop);
        setViewportHeight(element.clientHeight);
      } else if (typeof window !== 'undefined') {
        const top = element ? element.getBoundingClientRect().top + window.scrollY : 0;
        setScrollTop(Math.max(0, window.scrollY - top));
        setViewportHeight(window.innerHeight);
      }
    };

    handleScroll();

    element?.addEventListener('scroll', handleScroll, { passive: true });
    if (typeof window === 'undefined') {
      return () => element?.removeEventListener('scroll', handleScroll);
    }
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll, { passive: true });
    return () => {
      element?.removeEventListener('scroll', handleScroll);
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
    };
  }, [isVirtual, containerRef]);

  const rowHeightOf = useCallback(
    (index: number) => rowHeightAt(model, keys[index] ?? index, seed),
    [model, keys, seed]
  );
  const offsetOf = useCallback(
    (index: number) => (index <= 0 ? 0 : sums[Math.min(index, keys.length)]),
    [sums, keys.length]
  );

  if (!isVirtual || totalCount === 0) {
    return {
      isVirtual: false,
      startIndex: 0,
      endIndex: Math.max(0, totalCount - 1),
      paddingTop: 0,
      paddingBottom: 0,
      virtualItems: Array.from({ length: totalCount }, (_, index) => index),
      rowHeightOf,
      offsetOf,
      measureRow,
    };
  }

  const startIndex = Math.max(0, indexAtOffset(sums, scrollTop) - overscan);
  const endIndex = Math.min(totalCount - 1, indexAtOffset(sums, scrollTop + viewportHeight) + overscan);

  const virtualItems: number[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    virtualItems.push(index);
  }
  if (selectedIndex !== undefined && selectedIndex >= 0 && selectedIndex < totalCount &&
    (selectedIndex < startIndex || selectedIndex > endIndex)) {
    virtualItems.push(selectedIndex);
    virtualItems.sort((left, right) => left - right);
  }

  // The space before the first rendered row and after the last one — not
  // necessarily the window's. When the highlighted row is rendered outside the
  // window, the gap before it already stands for the rows in between: starting
  // this space at `startIndex` would count those rows twice, and placing the
  // first spacer at the window's offset would move the highlighted row onto the
  // window's position and leave a hole where the window belongs.
  const paddingTop = sums[virtualItems[0] ?? 0];
  const paddingBottom = Math.max(0, sums[totalCount] - sums[(virtualItems.at(-1) ?? 0) + 1]);

  return {
    isVirtual: true,
    startIndex,
    endIndex,
    paddingTop,
    paddingBottom,
    virtualItems,
    rowHeightOf,
    offsetOf,
    measureRow,
  };
}
