import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HeroWorkflowFlare } from './hero-workflow-flare';

afterEach(() => cleanup());

describe('HeroWorkflowFlare', () => {
  it('renders abstract workflow flare with nodes and telemetry', () => {
    const { container } = render(<HeroWorkflowFlare />);
    const flare = container.querySelector('[data-hero-workflow-flare]');
    expect(flare).toBeTruthy();
    expect(flare?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Active Automation Pipeline')).toBeTruthy();
    expect(screen.getByText('Webhook')).toBeTruthy();
    expect(screen.getByText('AI Agent')).toBeTruthy();
    expect(screen.getByText('Transform')).toBeTruthy();
    expect(screen.getByText('Dispatch')).toBeTruthy();
    expect(screen.getByText(/Verified · Score 99/)).toBeTruthy();
  });
});
