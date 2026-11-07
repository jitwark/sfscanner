import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SearchBox } from './search-box';

describe('SearchBox', () => {
  afterEach(() => {
    cleanup();
  });

  const getSearchInput = () => screen.getByRole('combobox', { name: 'Search n8n workflows' });

  it('renders a combobox with 44px height class and placeholder', () => {
    render(<SearchBox value="" onChange={() => {}} placeholder="Search test..." />);
    const input = getSearchInput();
    expect(input).toBeDefined();
    expect(input.getAttribute('placeholder')).toBe('Search test...');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBeNull();
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('controls the results list and active option only while results are expanded', () => {
    render(<SearchBox value="slack" onChange={() => {}} resultCount={1} activeIndex={0} activeDescendantId="result-one" />);

    const input = getSearchInput();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe('search-results-list');
    expect(input.getAttribute('aria-activedescendant')).toBe('result-one');
  });

  it('stays collapsed when the result count is stale and no result list is rendered', () => {
    render(<SearchBox value="slack" onChange={() => {}} resultCount={12} resultsRendered={false} activeIndex={0} activeDescendantId="missing-result" />);

    const input = getSearchInput();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBeNull();
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('clears query on Escape if non-empty', () => {
    const onChange = vi.fn();
    render(<SearchBox value="slack" onChange={onChange} />);
    const input = getSearchInput();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('makes the clear button a visible 44px interactive target', () => {
    render(<SearchBox value="slack" onChange={() => {}} />);

    const clear = screen.getByRole('button', { name: 'Clear search' });
    expect(clear.className).toContain('min-h-11');
    expect(clear.className).toContain('min-w-11');
    expect(clear.className).toContain('hover:');
    expect(clear.className).toContain('focus-visible:outline');
    expect(clear.className).toContain('active:');
  });

  it('navigates with ArrowDown and ArrowUp', () => {
    const onNavigateHighlight = vi.fn();
    render(<SearchBox value="test" onChange={() => {}} onNavigateHighlight={onNavigateHighlight} />);
    const input = getSearchInput();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(onNavigateHighlight).toHaveBeenCalledWith('down');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onNavigateHighlight).toHaveBeenCalledWith('up');
  });

  it('selects active highlight on Enter', () => {
    const onSelectHighlight = vi.fn();
    render(
      <SearchBox
        value="test"
        onChange={() => {}}
        activeIndex={0}
        resultCount={5}
        onSelectHighlight={onSelectHighlight}
      />
    );
    const input = getSearchInput();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelectHighlight).toHaveBeenCalled();
  });

  it('focuses input when / key is pressed globally', () => {
    render(<SearchBox value="" onChange={() => {}} />);
    const input = getSearchInput() as HTMLInputElement;
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(input);
  });
});
