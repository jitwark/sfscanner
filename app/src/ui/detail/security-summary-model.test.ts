import { describe, expect, it } from 'vitest';
import type { EntrySecurity, PublicFinding } from '@hub/contracts';
import { makeSecurity } from '../../test-support/make-entry';
import { securitySummary, severityTag } from './security-summary-model';

function security(overrides: Partial<EntrySecurity> = {}): EntrySecurity {
  return { ...makeSecurity(), ...overrides };
}

const finding = (
  id: string,
  severity: PublicFinding['severity'],
  title: string,
): PublicFinding => ({
  id,
  severity,
  title,
  why: `${title} matters.`,
  fix: `Resolve ${title}.`,
  node: `${title} node`,
});

describe('securitySummary', () => {
  it('keeps the raw grade and score for a complete assessment', () => {
    const summary = securitySummary(security({
      grade: 'MEDIUM',
      score: 34,
      analysisStatus: 'COMPLETE',
      findings: [finding('webhook', 'MEDIUM', 'Webhook exposure')],
      counts: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
    }));

    expect(summary.grade).toBe('MEDIUM');
    expect(summary.score).toBe(34);
    expect(summary.scoreLabel).toBe('34/100');
    expect(summary.gradeAriaLabel).toBe('Scanner grade MEDIUM, score 34 out of 100');
    expect(summary.statusLabel).toBe('Analysis complete');
    expect(summary.statusMessage).toMatch(/not proof of safety/i);
  });

  it('labels degraded analysis as partial and does not imply complete coverage', () => {
    const summary = securitySummary(security({
      grade: 'LOW',
      score: 20,
      analysisStatus: 'DEGRADED',
      analysisDiagnosticCodes: ['SEMANTIC_CATALOGUE_MISS'],
    }));

    expect(summary.statusLabel).toBe('Partial analysis');
    expect(summary.statusTone).toBe('warning');
    expect(summary.statusMessage).toMatch(/reflect only what was assessed/i);
    expect(summary.nextStep).toMatch(/empty finding list does not prove safety/i);
  });

  it('does not infer completeness when the persisted analysis status is absent', () => {
    const summary = securitySummary(security({
      grade: 'MEDIUM',
      score: 34,
      analysisStatus: undefined,
    }));

    expect(summary.statusLabel).toBe('Partial analysis');
    expect(summary.statusMessage).toMatch(/not recognised/i);
    expect(summary.nextStep).toMatch(/unassessed behavior/i);
  });

  it('shows no numeric score for an unknown grade', () => {
    const summary = securitySummary(security({
      grade: 'UNKNOWN',
      score: 0,
      analysisStatus: 'INDETERMINATE',
      findings: [finding('code', 'LOW', 'Code review')],
    }));

    expect(summary.knownGrade).toBe(false);
    expect(summary.scoreAvailable).toBe(false);
    expect(summary.score).toBe(0);
    expect(summary.scoreLabel).toBe('No score available');
    expect(summary.gradeAriaLabel).toBe('Scanner grade UNKNOWN, no score available');
    expect(summary.gradeAriaLabel).not.toMatch(/raw|0 out of 100/);
    expect(summary.statusLabel).toBe('Analysis incomplete');
    expect(summary.meaning).toMatch(/not a clean result or a safety verdict/i);
  });

  it('calls out a scanner refusal by its published code', () => {
    const summary = securitySummary(security({
      grade: 'UNKNOWN',
      score: 0,
      analysisStatus: 'INDETERMINATE',
      noResult: true,
      noResultCode: 'SEMANTIC_CATALOGUE_INVALID',
    }));

    expect(summary.statusLabel).toBe('Assessment unavailable');
    expect(summary.statusTone).toBe('warning');
    expect(summary.statusMessage).toContain('SEMANTIC_CATALOGUE_INVALID');
    expect(summary.meaning).toMatch(/no evidence-backed risk decision/i);
    expect(summary.nextStep).toMatch(/resolve the reported scanner limitation/i);
    expect(summary.scoreAvailable).toBe(false);
    expect(summary.scoreLabel).toBe('No score available');
  });

  it('distinguishes a source that could not be re-acquired from a clean scan', () => {
    const summary = securitySummary(security({
      grade: 'UNKNOWN',
      score: 0,
      scannerVersion: 'not-scanned',
      stampReason: 'source_unavailable',
    }));

    expect(summary.statusLabel).toBe('Assessment unavailable');
    expect(summary.statusMessage).toMatch(/could not be re-acquired/i);
    expect(summary.nextStep).toMatch(/re-acquire the source workflow/i);
  });

  it('sorts findings by severity and keeps the top three actionable', () => {
    const summary = securitySummary(security({
      grade: 'HIGH',
      score: 61,
      findings: [
        finding('low', 'LOW', 'Low item'),
        finding('high', 'HIGH', 'High item'),
        finding('critical', 'CRITICAL', 'Critical item'),
        finding('medium', 'MEDIUM', 'Medium item'),
      ],
      counts: { critical: 1, high: 1, medium: 1, low: 1, info: 0 },
    }));

    expect(summary.priorityFindings.map((item) => item.id)).toEqual(['critical', 'high', 'medium']);
    expect(summary.remainingFindings.map((item) => item.id)).toEqual(['low']);
    expect(summary.nextStep).toBe('Resolve Critical item.');
  });

  it('gives a practical review step when a complete scan reports nothing', () => {
    const summary = securitySummary(security({
      grade: 'LOW',
      score: 10,
      analysisStatus: 'COMPLETE',
    }));

    expect(summary.totalFindings).toBe(0);
    expect(summary.nextStep).toMatch(/review credentials, permissions, and downstream write actions/i);
    expect(summary.meaning).toMatch(/not proof of safety/i);
  });

  it('renders INFO as info rather than as an unknown grade', () => {
    expect(severityTag('INFO')).toMatchObject({
      label: 'INFO',
      className: expect.stringContaining('text-ink-muted'),
    });
  });
});
