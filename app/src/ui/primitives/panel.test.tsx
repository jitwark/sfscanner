import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Panel } from './panel';

describe('Panel', () => {
  it('renders content with 2px radius and hairline border', () => {
    const { container } = render(<Panel>Content</Panel>);
    expect(screen.getByText('Content')).toBeDefined();
    const panel = container.firstChild as HTMLElement;
    expect(panel.className).toContain('rounded-panel');
    expect(panel.className).toContain('border-hairline');
  });

  it('renders corner square when requested', () => {
    const { container } = render(<Panel cornerSquare>With Corner Square</Panel>);
    const square = container.querySelector('[data-corner-square]');
    expect(square).not.toBeNull();
  });
});
