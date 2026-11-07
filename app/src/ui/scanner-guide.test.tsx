import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScannerGuide } from './scanner-guide';

describe('ScannerGuide', () => {
  it('keeps methodology out of the initial DOM and loads it on request', async () => {
    render(<ScannerGuide />);

    expect(screen.queryByRole('heading', { name: 'How to read your report' })).toBeNull();
    const trigger = screen.getByRole('button', { name: 'Read scanner methods' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.className).toContain('min-h-11');

    fireEvent.click(trigger);

    expect(await screen.findByRole('heading', { name: 'How to read your report' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'What the scanner checks' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'What it cannot tell you' })).toBeTruthy();
    expect(screen.getByText(/No high or critical risk was found/)).toBeTruthy();
    expect(screen.getByText(/does not send workflow content to a remote service/)).toBeTruthy();
    expect(screen.queryByText(/18,311-workflow corpus/)).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });
});
