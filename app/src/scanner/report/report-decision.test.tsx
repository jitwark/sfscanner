import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SCANNER_RESULT_SCHEMA_VERSION } from '@hub/contracts';
import type { ScanWorkflowResult } from '../engine';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { ReportDecision } from './report-decision';

function result(status: ScanWorkflowResult['analysisStatus']): ScanWorkflowResult {
  return {
    schemaVersion: SCANNER_RESULT_SCHEMA_VERSION, scannerVersion: 'scanner-beta-1', policyProfile: 'beta-hardened',
    analysisStatus: status, analysisDiagnostics: [], workflow: {} as ScanWorkflowResult['workflow'],
    functionSummary: {} as ScanWorkflowResult['functionSummary'], integrations: [], findings: [],
    riskAssessment: status === 'INDETERMINATE' ? undefined : { grade: 'HIGH', score: 80, topRisks: [], dataExposure: 'Unknown', complexityDrivers: [] },
    humanSummary: { headline: 'Review', verdict: 'Advisory', plainLanguageOverview: 'Review it.', riskNarrative: 'Review it.', recommendedActions: ['Review the credential boundary.'], findingHighlights: [] },
    summary: status === 'INDETERMINATE' ? undefined : { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  };
}

function v2Scan(
  status: 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE',
  assessment: unknown,
): ScanWorkflowResult {
  const degraded = status === 'DEGRADED';
  return {
    ...result('COMPLETE'),
    assessment,
    limits: {
      usage: [],
    },
    v2: {
      schemaVersion: 'scanner-result-v2',
      limits: {
        usage: [{ id: 'workflow-nodes', maximum: 3, examined: 3, omitted: degraded ? 1 : 0, exhausted: degraded }],
      },
      analysis: {
        status,
        capabilities: [{
          id: 'workflow-insights', version: '1.0.0', required: true,
          status: status === 'INDETERMINATE' ? 'FAILED' : degraded ? 'DEGRADED' : 'COMPLETED',
          seen: 3, analyzed: degraded ? 2 : 3, skipped: 0, omitted: degraded ? 1 : 0,
          diagnosticIds: degraded ? ['diagnostic-limit'] : [],
        }],
        diagnostics: degraded ? [{
          id: 'diagnostic-limit', code: 'OPTIONAL_LIMIT_EXCEEDED', category: 'LIMIT',
          capabilityId: 'workflow-insights', aggregateEffect: 'DEGRADED', assessmentEligible: true,
          observed: 3, maximum: 3, omitted: 1,
        }] : [],
      },
    },
  } as unknown as ScannerReportModelV2;
}

const finding: ScanWorkflowResult['findings'][number] = {
  policyId: 'N8N_CODE_NODE', title: 'Code node', severity: 'LOW', location: {}, evidence: {},
  message: 'Review this node.', explanation: 'Code can change behavior.', whyItMatters: 'Review it.',
  possibleImpact: 'Unexpected behavior.', remediation: 'Review the code.', remediationSteps: [],
  confidence: 'HIGH', policyEffect: 'LEGACY_SCORE',
};

function withFinding(scan: ScanWorkflowResult): ScanWorkflowResult {
  return {
    ...scan,
    findings: [finding],
    summary: scan.summary ? { ...scan.summary, low: Math.max(1, scan.summary.low) } : scan.summary,
  };
}


describe('ReportDecision', () => {
  afterEach(() => cleanup());
  it('withholds grade, score, and reassuring wording when a v2 assessment is null', () => {
    render(<ReportDecision scan={v2Scan('COMPLETE', null)} />);

    expect(screen.getAllByText(/Assessment unavailable/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/coverage is insufficient/i).length).toBeGreaterThan(0);
    expect(screen.getByText('No score')).toBeTruthy();
    expect(screen.queryByText(/HIGH risk/)).toBeNull();
    expect(screen.queryByText(/80\/100/)).toBeNull();
    expect(screen.queryByText(/Analysis complete\./)).toBeNull();
  });

  it('renders a degraded v2 assessment with score, omissions, and report-only context', () => {
    render(<ReportDecision scan={v2Scan('DEGRADED', {
      score: 80, grade: 'HIGH', scoringPolicyVersion: '2.0.0',
      basisFindingIds: ['basis'], excludedReportOnlyFindingIds: ['report-only'],
      excludedUncertainFindingIds: [], excludedNotApplicableFindingIds: ['not-applicable'],
      unknownEvidenceCount: 0,
    })} />);

    expect(screen.getByText('HIGH risk')).toBeTruthy();
    expect(screen.getByText('80/100')).toBeTruthy();
    expect(screen.getByText(/1 omitted/)).toBeTruthy();
    expect(screen.getByText(/report-only evidence/i)).toBeTruthy();
  });
  it('uses v2 indeterminate status over legacy projected fields', () => {
    render(<ReportDecision scan={v2Scan('INDETERMINATE', null)} />);

    expect(screen.getByText('Analysis incomplete. Assessment unavailable because required analysis did not finish; no risk decision is shown.')).toBeTruthy();
    expect(screen.getByText(/Assessment unavailable because required analysis did not finish/i)).toBeTruthy();
    expect(screen.queryByText(/HIGH risk/)).toBeNull();
    expect(screen.queryByText(/analysis complete/i)).toBeNull();
  });
  it('omits decision coverage limits when nested v2 usage is empty', () => {
    const base = v2Scan('DEGRADED', {
      score: 80, grade: 'HIGH', scoringPolicyVersion: '2.0.0',
      basisFindingIds: [], excludedReportOnlyFindingIds: [],
      excludedUncertainFindingIds: [], excludedNotApplicableFindingIds: [],
      unknownEvidenceCount: 0,
    }) as unknown as ScannerReportModelV2;
    const scan = {
      ...base,
      limits: { usage: [{ id: 'legacy-limit', maximum: 99, examined: 99, omitted: 0, exhausted: false }] },
      v2: { ...base.v2, limits: { usage: [] } },
    } as unknown as ScanWorkflowResult;

    render(<ReportDecision scan={scan} />);

    expect(screen.queryByRole('list', { name: 'Decision coverage limits' })).toBeNull();
    expect(screen.queryByText(/legacy-limit/)).toBeNull();
    expect(screen.queryByText('Analysis limits are recorded.')).toBeNull();
  });

  it('keeps the legacy v1 decision wording and grade when no v2 model is present', () => {
    render(<ReportDecision scan={result('COMPLETE')} />);

    expect(screen.getByText('HIGH risk')).toBeTruthy();
    expect(screen.getByText(/advisory decision from the local scanner/i)).toBeTruthy();
    expect(screen.queryByText('Assessment unavailable')).toBeNull();
  });

  it('does not direct a clean LOW result to nonexistent findings', () => {
    const cleanLow: ScanWorkflowResult = {
      ...result('COMPLETE'),
      riskAssessment: { grade: 'LOW', score: 0, topRisks: [], dataExposure: 'Unknown', complexityDrivers: [] },
      summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    };

    render(<ReportDecision scan={cleanLow} />);

    expect(screen.getByText('LOW risk')).toBeTruthy();
    expect(screen.getByText(/No findings were returned/i)).toBeTruthy();
    expect(screen.queryByText('Review the findings before importing.')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Review findings' })).toBeNull();
  });

  it('puts the grade and recommended next step before detailed sections', () => {
    render(<ReportDecision scan={withFinding(result('COMPLETE'))} />);

    expect(screen.getByRole('heading', { name: 'Decision and next step' })).toBeTruthy();
    expect(screen.getByText('HIGH risk')).toBeTruthy();
    expect(screen.getByText('Recommended next step:')).toBeTruthy();
    expect(screen.getByText('Review the credential boundary.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Review findings' }).getAttribute('href')).toBe('#scanner-findings-heading');
  });

  it('does not invent a grade for indeterminate analysis', () => {
    render(<ReportDecision scan={result('INDETERMINATE')} />);

    expect(screen.getByText('No grade')).toBeTruthy();
    expect(screen.queryByText(/HIGH risk/)).toBeNull();
    expect(screen.getByText('Analysis incomplete. Assessment unavailable because required analysis did not finish; no risk decision is shown.')).toBeTruthy();
    expect(screen.getByText(/no risk decision is shown/i)).toBeTruthy();
  });
});
