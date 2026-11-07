import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReplacementList } from './replacement-list';

describe('ReplacementList', () => {
  it('expands categories and lets readers reveal then collapse every value', () => {
    render(<ReplacementList values={Array.from({ length: 8 }, (_, index) => ({
      node: `Node ${index}`, field: `options.value${index}`, kind: 'url',
    }))} />);
    expect(screen.getByText('Values to replace before running')).toBeTruthy();
    const category = screen.getByText('URLs and endpoints').closest('summary')!;
    const categoryDetails = category.parentElement as HTMLDetailsElement;
    expect(category.className).toContain('min-h-11');
    expect(category.className).toContain('hover:bg-raised');
    expect(category.className).toContain('focus-visible:ring-2');
    expect(category.className).toContain('active:bg-panel');
    expect(category.className).toContain('group-open:text-accent-text');
    expect(category.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(categoryDetails.open).toBe(true);
    fireEvent.click(category);
    expect(categoryDetails.open).toBe(false);
    fireEvent.click(category);
    expect(categoryDetails.open).toBe(true);

    const showAll = screen.getByRole('button', { name: /show all values/i });
    expect(showAll.className).toContain('min-h-11');
    expect(showAll.className).toContain('hover:bg-raised');
    expect(showAll.className).toContain('focus-visible:ring-2');
    expect(showAll.className).toContain('active:bg-panel');
    expect(showAll.className).toContain('aria-expanded:bg-accent/10');
    expect(showAll.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Node 7')).toBeNull();
    fireEvent.click(showAll);
    expect(screen.getByText('Node 7')).toBeTruthy();
    expect(screen.getByRole('button', { name: /show fewer values/i }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /show fewer values/i }));
    expect(screen.queryByText('Node 7')).toBeNull();
    expect(screen.getByText(/actual values are intentionally hidden/i)).toBeTruthy();
  });
});
