import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './button';

describe('Button', () => {
  it('renders primary variant with 2px radius and bold font', () => {
    render(<Button variant="primary">Scan Workflow</Button>);
    const btn = screen.getByRole('button', { name: 'Scan Workflow' });
    expect(btn.className).toContain('bg-accent');
    expect(btn.className).toContain('text-accent-ink');
    expect(btn.className).toContain('rounded-control');
    expect(btn.className).toContain('font-bold');
  });

  it('renders outline variant with 2px green border', () => {
    render(<Button variant="outline">Learn More</Button>);
    const btn = screen.getByRole('button', { name: 'Learn More' });
    expect(btn.className).toContain('border-2');
    expect(btn.className).toContain('border-accent-border');
    expect(btn.className).toContain('text-ink');
  });

  it('renders outline-on-dark variant', () => {
    render(<Button variant="outline-on-dark">Browse Docs</Button>);
    const btn = screen.getByRole('button', { name: 'Browse Docs' });
    expect(btn.className).toContain('border-on-band');
    expect(btn.className).toContain('text-on-band');
  });

  it('renders 44px height for size 44', () => {
    render(<Button size="44">Hero Action</Button>);
    const btn = screen.getByRole('button', { name: 'Hero Action' });
    expect(btn.className).toContain('h-11');
    expect(btn.className).toContain('px-6');
  });
});
