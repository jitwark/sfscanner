import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, renderHook } from '@testing-library/react';
import { MIN_ROW_HEIGHT } from './row-offsets';
import { useVirtualRows } from './use-virtual-rows';

/**
 * jsdom lays nothing out, so the only way a row height can arrive is through the
 * observer. This stands in for it and delivers exactly the entries a real one
 * would: one per observed element whose box changed.
 */
class FakeResizeObserver {
  static live: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.live.push(this);
  }
  static latest(): FakeResizeObserver {
    const observer = FakeResizeObserver.live.at(-1);
    if (!observer) throw new Error('no ResizeObserver was constructed');
    return observer;
  }
  observe(element: Element): void {
    this.observed.add(element);
  }
  unobserve(element: Element): void {
    this.observed.delete(element);
  }
  disconnect(): void {
    this.observed.clear();
    FakeResizeObserver.live = FakeResizeObserver.live.filter((observer) => observer !== this);
  }
  emit(heights: Array<readonly [Element, number]>): void {
    const entries = heights
      .filter(([element]) => this.observed.has(element))
      .map(([target, blockSize]) => ({ target, borderBoxSize: [{ blockSize, inlineSize: 0 }] }));
    if (entries.length === 0) return;
    this.callback(entries as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
}

beforeEach(() => {
  FakeResizeObserver.live = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function scrollableContainer(clientHeight: number, clientWidth = 768) {
  const container = document.createElement('div');
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: clientHeight },
    clientWidth: { configurable: true, value: clientWidth },
    scrollHeight: { configurable: true, writable: true, value: 0 },
  });
  return container;
}

const rowKeys = Array.from({ length: 200 }, (_, index) => `result-${index}`);

