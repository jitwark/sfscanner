import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UtilityBar } from './utility-bar';

describe('UtilityBar', () => {
  it('renders the utility notice and a truthful functional badge without an internal version', () => {
    render(<UtilityBar />);
    expect(screen.getByText(/zero telemetry/i)).toBeDefined();
    expect(screen.getByText('Static analysis · advisory')).toBeDefined();
    expect(document.body.textContent).not.toMatch(/\bv?\d+\.\d+\.\d+\b/i);
  });
});
