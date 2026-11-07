import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReportLoading } from './report-loading';

describe('ReportLoading', () => {
  it('exposes a deterministic bounded loading state', () => {
    render(<ReportLoading />);

    const status = screen.getByRole('status', { name: 'Preparing report' });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.className).toContain('min-h-[20rem]');
    const placeholders = status.querySelectorAll('[aria-hidden="true"]');
    expect(placeholders).toHaveLength(7);
    expect(Array.from(placeholders).every((placeholder) => placeholder.className.includes('motion-reduce:animate-none'))).toBe(true);
  });
});
