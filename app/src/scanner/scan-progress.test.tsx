import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScanProgress, formatElapsed } from './scan-progress';

const START = 1_000_000;

function renderProgress(overrides: Partial<Parameters<typeof ScanProgress>[0]> = {}) {
  const onCancel = vi.fn();
  const view = render(
    <ScanProgress label="Analyzing workflow topology…" pct={60} startedAt={START} now={() => START} onCancel={onCancel} {...overrides} />,
  );
  return { onCancel, view };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ScanProgress', () => {
  it('states the phase in text, not only as a spinner, and reports progress', () => {
    renderProgress();

    const label = screen.getByText('Analyzing workflow topology…');
    expect(label.closest('[aria-busy="true"]')).toBeTruthy(); // the busy container
    expect(screen.getByRole('progressbar', { name: 'Scan progress' }).getAttribute('aria-valuenow')).toBe('60');
    // The only visual "loading" cue besides the text is decorative.
    expect(document.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('clamps a percentage that leaves the 0-100 range before exposing it', () => {
    renderProgress({ pct: 140 });

    expect(screen.getByRole('progressbar', { name: 'Scan progress' }).getAttribute('aria-valuenow')).toBe('100');
  });

  it('ticks from the injected clock across progress re-renders and stops the interval on unmount', () => {
    vi.useFakeTimers();
    let clock = START;
    const { view } = renderProgress({ now: () => clock });
    expect(screen.getByRole('timer').textContent).toBe('0:00');

    clock += 600;
    act(() => { vi.advanceTimersByTime(600); });
    // Every progress message re-renders with a fresh inline clock prop: the tick
    // must survive that instead of being cleared and rescheduled.
    view.rerender(<ScanProgress label="Preparing findings…" pct={90} startedAt={START} now={() => clock} onCancel={vi.fn()} />);
    clock += 600;
    act(() => { vi.advanceTimersByTime(600); });

    expect(screen.getByRole('timer').textContent).toBe('0:01');
    view.unmount();
    expect(vi.getTimerCount()).toBe(0); // no interval outlives the surface
  });

  it('keeps the ticking clock out of live regions and cancels from the keyboard', () => {
    const { onCancel } = renderProgress({ label: 'Preparing findings…', pct: 90 });

    expect(screen.getByRole('timer').closest('[aria-live], [role="status"], [role="alert"]')).toBeNull();

    const cancel = screen.getByRole('button', { name: 'Cancel scan' });
    cancel.focus();
    expect(document.activeElement).toBe(cancel);
    expect(cancel.className).toContain('focus-visible:outline-2'); // Button primitive's visible focus ring
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('formats elapsed time without negatives or rolled-over seconds', () => {
    expect(formatElapsed(-5)).toBe('0:00');
    expect(formatElapsed(65_000)).toBe('1:05');
  });
});
