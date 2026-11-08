import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry, EntrySecurity } from '@hub/contracts';
import { Findings } from './findings';
import { makeEntry } from '@/src/test-support/make-entry';

afterEach(() => cleanup());

function entryWithSecurity(overrides: Partial<EntrySecurity>): Entry {
  const base = makeEntry();
  return { ...base, security: { ...base.security, ...overrides } };
}

describe('Findings', () => {
  it('prioritizes the top three findings and keeps the remaining report expandable', () => {
    const entry = entryWithSecurity({
      grade: 'HIGH',
      score: 61,
      analysisStatus: 'DEGRADED',
      analysisDiagnosticCodes: ['SEMANTIC_CATALOGUE_MISS'],
      counts: { critical: 1, high: 1, medium: 1, low: 2, info: 0 },
      findings: [
        { id: 'low-code', title: 'Code review', severity: 'LOW', why: 'Code needs review.', fix: 'Review the code.', node: 'Code' },
        { id: 'secret', title: 'Hardcoded secret', severity: 'CRITICAL', why: 'It can leak.', fix: 'Replace it.', node: 'HTTP' },
        { id: 'dep', title: 'Community package', severity: 'LOW', why: 'It is external.', fix: 'Check the package.', node: 'Package' },
        { id: 'http', title: 'Untrusted request', severity: 'HIGH', why: 'It can be abused.', fix: 'Validate it.', node: 'Webhook' },
        { id: 'webhook', title: 'Webhook exposure', severity: 'MEDIUM', why: 'It is open.', fix: 'Require authentication.', node: 'Webhook' },
      ],
    });
    render(<Findings entry={entry} />);

    expect(screen.getByText('Security summary')).toBeTruthy();
    expect(screen.getByText('Partial analysis')).toBeTruthy();

    const severitySummary = screen.getByRole('group', { name: 'Finding severity summary' });
    expect(severitySummary.textContent).toContain('1 critical');
    expect(severitySummary.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(0);

    const priority = screen.getByRole('region', { name: /priority security findings/i });
    expect(within(priority).getByText('Hardcoded secret')).toBeTruthy();
    expect(within(priority).getByText('Untrusted request')).toBeTruthy();
    expect(within(priority).getByText('Webhook exposure')).toBeTruthy();
    expect(within(priority).getByText(/Replace it\./)).toBeTruthy();
    expect(within(priority).queryByText('Code review')).toBeNull();

    const remainingSummary = screen.getByText('View remaining 2 findings').closest('summary')!;
    const remaining = remainingSummary.parentElement as HTMLDetailsElement;
    expect(remainingSummary.className).toContain('min-h-11');
    expect(remainingSummary.className).toContain('focus-visible:ring-2');
    expect(remaining.open).toBe(false);
    fireEvent.click(remainingSummary);
    expect(remaining.open).toBe(true);

    const findingSummary = within(remaining).getByText('Code review').closest('summary')!;
    expect(findingSummary.className).toContain('min-h-11');
    const findingDetails = findingSummary.parentElement as HTMLDetailsElement;
    expect(findingDetails.open).toBe(false);
    fireEvent.click(findingSummary);
    expect(findingDetails.open).toBe(true);
    expect(within(findingDetails).getByText('Review the code.')).toBeTruthy();
  });

  it('shows no score for an unknown grade and names the refusal code', () => {
    const entry = entryWithSecurity({
      grade: 'UNKNOWN',
      score: 0,
      analysisStatus: 'INDETERMINATE',
      noResult: true,
      noResultCode: 'SEMANTIC_CATALOGUE_INVALID',
    });
    const { container } = render(<Findings entry={entry} />);

    expect(screen.getByText('No score available')).toBeTruthy();
    expect(screen.getByText('Assessment unavailable')).toBeTruthy();
    expect(screen.getByText(/SEMANTIC_CATALOGUE_INVALID/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/0\/100|raw 0/);
  });

  it('does not turn an empty finding list into a clean or complete claim', () => {
    const entry = entryWithSecurity({
      grade: 'LOW',
      score: 10,
      analysisStatus: 'COMPLETE',
    });
    render(<Findings entry={entry} />);

    expect(screen.getByText(/no individual findings were published/i)).toBeTruthy();
    expect(screen.getByText(/not proof of safety or of complete runtime coverage/i)).toBeTruthy();
  });
});
