import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from './theme-toggle';

describe('ThemeToggle', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders an accessible dark-mode toggle and persists its selected theme', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    render(<ThemeToggle />);

    const button = screen.getByRole('button', { name: 'Switch to light theme' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.classList.contains('min-h-11')).toBe(true);
    expect(button.classList.contains('min-w-11')).toBe(true);
    expect(button.classList.contains('bg-accent')).toBe(true);

    fireEvent.click(button);

    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.classList.contains('bg-raised')).toBe(true);
    expect(button.classList.contains('bg-accent')).toBe(false);
    expect(window.localStorage.getItem('n8n-secureflow-theme')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('keeps the selected theme when saving the preference fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));

    const button = screen.getByRole('button', { name: 'Switch to dark theme' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByRole('status').textContent).toBe('Theme preference could not be saved.');
  });
});
