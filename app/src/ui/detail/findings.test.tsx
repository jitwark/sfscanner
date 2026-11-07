import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Findings } from './findings';
import { makeEntry } from '@/src/test-support/make-entry';

describe('Findings', () => {
  it('makes critical and high findings prominent with a severity summary', () => {
    const entry = makeEntry({ security: { counts: { critical: 1, high: 1, medium: 0, low: 0, info: 0 }, findings: [
      { id: 'secret', title: 'Hardcoded secret', severity: 'CRITICAL', why: 'It can leak.', fix: 'Replace it.', node: 'HTTP' },
      { id: 'http', title: 'Untrusted request', severity: 'HIGH', why: 'It can be abused.', fix: 'Validate it.', node: 'Webhook' },
    ] } });
    render(<Findings entry={entry} />);
    expect(screen.getByText('Security summary')).toBeTruthy();
    const severitySummary = screen.getByRole('group', { name: 'Finding severity summary' });
    expect(severitySummary.textContent).toContain('1 critical');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('region', { name: /priority security findings/i })).toBeTruthy();

    const allFindingsSummary = screen.getByText('View all findings (2)').closest('summary')!;
    const allFindings = allFindingsSummary.parentElement as HTMLDetailsElement;
    expect(allFindingsSummary.className).toContain('min-h-11');
    expect(allFindingsSummary.className).toContain('focus-visible:ring-2');
    expect(allFindingsSummary.className).toContain('active:bg-panel');
    expect(allFindingsSummary.className).toContain('group-open/findings:bg-raised');
    expect(allFindingsSummary.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(allFindings.open).toBe(false);
    fireEvent.click(allFindingsSummary);
    expect(allFindings.open).toBe(true);

    const findingSummary = within(allFindings).getByText('Hardcoded secret').closest('summary')!;
    expect(findingSummary.className).toContain('min-h-11');
    expect(findingSummary.className).toContain('hover:bg-raised');
    expect(findingSummary.className).toContain('group-open/finding:bg-raised');
    const findingDetails = findingSummary.parentElement as HTMLDetailsElement;
    expect(findingDetails.open).toBe(true);
    fireEvent.click(findingSummary);
    expect(findingDetails.open).toBe(false);

    fireEvent.click(allFindingsSummary);
    expect(allFindings.open).toBe(false);
  });
});
