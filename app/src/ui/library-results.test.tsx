import { cleanup, render, screen, act, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LibraryResults } from './library-results';
import { MIN_ROW_HEIGHT } from './row-offsets';

afterEach(cleanup);

function libraryItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `result-${index}`,
    slug: `result-${index}`,
    title: `Result ${index}`,
    summary: '',
    integrations: [],
    tags: [],
    triggers: [],
    capabilities: [],
    grade: 'LOW' as const,
    rights: 'redistributable' as const,
    complexity: 'simple' as const,
    nodeCount: 1,
  }));
}

/** The heights the list reserved, in document order. */
function spacerPixels(list: HTMLElement): number[] {
  return Array.from(list.querySelectorAll('li[aria-hidden="true"]'))
    .map((spacer) => Number.parseFloat((spacer as HTMLElement).style.height));
}

describe('LibraryResults', () => {
  it('mounts a semantic list of every result for assistive technology', () => {
    render(<LibraryResults loading={false} activeIndex={-1} items={libraryItems(2)} />);

    expect(screen.getByRole('list', { name: 'Workflow results' })).toBeDefined();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('bounds mounted cards for a long result window and retains the highlighted row', () => {
    render(<LibraryResults loading={false} activeIndex={150} items={libraryItems(200)} />);

    expect(screen.getByText('Result 150')).toBeDefined();
    expect(screen.queryByText('Result 100')).toBeNull();
    // A bounded window plus the highlighted row — not all 200 cards.
    const mounted = screen.getAllByRole('article').length;
    expect(mounted).toBeGreaterThan(4);
    expect(mounted).toBeLessThan(24);
  });

  it('spaces unmeasured rows at the declared floor below the window', () => {
    const { container, rerender } = render(<LibraryResults loading activeIndex={-1} items={[]} />);
    expect((container.querySelector('.animate-pulse') as HTMLElement).style.height).toBe(`${MIN_ROW_HEIGHT}px`);

    rerender(<LibraryResults loading={false} activeIndex={-1} items={libraryItems(200)} />);

    // Nothing has been measured in jsdom, so every row the list has not rendered
    // stands in at the floor: 200 rows, 13 of them rendered.
    const list = screen.getByRole('list', { name: 'Workflow results' });
    expect(list.lastElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(spacerPixels(list)).toEqual([(200 - 13) * MIN_ROW_HEIGHT]);
  });

  it('accounts for the rows a highlighted row outside the window skips, exactly once', () => {
    render(<LibraryResults loading={false} activeIndex={150} items={libraryItems(200)} />);

    const list = screen.getByRole('list', { name: 'Workflow results' });
    const spacerHeights = spacerPixels(list);
    const renderedRows = list.querySelectorAll('li:not([aria-hidden="true"])').length;

    // The window's 13 rows, the highlighted row, and one spacer for each of the
    // rows in between or after — never two spacers over the same rows.
    expect(renderedRows).toBe(14);
    expect(spacerHeights).toEqual([(150 - 13) * MIN_ROW_HEIGHT, (200 - 151) * MIN_ROW_HEIGHT]);
    expect(spacerHeights.reduce((total, height) => total + height, 0)).toBe((200 - renderedRows) * MIN_ROW_HEIGHT);
  });

  it('places a highlighted row above the window at its own offset', () => {
    render(<LibraryResults loading={false} activeIndex={5} items={libraryItems(200)} />);

    // jsdom lays nothing out, so the list is told what a browser would have said:
    // a 400px-tall scroller showing 20000px of content, scrolled to row 41.
    const list = screen.getByRole('list', { name: 'Workflow results' }) as HTMLUListElement;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 20_000 },
    });
    list.scrollTop = 5_520;
    act(() => fireEvent.scroll(list));

    // Row 5 first, at its own offset — not at the window's — then the rows it
    // skipped to reach the window, then only what follows the window.
    const spacerHeights = spacerPixels(list);
    expect(spacerHeights).toEqual([5 * MIN_ROW_HEIGHT, (41 - 6) * MIN_ROW_HEIGHT, (200 - 57) * MIN_ROW_HEIGHT]);
    const renderedRows = list.querySelectorAll('li:not([aria-hidden="true"])').length;
    expect(renderedRows).toBe(17);
    expect(spacerHeights.reduce((total, height) => total + height, 0)).toBe((200 - renderedRows) * MIN_ROW_HEIGHT);
  });
});
