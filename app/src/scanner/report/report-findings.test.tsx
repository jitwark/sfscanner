import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SCANNER_RESULT_SCHEMA_VERSION } from '@hub/contracts';
import type { ScanWorkflowResult } from '../engine';
import type { CanonicalScanFinding, ScanSeverity } from '@hub/scanner-core/policy';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { ReportFindings } from './report-findings';

function indeterminateScan(): ScanWorkflowResult {
  return {
    schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
    scannerVersion: 'scanner-beta-1',
    policyProfile: 'beta-hardened',
    analysisStatus: 'INDETERMINATE',
    analysisDiagnostics: [{ code: 'MALFORMED_NODE_PARAMETERS', category: 'PARSER' }],
    workflow: { name: 'Incomplete workflow', nodeCount: 1, rawNodeCount: 1, annotationNodeCount: 0,
      triggerCount: 0, actionCount: 1, integrationCount: 0, connectionCount: 0, payloadBytes: 10,
      complexity: 'LOW', isSubWorkflow: false },
    functionSummary: { basicPurpose: 'Unknown', triggerDescription: 'Unknown', dataFlowSummary: 'Unknown',
      businessCategory: 'GENERAL_AUTOMATION', confidence: 'LOW' },
    integrations: [],
    findings: [],
  };
}

function finding(index: number, severity: ScanSeverity = 'LOW'): CanonicalScanFinding {
  return {
    policyId: `TEST-${index}`, title: `${severity} finding ${index}`, severity, location: { nodeName: `Node ${index}` },
    evidence: {}, message: 'Review this finding.', explanation: 'It needs review.', whyItMatters: 'It matters.',
    possibleImpact: 'Possible impact.', remediation: 'Review it.', remediationSteps: ['Review it.'],
    confidence: 'HIGH', policyEffect: 'LEGACY_SCORE',
  };
}

function completeScan(findings: CanonicalScanFinding[]): ScanWorkflowResult {
  return { ...indeterminateScan(), analysisStatus: 'COMPLETE', analysisDiagnostics: [], findings };
}

function v2Finding(
  ruleId: string,
  overrides: Partial<ScannerReportModelV2['v2']['findings'][number]> = {},
): ScannerReportModelV2['v2']['findings'][number] {
  return {
    findingId: `${ruleId}-finding`,
    ruleId,
    ruleRevision: '1',
    effect: 'SCORING',
    severity: 'LOW',
    confidence: 'HIGH',
    evidenceClass: 'CAPABILITY',
    conclusion: 'OBSERVED',
    applicability: 'APPLICABLE',
    subject: { kind: 'WORKFLOW' },
    factRefs: [],
    traceRefs: [],
    remediationId: 'r',
    ...overrides,
  } as ScannerReportModelV2['v2']['findings'][number];
}

function v2Trace(traceId: string, kind: ScannerReportModelV2['v2']['traces'][number]['kind']) {
  return {
    traceId,
    kind,
    steps: [{ ordinal: 0, kind: 'SOURCE', subject: { kind: 'WORKFLOW' }, factRefs: [] }],
  } as ScannerReportModelV2['v2']['traces'][number];
}

function withV2(
  scan: ScanWorkflowResult,
  findings: ScannerReportModelV2['v2']['findings'][number][],
  traces: ScannerReportModelV2['v2']['traces'][number][],
): ScanWorkflowResult {
  return {
    ...scan,
    v2: { schemaVersion: 'scanner-result-v2', findings, traces },
  } as unknown as ScanWorkflowResult;
}

