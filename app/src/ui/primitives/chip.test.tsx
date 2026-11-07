import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LicenceBadge } from './badge';
import { Chip } from './chip';

describe('LicenceBadge', () => {
  it('renders licence label with 2px radius and uppercase text', () => {
    render(<LicenceBadge licence="MIT" />);
    const el = screen.getByText('MIT');
    expect(el.className).toContain('rounded-badge');
    expect(el.className).toContain('uppercase');
  });
});

describe('Chip', () => {
  it('renders default chip with 2px radius', () => {
    render(<Chip>Automation</Chip>);
    const el = screen.getByText('Automation');
    expect(el.className).toContain('rounded-control');
  });

  it('renders active chip with inverted high-contrast styling', () => {
    render(<Chip active>Active Tab</Chip>);
    const el = screen.getByText('Active Tab');
    expect(el.className).toContain('bg-ink');
    expect(el.className).toContain('text-page');
  });
});
