// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryAlternatives } from './library-alternatives';

afterEach(() => cleanup());

describe('LibraryAlternatives', () => {
  it('loads alias suggestions after the zero-result surface renders', async () => {
    const onSelect = vi.fn();
    render(<LibraryAlternatives query="email ai" onSelect={onSelect} />);

    expect(screen.queryByText('Try')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'gmail' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'gmail' }));
    expect(onSelect).toHaveBeenCalledWith('gmail');
  });

  it('renders no optional surface when the query has no aliases', async () => {
    render(<LibraryAlternatives query="" onSelect={() => undefined} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Try')).toBeNull();
  });
});
