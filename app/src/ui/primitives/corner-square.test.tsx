import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CornerSquare } from './corner-square';

describe('CornerSquare', () => {
  it('renders a decorative square with aria-hidden', () => {
    const { container } = render(<CornerSquare />);
    const el = container.querySelector('[data-corner-square]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('aria-hidden')).toBe('true');
    expect(el?.className).toContain('top-0 left-0');
    expect(el?.className).toContain('w-3 h-3');
    expect(el?.className).toContain('bg-accent');
  });

  it('supports custom position and size', () => {
    const { container } = render(<CornerSquare position="bottom-right" size="lg" />);
    const el = container.querySelector('[data-corner-square]');
    expect(el?.className).toContain('bottom-0 right-0');
    expect(el?.className).toContain('w-4 h-4');
  });
});
