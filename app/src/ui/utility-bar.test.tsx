import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UtilityBar } from './utility-bar';

describe('UtilityBar', () => {
  it('renders utility notice and version indicator', () => {
    render(<UtilityBar />);
    expect(screen.getByText(/zero telemetry/i)).toBeDefined();
    expect(screen.getByText(/v0\.1\.0/i)).toBeDefined();
  });
});
