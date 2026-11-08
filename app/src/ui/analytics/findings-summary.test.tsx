import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FindingsSummary } from './findings-summary';

afterEach(() => cleanup());

const noFindings = {
  totalOccurrences: 0,
  workflowsWithFindings: 0,
  cleanScanned: 0,
  noFindingsRecorded: 4,
  bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
  policies: [],
};

describe('FindingsSummary', () => {
  it('states explicitly when the release has no findings', () => {
    render(<FindingsSummary findings={noFindings} total={4} completed={0} />);

    expect(screen.getByText('No findings recorded.')).toBeTruthy();
    expect(screen.queryByText(/Most findings are low severity/)).toBeNull();
  });

  /**
   * The clean figure is a claim about scans, so it is stated against the scans
   * that completed, and the rows that merely have no finding recorded are named
   * as exactly that. Without both numbers "clean" reads as "nothing was found",
   * which is also how an entry without a clean completed scan can look.
   */
  it('denominates clean scans and labels rows without a clean completed scan', () => {
    render(
      <FindingsSummary
        findings={{
          ...noFindings,
          totalOccurrences: 9,
          workflowsWithFindings: 6,
          cleanScanned: 3,
          noFindingsRecorded: 5,
          bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, INFO: 0 },
        }}
        total={11}
        completed={4}
      />,
    );

    const copy = document.body.textContent!.replace(/\s+/g, ' ');
    expect(copy).toContain('6 of 11 workflows');
    expect(copy).toContain('54.5% flagged');
    expect(copy).toContain('3 clean of 4 complete scans');
    expect(copy).toContain('2 rows without a clean completed scan');
  });
});
