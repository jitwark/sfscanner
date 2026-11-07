import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FindingsSummary } from './findings-summary';
import { makeEntry } from '@/src/test-support/make-entry';

describe('FindingsSummary', () => {
  it('keeps permanent severity counts accessible without live-region semantics', () => {
    const entry = makeEntry({ security: { counts: { critical: 1, high: 0, medium: 2, low: 0, info: 0 }, findings: [
      { id: 'secret', title: 'Hardcoded secret', severity: 'CRITICAL', why: 'It can leak.', fix: 'Replace it.', node: 'HTTP' },
    ] } });
    render(<FindingsSummary entry={entry} interactiveHref="/w/one/" />);

    const summary = screen.getByRole('group', { name: 'Finding severity summary' });
    expect(summary.textContent).toContain('1 critical');
    expect(summary.textContent).toContain('2 medium');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