describe('ReportFindings', () => {
  afterEach(cleanup);

  it('keeps an empty indeterminate result explicitly non-conclusive', () => {
    render(<ReportFindings scan={indeterminateScan()} />);

    expect(screen.getByRole('status').textContent).toContain('Analysis did not complete');
    expect(screen.getByRole('note').textContent).toContain('not conclusive');
    expect(screen.getByRole('note').textContent).toContain('required analysis did not complete');
    expect(screen.queryByText(/the workflow was analyzed/i)).toBeNull();
    expect(screen.getByText(/No critical or high findings were identified in the findings returned so far/)).toBeTruthy();
  });

  it('mounts only the initial bounded page and reports remaining findings', () => {
    render(<ReportFindings scan={completeScan(Array.from({ length: 25 }, (_, index) => finding(index)))} />);

    expect(screen.getAllByRole('article')).toHaveLength(20);
    expect(screen.getByRole('status').textContent).toContain('Showing 20 of 25 findings');
    expect(screen.getByRole('status').textContent).toContain('5 more findings available');
    expect(screen.getByRole('button', { name: /Show more findings/ })).toBeTruthy();
  });

  it('loads the next bounded page without changing finding order', () => {
    render(<ReportFindings scan={completeScan(Array.from({ length: 25 }, (_, index) => finding(index)))} />);
    fireEvent.click(screen.getByRole('button', { name: /Show more findings/ }));

    expect(screen.getAllByRole('article')).toHaveLength(25);
    expect(screen.getByRole('heading', { name: 'LOW finding 24' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Show more findings/ })).toBeNull();
  });

  it('resets the rendered page and applies filters to non-priority findings', () => {
    const findings = [
      ...Array.from({ length: 25 }, (_, index) => finding(index, 'LOW')),
      ...Array.from({ length: 3 }, (_, index) => finding(index + 25, 'INFO')),
    ];
    render(<ReportFindings scan={completeScan(findings)} />);
    fireEvent.click(screen.getByRole('button', { name: /Show more findings/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter findings by severity' }), { target: { value: 'INFO' } });

    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.getByText('INFO finding 25')).toBeTruthy();
    expect(screen.queryByText('LOW finding 24')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Showing 3 of 28 findings');
  });

  it('keeps priority findings visible and ahead of filterable findings', () => {
    const findings = [finding(0, 'CRITICAL'), finding(1, 'HIGH'), ...Array.from({ length: 25 }, (_, index) => finding(index + 2))];
    render(<ReportFindings scan={completeScan(findings)} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter findings by severity' }), { target: { value: 'INFO' } });

    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('h3')?.textContent).toBe('CRITICAL finding 0');
    expect(cards[1].querySelector('h3')?.textContent).toBe('HIGH finding 1');
    expect(screen.getByRole('status').textContent).toContain('priority findings remain visible');
  });
  it('shows v2 applicability, evidence class, effect, and safe trace availability', () => {
    const secretTracePayload = 'sk_live_trace_payload_must_not_render';
    const v2Scan = withV2(
      completeScan([finding(1), finding(2, 'INFO')]),
      [
        v2Finding('TEST-1', {
          effect: 'REPORT_ONLY',
          evidenceClass: 'VERSION_APPLICABILITY',
          applicability: 'NOT_APPLICABLE',
          traceRefs: ['trace-visible', 'trace-missing'],
        }),
        v2Finding('TEST-2', {
          evidenceClass: 'POTENTIAL_DATAFLOW',
          applicability: 'UNKNOWN',
          conclusion: 'UNKNOWN',
        }),
      ],
      [{
        ...v2Trace('trace-visible', 'CONFIDENTIALITY'),
        payload: secretTracePayload,
      } as ScannerReportModelV2['v2']['traces'][number]],
    );

    const { container } = render(<ReportFindings scan={v2Scan} />);

    expect(container.textContent).toContain('Applicability: NOT_APPLICABLE');
    expect(container.textContent).toContain('Applicability: UNKNOWN');
    expect(container.textContent).toContain('Evidence class: VERSION_APPLICABILITY');
    expect(container.textContent).toContain('Evidence class: POTENTIAL_DATAFLOW');
    expect(container.textContent).toContain('Effect: REPORT_ONLY');
    expect(container.textContent).toContain('Trace references: 2 total; 1 available');
    expect(container.textContent).toContain('CONFIDENTIALITY');
    expect(container.textContent).not.toContain('trace-visible');
    expect(container.textContent).not.toContain(secretTracePayload);
    expect(screen.queryByRole('heading', { name: 'Scanner identity' })).toBeNull();
    expect(screen.queryByText(/Analysis is (?:degraded|indeterminate)/i)).toBeNull();
  });

  it('does not add v2 evidence labels to the explicit v1 report shape', () => {
    const { container } = render(<ReportFindings scan={completeScan([finding(1)])} />);

    expect(container.textContent).not.toContain('Applicability:');
    expect(container.textContent).not.toContain('Evidence class:');
    expect(container.textContent).not.toContain('Trace references:');
  });
});
