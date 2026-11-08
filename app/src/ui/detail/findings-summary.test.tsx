import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry, EntrySecurity } from '@hub/contracts';
import { FindingsSummary } from './findings-summary';
import { makeEntry } from '@/src/test-support/make-entry';

afterEach(() => cleanup());

function entryWithSecurity(overrides: Partial<EntrySecurity>): Entry {
  const base = makeEntry();
  return { ...base, security: { ...base.security, ...overrides } };
}

describe('FindingsSummary', () => {
  it('keeps severity counts accessible without live-region semantics', () => {
    const entry = entryWithSecurity({
      counts: { critical: 1, high: 0, medium: 2, low: 0, info: 0 },
      analysisStatus: 'COMPLETE',
      findings: [
        { id: 'secret', title: 'Hardcoded secret', severity: 'CRITICAL', why: 'It can leak.', fix: 'Replace it.', node: 'HTTP' },
      ],
    });
    render(<FindingsSummary entry={entry} />);

    const summary = screen.getByRole('group', { name: 'Finding severity summary' });
    expect(summary.textContent).toContain('1 critical');
    expect(summary.textContent).toContain('2 medium');
    expect(summary.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(0);
  });

  it('shows the prioritized finding and its practical next step without a report link', () => {
    const entry = entryWithSecurity({
      grade: 'MEDIUM',
      score: 34,
      analysisStatus: 'DEGRADED',
      analysisDiagnosticCodes: ['SEMANTIC_CATALOGUE_MISS'],
      counts: { critical: 0, high: 0, medium: 1, low: 1, info: 0 },
      findings: [
        { id: 'code', title: 'Custom code node', severity: 'LOW', why: 'It needs review.', fix: 'Review the code path.', node: 'Code' },
        { id: 'webhook', title: 'Webhook exposure', severity: 'MEDIUM', why: 'It can be abused.', fix: 'Require authentication.', node: 'Webhook' },
      ],
    });
    const { container } = render(<FindingsSummary entry={entry} />);

    expect(screen.getByText('Webhook exposure')).toBeTruthy();
    expect(screen.getByText('Require authentication.')).toBeTruthy();
    expect(screen.getByText('Partial analysis')).toBeTruthy();
    expect(within(container).queryByRole('link', { name: /finding/i })).toBeNull();
    expect(container.querySelector('a[href*="/w/view"]')).toBeNull();
  });

  it('does not present an unknown grade as a numeric score', () => {
    const entry = entryWithSecurity({
      grade: 'UNKNOWN',
      score: 0,
      analysisStatus: 'INDETERMINATE',
    });
    const { container } = render(<FindingsSummary entry={entry} />);

    expect(screen.getByText('No score available')).toBeTruthy();
    expect(screen.getByText('Analysis incomplete')).toBeTruthy();
    expect(container.textContent).not.toMatch(/0\/100|raw 0/);
    expect(screen.getByLabelText('Scanner grade UNKNOWN, no score available')).toBeTruthy();
    expect(screen.getByText('Next step')).toBeTruthy();
  });

  it('surfaces a scanner refusal code rather than a clean-looking zero count', () => {
    const entry = entryWithSecurity({
      grade: 'UNKNOWN',
      score: 0,
      analysisStatus: 'INDETERMINATE',
      noResult: true,
      noResultCode: 'SEMANTIC_CATALOGUE_INVALID',
    });
    render(<FindingsSummary entry={entry} />);

    expect(screen.getByText('Assessment unavailable')).toBeTruthy();
    expect(screen.getByText(/SEMANTIC_CATALOGUE_INVALID/)).toBeTruthy();
    expect(screen.getByText(/no evidence-backed risk decision/i)).toBeTruthy();
    expect(screen.getByText('No score available')).toBeTruthy();
  });

  it('turns the reported ClientFlow entry into a concise review-first summary', () => {
    const entry = entryWithSecurity({
      grade: 'MEDIUM',
      score: 34,
      analysisStatus: 'DEGRADED',
      analysisDiagnosticCodes: [
        'GENERIC_NODE_UNMODELED_CAPABILITY',
        'GRAPH_ANALYSIS_DEGRADED',
        'SEMANTIC_CATALOGUE_MISS',
      ],
      counts: { critical: 0, high: 0, medium: 1, low: 1, info: 0 },
      findings: [
        {
          id: 'N8N_CODE_NODE',
          title: 'Custom code node requires security review',
          severity: 'LOW',
          why: 'Custom code is harder to audit.',
          fix: 'Review the code path and require approval.',
          node: 'Validate',
        },
        {
          id: 'WEBHOOK_EXPOSURE',
          title: 'Webhook trigger lacks clear authentication',
          severity: 'MEDIUM',
          why: 'Unauthenticated endpoints can be abused.',
          fix: 'Require webhook authentication.',
          node: 'New Client',
        },
      ],
    });
    render(<FindingsSummary entry={entry} />);

    expect(screen.getByText('Partial analysis')).toBeTruthy();
    expect(screen.getByText('Webhook trigger lacks clear authentication')).toBeTruthy();
    expect(screen.getByText('Custom code node requires security review')).toBeTruthy();
    expect(screen.getByText('Review the code path and require approval.')).toBeTruthy();
    expect(screen.getByText('Require webhook authentication.')).toBeTruthy();
    expect(screen.queryByText('Next step')).toBeNull();
    expect(screen.queryByText(/more findings? (?:is|are) listed/i)).toBeNull();
  });

  it('shows all three top-priority fixes and omits the duplicate standalone next step', () => {
    const entry = entryWithSecurity({
      grade: 'HIGH',
      score: 41,
      analysisStatus: 'COMPLETE',
      counts: { critical: 0, high: 1, medium: 2, low: 0, info: 0 },
      findings: [
        { id: 'first', title: 'First finding', severity: 'HIGH', why: 'Needs review.', fix: 'Apply the first fix.', node: 'A' },
        { id: 'second', title: 'Second finding', severity: 'MEDIUM', why: 'Needs review.', fix: 'Apply the second fix.', node: 'B' },
        { id: 'third', title: 'Third finding', severity: 'MEDIUM', why: 'Needs review.', fix: 'Apply the third fix.', node: 'C' },
      ],
    });
    render(<FindingsSummary entry={entry} />);

    expect(screen.getByText('Apply the first fix.')).toBeTruthy();
    expect(screen.getByText('Apply the second fix.')).toBeTruthy();
    expect(screen.getByText('Apply the third fix.')).toBeTruthy();
    expect(screen.queryByText('Next step')).toBeNull();
    expect(screen.queryByText(/more findings? (?:is|are) listed/i)).toBeNull();
  });
});
