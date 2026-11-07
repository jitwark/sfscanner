import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SiteHeader } from './site-header';

const pathname = vi.hoisted(() => ({ current: null as string | null }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  pathname.current = null;
});

describe('SiteHeader', () => {
  it('renders navigation links next to About', () => {
    render(<SiteHeader searchableCount={12923} />);

    expect(screen.getByRole('link', { name: /library/i })).toBeDefined();
    expect(screen.getByRole('link', { name: /scanner/i })).toBeDefined();
    expect(screen.getByRole('link', { name: /analytics/i })).toBeDefined();
    expect(screen.getByRole('link', { name: /about/i })).toBeDefined();
  });

  it('omits the repository link without configuration', () => {
    vi.stubEnv('NEXT_PUBLIC_PRODUCT_REPOSITORY_URL', '');
    render(<SiteHeader searchableCount={1} />);

    expect(screen.queryByRole('link', { name: /github/i })).toBeNull();
    expect(screen.queryByText('GitHub (private)')).toBeNull();
  });

  it('uses the configured repository link', () => {
    vi.stubEnv('NEXT_PUBLIC_PRODUCT_REPOSITORY_URL', 'https://example.test/repo');
    render(<SiteHeader searchableCount={1} />);

    const link = screen.getByRole('link', { name: 'GitHub' });
    expect(link.getAttribute('href')).toBe('https://example.test/repo');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('displays the formatted workflow count', () => {
    render(<SiteHeader searchableCount={12923} />);
    expect(screen.getByText('12,923')).toBeDefined();
    expect(screen.getByText('workflows')).toBeDefined();
  });

  it('keeps the mobile menu closed when pathname is null until opened', () => {
    const { rerender } = render(<SiteHeader searchableCount={12923} />);

    const initialButton = screen.getByRole('button', { name: 'Open menu' });
    expect(initialButton.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('navigation', { name: 'Mobile Navigation' })).toBeNull();

    pathname.current = '/library/';
    rerender(<SiteHeader searchableCount={12923} />);

    const openButton = screen.getByRole('button', { name: 'Open menu' });
    fireEvent.click(openButton);

    const closeButton = screen.getByRole('button', { name: 'Close menu' });
    expect(closeButton.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('navigation', { name: 'Mobile Navigation' })).toBeDefined();

    fireEvent.click(closeButton);

    expect(screen.getByRole('button', { name: 'Open menu' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('navigation', { name: 'Mobile Navigation' })).toBeNull();
  });
});
