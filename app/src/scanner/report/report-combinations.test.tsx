import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SCANNER_RESULT_SCHEMA_VERSION } from '@hub/contracts';
import type { ScanWorkflowResult } from '../engine';
import { ReportDecision } from './report-decision';
import { ReportFindings } from './report-findings';
import { ReportIntegrations } from './report-integrations';
import { ReportSummary } from './report-summary';

afterEach(() => cleanup());

const finding = (severity: 'CRITICAL' | 'HIGH' | 'LOW', policyEffect: 'LEGACY_SCORE' | 'REPORT_ONLY') => ({
  policyId: `${severity}_CHECK`,
  title: `${severity} check`,
  severity,
  location: { nodeName: 'Example node' },
  evidence: { nodeType: 'n8n-nodes-base.code', sourceCode: 'const token = "do-not-render";' },
  message: 'Review this finding.',
  explanation: 'The scanner found a review signal.',
  whyItMatters: 'It may affect workflow safety.',
  possibleImpact: 'Unexpected behavior is possible.',
  remediation: '',
  remediationSteps: [],
  confidence: 'MEDIUM' as const,
  policyEffect,
});

const complete = (overrides: Partial<ScanWorkflowResult> = {}): ScanWorkflowResult => ({
  schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
  scannerVersion: 'scanner-beta-1',
  policyProfile: 'beta-hardened',
  analysisStatus: 'COMPLETE',
  analysisDiagnostics: [],
  workflow: { name: 'Combination fixture', nodeCount: 1, rawNodeCount: 1, annotationNodeCount: 0,
    triggerCount: 1, actionCount: 1, integrationCount: 0, connectionCount: 0, payloadBytes: 100,
    complexity: 'LOW', isSubWorkflow: false },
  functionSummary: { basicPurpose: 'Test', triggerDescription: 'Manual', dataFlowSummary: 'Local',
    businessCategory: 'GENERAL_AUTOMATION', confidence: 'HIGH' },
  integrations: [], findings: [],
  riskAssessment: { grade: 'LOW', score: 0, topRisks: [], dataExposure: 'Unknown', complexityDrivers: [] },
  humanSummary: { headline: 'Low risk', verdict: 'Advisory result.', plainLanguageOverview: 'A test.',
    riskNarrative: 'No major signal.', recommendedActions: [], findingHighlights: [] },
  summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  ...overrides,
});

describe('scanner report result combinations', () => {
  it('shows a complete LOW result with report-only observations without changing the grade', () => {
    const scan = complete({
      findings: [finding('LOW', 'REPORT_ONLY')],
      summary: { critical: 0, high: 0, medium: 0, low: 1, info: 0 },
    });
    render(<><ReportSummary scan={scan} /><ReportFindings scan={scan} /><ReportIntegrations scan={scan} /></>);

    expect(screen.getByLabelText('Analysis status: Analysis complete')).toBeTruthy();
    expect(screen.getByText('LOW risk')).toBeTruthy();
    expect(screen.getByText('Advisory finding — did not change risk grade')).toBeTruthy();
    expect(screen.queryByText('Analysis has coverage limits.')).toBeNull();
  });

  it('shows HIGH and CRITICAL findings as priority results with grouped counts', () => {
    const scan = complete({
      riskAssessment: { grade: 'CRITICAL', score: 100, topRisks: ['Critical check'], dataExposure: 'Unknown', complexityDrivers: [] },
      findings: [finding('CRITICAL', 'LEGACY_SCORE'), finding('HIGH', 'LEGACY_SCORE')],
      summary: { critical: 1, high: 1, medium: 0, low: 0, info: 0 },
    });
    render(<><ReportSummary scan={scan} /><ReportFindings scan={scan} /></>);

    expect(screen.getByText('CRITICAL risk')).toBeTruthy();
    expect(screen.getByText('2 priority')).toBeTruthy();
    expect(screen.getByText('CRITICAL check')).toBeTruthy();
    expect(screen.getByText('HIGH check')).toBeTruthy();
  });

  it('keeps a degraded but eligible result graded and exposes its coverage notice', () => {
    const scan = complete({
      analysisStatus: 'DEGRADED',
      analysisDiagnostics: [{ code: 'SOURCE_SPAN_UNAVAILABLE', category: 'SOURCE' }],
      riskAssessment: { grade: 'HIGH', score: 80, topRisks: ['Review'], dataExposure: 'Unknown', complexityDrivers: [] },
    });
    render(<><ReportSummary scan={scan} /><ReportIntegrations scan={scan} /></>);

    expect(screen.getByLabelText('Analysis status: Partial analysis')).toBeTruthy();
    expect(screen.getByText('HIGH risk')).toBeTruthy();
    expect(screen.getByText('Notice: SOURCE_SPAN_UNAVAILABLE')).toBeTruthy();
  });

  it('fails closed when a complete result is missing required decision fields', () => {
    const incomplete = complete({
      riskAssessment: { grade: 'HIGH', score: 80, topRisks: ['Review'], dataExposure: 'Unknown', complexityDrivers: [] },
      humanSummary: undefined,
      summary: undefined,
    });
    render(<><ReportSummary scan={incomplete} /><ReportDecision scan={incomplete} /><ReportFindings scan={incomplete} /><ReportIntegrations scan={incomplete} /></>);

    expect(screen.getByLabelText('Analysis status: Analysis incomplete')).toBeTruthy();
    expect(screen.getByText('Risk assessment unavailable.')).toBeTruthy();
    expect(screen.queryByText('HIGH risk')).toBeNull();
    expect(screen.getByText('No grade')).toBeTruthy();
    expect(screen.queryByText('Full local analysis completed.')).toBeNull();
    expect(screen.getByText('Analysis incomplete.')).toBeTruthy();
    expect(screen.getAllByText(/Required report data is incomplete/).length).toBeGreaterThan(0);
  });

  it('withholds the grade for an indeterminate result and retains the diagnostic notice', () => {
    const scan = complete({
      analysisStatus: 'INDETERMINATE',
      analysisDiagnostics: [{ code: 'MALFORMED_NODE_PARAMETERS', category: 'PARSER' }],
      riskAssessment: undefined,
      humanSummary: undefined,
      summary: undefined,
    });
    render(<><ReportSummary scan={scan} /><ReportIntegrations scan={scan} /></>);

    expect(screen.getByLabelText('Analysis status: Analysis incomplete')).toBeTruthy();
    expect(screen.getByText('Risk assessment unavailable.')).toBeTruthy();
    expect(screen.queryByText(/risk$/)).toBeNull();
    expect(screen.getByText('Notice: MALFORMED_NODE_PARAMETERS')).toBeTruthy();
  });
});