describe('useVirtualRows', () => {
  it('disables virtualization when totalCount <= threshold (default 100)', () => {
    const { result } = renderHook(() => useVirtualRows(50));
    expect(result.current.isVirtual).toBe(false);
    expect(result.current.startIndex).toBe(0);
    expect(result.current.endIndex).toBe(49);
    expect(result.current.virtualItems.length).toBe(50);
    expect(result.current.paddingTop).toBe(0);
    expect(result.current.paddingBottom).toBe(0);
  });

  it('engages virtualization when totalCount > 100', () => {
    const { result } = renderHook(() => useVirtualRows(200));
    // scrollTop 0 and no scrolling container, so the viewport is the window's
    // (768 in jsdom). At the 117px floor, row 6 (702-819) is the last row the
    // viewport reaches -> overscan 6 -> 12.
    expect(result.current.startIndex).toBe(0);
    expect(result.current.endIndex).toBe(12);
    expect(result.current.virtualItems.length).toBe(13);
    expect(result.current.paddingTop).toBe(0);
    expect(result.current.paddingBottom).toBe((200 - 13) * MIN_ROW_HEIGHT);
  });

  it('honors custom threshold and overscan options', () => {
    const { result } = renderHook(() =>
      useVirtualRows(50, undefined, { threshold: 30, overscan: 2, estimatedRowHeight: 100 })
    );
    expect(result.current.isVirtual).toBe(true);
    // Viewport 768 (the window's), 100px rows -> row 7 (700-800) is the last
    // row it reaches -> overscan 2 -> 9.
    expect(result.current.endIndex).toBe(9);
    expect(result.current.paddingBottom).toBe((49 - 9) * 100);
  });

  it('tracks a container that becomes scrollable after the first render', () => {
    const container = scrollableContainer(400);
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 20000 });
    const containerRef = { current: container };
    const { result } = renderHook(() => useVirtualRows(200, containerRef));

    expect(result.current.startIndex).toBe(0);
    container.scrollTop = 5_520;

    act(() => fireEvent.scroll(container));

    expect(result.current.startIndex).toBe(41);
    expect(result.current.paddingTop).toBe(41 * MIN_ROW_HEIGHT);
    expect(result.current.virtualItems).toContain(41);
  });

  it('takes a reflowed row height and leaves the rows above it alone', () => {
    const { result } = renderHook(() => useVirtualRows(200, undefined, { rowKeys }));
    const observer = FakeResizeObserver.latest();
    const row = document.createElement('li');
    act(() => { result.current.measureRow('result-3')(row); });
    expect(observer.observed.has(row)).toBe(true);
    expect(result.current.rowHeightOf(3)).toBe(MIN_ROW_HEIGHT);

    // The chip row wrapping at 320px, or the first layout of a row that had
    // never been rendered: the row reports its own height.
    act(() => observer.emit([[row, 300]]));
    expect(result.current.rowHeightOf(3)).toBe(300);
    expect(result.current.offsetOf(3)).toBe(3 * MIN_ROW_HEIGHT);
    expect(result.current.offsetOf(4)).toBe(3 * MIN_ROW_HEIGHT + 300);
    expect(result.current.rowHeightOf(2)).toBe(MIN_ROW_HEIGHT);

    // And again, when the same row reflows at another width.
    act(() => observer.emit([[row, 250]]));
    expect(result.current.rowHeightOf(3)).toBe(250);
    expect(result.current.offsetOf(4)).toBe(3 * MIN_ROW_HEIGHT + 250);
  });

  it('keeps a measured height after the row leaves the window', () => {
    const { result } = renderHook(() => useVirtualRows(200, undefined, { rowKeys }));
    const observer = FakeResizeObserver.latest();
    const row = document.createElement('li');
    act(() => { result.current.measureRow('result-3')(row); });
    act(() => observer.emit([[row, 300]]));

    act(() => { result.current.measureRow('result-3')(null); });

    expect(observer.observed.has(row)).toBe(false);
    // The row is out of the DOM but still in the list: its height is what the
    // rows below it are spaced from.
    expect(result.current.rowHeightOf(3)).toBe(300);
    expect(result.current.offsetOf(4)).toBe(3 * MIN_ROW_HEIGHT + 300);
  });

  it('ignores a row that reports no height at all', () => {
    const { result } = renderHook(() => useVirtualRows(200, undefined, { rowKeys }));
    const observer = FakeResizeObserver.latest();
    const row = document.createElement('li');
    act(() => { result.current.measureRow('result-1')(row); });
    act(() => observer.emit([[row, 0]]));

    expect(result.current.rowHeightOf(1)).toBe(MIN_ROW_HEIGHT);
  });

  it('carries measurements across an appended page and drops the ones for another result set', () => {
    const { result, rerender } = renderHook(
      ({ keys }: { keys: readonly string[] }) => useVirtualRows(keys.length, undefined, { rowKeys: keys }),
      { initialProps: { keys: rowKeys.slice(0, 120) } }
    );
    const observer = FakeResizeObserver.latest();
    const row = document.createElement('li');
    act(() => { result.current.measureRow('result-0')(row); });
    act(() => observer.emit([[row, 300]]));
    expect(result.current.offsetOf(1)).toBe(300);

    // "Load more": 24 rows appended, the first 120 untouched. Every height that
    // was measured still describes the row it was measured from.
    rerender({ keys: rowKeys.slice(0, 144) });
    expect(result.current.offsetOf(1)).toBe(300);
    // A measured row is a taller row, so the window covers fewer of them: 12
    // rather than the 13 the floor alone would have fitted into the viewport.
    expect(result.current.endIndex).toBe(11);
    // Everything after the window stands at the floor; row 0's measured height is
    // above it and does not show up here.
    expect(result.current.paddingBottom).toBe((144 - 12) * MIN_ROW_HEIGHT);

    // A different result set: the old rows are gone, so their heights are gone
    // with them rather than applied to whatever now sits at those indices.
    rerender({ keys: ['a', 'b', 'c'] });
    expect(result.current.rowHeightOf(0)).toBe(MIN_ROW_HEIGHT);
    expect(result.current.offsetOf(1)).toBe(MIN_ROW_HEIGHT);
  });

  it('places a highlighted row below the window without double-counting the rows between', () => {
    const { result } = renderHook(() => useVirtualRows(200, undefined, { rowKeys, selectedIndex: 150 }));
    // Window [0..12] at the top, plus the highlighted row: the space between them
    // belongs to the gap before row 150, and the trailing space only to what
    // follows it. Rendering both spans would count rows 13..150 twice.
    expect(result.current.virtualItems).toEqual([...Array.from({ length: 13 }, (_, index) => index), 150]);
    expect(result.current.paddingTop).toBe(0);
    expect(result.current.paddingBottom).toBe((200 - 151) * MIN_ROW_HEIGHT);
    expect(result.current.offsetOf(result.current.virtualItems[0]!)).toBe(0);
  });

  it('places a highlighted row above the window at its own offset', () => {
    const container = scrollableContainer(400);
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 20000 });
    const containerRef = { current: container };
    const { result } = renderHook(() => useVirtualRows(200, containerRef, { rowKeys, selectedIndex: 5 }));
    container.scrollTop = 5_520;
    act(() => fireEvent.scroll(container));

    // Window [41..56]; row 5 is rendered because it is highlighted. The space
    // before it is *its* offset, not the window's: rendering sums[41] first would
    // push row 5 down to row 41's position and re-place row 41 after the gap.
    expect(result.current.virtualItems.slice(0, 2)).toEqual([5, 41]);
    expect(result.current.paddingTop).toBe(5 * MIN_ROW_HEIGHT);
    expect(result.current.paddingBottom).toBe((200 - 57) * MIN_ROW_HEIGHT);
    // Where the DOM ends up: row 41 sits at its own offset.
    const placed = result.current.paddingTop + result.current.rowHeightOf(5) + (result.current.offsetOf(41) - result.current.offsetOf(6));
    expect(placed).toBe(result.current.offsetOf(41));
  });

  it('keeps a measured height when a remounted row reports the placeholder', () => {
    const { result } = renderHook(() => useVirtualRows(200, undefined, { rowKeys }));
    const observer = FakeResizeObserver.latest();
    const row = document.createElement('li');
    act(() => { result.current.measureRow('result-3')(row); });
    act(() => observer.emit([[row, 300]]));
    expect(result.current.offsetOf(4)).toBe(3 * MIN_ROW_HEIGHT + 300);

    // The row leaves the window and comes back: React mounts a new element, the
    // browser has no remembered size for it, and a deferred row is laid out at
    // the floor. The model keeps what it measured.
    act(() => { result.current.measureRow('result-3')(null); });
    const remounted = document.createElement('li');
    act(() => { result.current.measureRow('result-3')(remounted); });
    act(() => observer.emit([[remounted, MIN_ROW_HEIGHT]]));

    expect(result.current.rowHeightOf(3)).toBe(300);
    expect(result.current.offsetOf(4)).toBe(3 * MIN_ROW_HEIGHT + 300);
  });

  it('records a container width that was zero on mount, then re-seeds on a real change', () => {
    const container = scrollableContainer(600, 0);
    const containerRef = { current: container };
    const { result } = renderHook(() => useVirtualRows(200, containerRef, { rowKeys }));
    const observer = FakeResizeObserver.latest();
    const row = document.createElement('li');
    act(() => { result.current.measureRow('result-2')(row); });
    act(() => observer.emit([[row, 320]]));
    expect(result.current.rowHeightOf(2)).toBe(320);

    // Laid out for the first time: there is nothing to invalidate, but the width
    // has to be recorded or no later change can ever be a change.
    act(() => {
      Object.defineProperty(container, 'clientWidth', { configurable: true, value: 768 });
      fireEvent.scroll(container);
    });
    expect(result.current.rowHeightOf(2)).toBe(320);

    act(() => {
      Object.defineProperty(container, 'clientWidth', { configurable: true, value: 320 });
      fireEvent.scroll(container);
    });
    expect(result.current.rowHeightOf(2)).toBe(MIN_ROW_HEIGHT);
  });

  it('re-seeds the list when its width changes', () => {
    const container = scrollableContainer(600, 768);
    const containerRef = { current: container };
    const { result } = renderHook(() => useVirtualRows(200, containerRef, { rowKeys }));
    const observer = FakeResizeObserver.latest();
    const row = document.createElement('li');
    act(() => { result.current.measureRow('result-2')(row); });
    act(() => observer.emit([[row, 320]]));
    expect(result.current.rowHeightOf(2)).toBe(320);

    // Rows are laid out at the width they are given, so every height measured at
    // the old width describes a layout that no longer exists.
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 320 });
    act(() => fireEvent.scroll(container));

    expect(result.current.rowHeightOf(2)).toBe(MIN_ROW_HEIGHT);
  });
});
