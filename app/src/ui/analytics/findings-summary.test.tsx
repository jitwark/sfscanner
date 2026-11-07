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

    expect(screen.getByText('No findings were recorded in this release.')).toBeTruthy();
    expect(screen.queryByText(/Most findings are low severity/)).toBeNull();
  });

  /**
   * The clean figure is a claim about scans, so it is stated against the scans
   * that completed, and the rows that merely have no finding recorded are named
   * as exactly that. Without both numbers "clean" reads as "nothing was found",
   * which is also what an entry nobody scanned looks like.
   */
  it('denominates the clean count by completed scans and separates the rows with no findings recorded', () => {
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

    const copy = screen.getByText(/carry at least one finding/).textContent!.replace(/\s+/g, ' ');
    expect(copy).toContain('6 workflows (54.5%) carry at least one finding');
    expect(copy).toContain('3 of the 4 scans that completed carry none');
    // 5 rows with no findings recorded minus the 3 clean scans.
    expect(copy).toContain('2 entries have no findings recorded but were not scanned');
    expect(copy).toContain('not counted clean');
  });
});
