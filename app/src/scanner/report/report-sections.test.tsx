import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScanWorkflowResult } from '../engine';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { SCANNER_RESULT_SCHEMA_VERSION } from '@hub/contracts';
import { ReportAnatomy, buildExportReport } from './report-anatomy';
import { ReportExportActions } from './report-export-actions';
import { ReportFindings } from './report-findings';
import { ReportIntegrations } from './report-integrations';
import { ReportSummary } from './report-summary';
import { ReportDecision } from './report-decision';
import * as reportAnatomy from './report-anatomy';

const secret = 'sk_live_abc123456789';
const scan: ScanWorkflowResult = {
  schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
  scannerVersion: 'scanner-beta-1', policyProfile: 'beta-hardened',
  analysisStatus: 'DEGRADED', analysisDiagnostics: [{ code: 'SOURCE_SPAN_UNAVAILABLE', category: 'SOURCE' }],
  workflow: { name: `Payment ${secret}`, nodeCount: 2, rawNodeCount: 2,
    annotationNodeCount: 0, triggerCount: 1, actionCount: 1, integrationCount: 1,
    connectionCount: 1, payloadBytes: 300, complexity: 'LOW', isSubWorkflow: false },
  functionSummary: { basicPurpose: 'Charge a card', triggerDescription: 'Webhook',
    dataFlowSummary: 'Webhook to Stripe', businessCategory: 'WEBHOOK_API', confidence: 'HIGH' },
  integrations: [{ service: 'Stripe', nodeTypes: ['n8n-nodes-base.stripe'], nodeCount: 1, usage: 'Creates a charge', riskNotes: ['Writes external data.'] }],
  riskAssessment: { grade: 'HIGH', score: 80, topRisks: ['Credential exposure'],
    dataExposure: 'Payment data', complexityDrivers: [] },
  humanSummary: { headline: 'Review before import', verdict: 'This report is advisory.',
    plainLanguageOverview: 'Charges cards.', riskNarrative: 'A credential may be exposed.',
    recommendedActions: ['Rotate the exposed token.'], findingHighlights: [] },
  summary: { critical: 1, high: 0, medium: 0, low: 1, info: 0 },
  findings: [
    { policyId: 'TOKEN', title: 'Credential in node', severity: 'CRITICAL',
      location: { nodeName: `Charge ${secret}` }, evidence: { token: secret }, message: `Found ${secret}`,
      explanation: 'A token is present.', whyItMatters: 'It can be copied.', possibleImpact: 'Account access.',
      remediation: 'Rotate the token.', remediationSteps: ['Rotate it.'], confidence: 'HIGH', policyEffect: 'LEGACY_SCORE' },
    { policyId: 'NOTE', title: 'Review note', severity: 'LOW', location: { nodeName: 'Charge card' },
      evidence: {}, message: 'Review', explanation: 'Manual review helps.', whyItMatters: 'Context matters.',
      possibleImpact: 'Unknown behavior.', remediation: 'Review parameters.', remediationSteps: ['Review.'],
      confidence: 'MEDIUM', policyEffect: 'REPORT_ONLY' },
  ],
};
const v2CoverageScan = {
  ...scan,
  v2: {
    schemaVersion: 'scanner-result-v2',
    engine: { id: 'secureflow-scanner', version: '2.0.0', buildDigest: 'a'.repeat(64) },
    profile: { id: 'beta-default', version: '2.0.0' },
    ruleset: { id: 'builtin-rules', version: '2.0.0', digest: 'b'.repeat(64), signatureStatus: 'UNVERIFIED' },
    semantics: { id: 'builtin-semantics', version: '1.0.0', digest: 'c'.repeat(64) },
    limits: {
      schemaVersion: 'scanner-limits-v2', digest: 'd'.repeat(64),
      usage: [{ id: 'workflow-nodes', maximum: 2, examined: 2, omitted: 1, exhausted: true }],
    },
    analysis: {
      status: 'DEGRADED',
      capabilities: [{
        id: 'workflow-insights', version: '1.0.0', required: true, status: 'DEGRADED',
        seen: 2, analyzed: 1, skipped: 0, omitted: 1, diagnosticIds: ['e'.repeat(64)],
      }],
      diagnostics: [{
        id: 'e'.repeat(64), code: 'OPTIONAL_LIMIT_EXCEEDED', category: 'LIMIT',
        capabilityId: 'workflow-insights', aggregateEffect: 'DEGRADED', assessmentEligible: true,
        observed: 2, maximum: 2, omitted: 1,
      }],
    },
    findings: [],
  },
  limits: {
    usage: [{ id: 'workflow-nodes', maximum: 2, examined: 2, omitted: 1, exhausted: true }],
  },
  assessment: null,
} as unknown as ScannerReportModelV2;


afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('scanner report hierarchy', () => {
  it('orders summary, priority findings, affected nodes, readiness, remediation, and export actions', async () => {
    const { container } = render(<>
      <ReportSummary scan={scan} />
      <ReportDecision scan={scan} />
      <ReportFindings scan={scan} />
      <ReportIntegrations scan={scan} />
      <ReportAnatomy scan={scan} />
    </>);

    const headings = Array.from(container.querySelectorAll('h2')).map((heading) => heading.textContent);
    expect(headings).toEqual([
      'Analyst summary', 'Decision and next step', 'Critical and high findings', 'Affected nodes',
      'Readiness and integrations', 'Remediation', 'Export or copy',
    ]);
    expect(screen.getByText('Advisory finding — did not change risk grade')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Download SARIF 2.1.0' })).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toContain('safe to execute');
  });

  it('re-redacts copied report data and labels it advisory', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<ReportAnatomy scan={scan} />);

    const copy = await screen.findByRole('button', { name: 'Copy redacted report' });
    expect(copy.className).toContain('min-h-11');
    fireEvent.click(copy);

    expect(writeText).toHaveBeenCalledOnce();
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain('[REDACTED]');
    expect(copied).not.toContain(secret);
    expect(copied).toContain('advisory');
    expect(buildExportReport(scan)).toBe(copied);
  });

  it('downloads redacted JSON and SARIF with their stable filenames and MIME types', async () => {
    const createObjectURL = vi.fn((_blob: Blob | MediaSource) => 'blob:report');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const anchors: HTMLAnchorElement[] = [];
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tagName, options);
      if (tagName === 'a') anchors.push(element as HTMLAnchorElement);
      return element;
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<ReportExportActions scan={scan} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download redacted JSON' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Download SARIF 2.1.0' }));

    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect((createObjectURL.mock.calls[0][0] as Blob).type).toBe('application/json');
    expect((createObjectURL.mock.calls[1][0] as Blob).type).toBe('application/sarif+json');
    expect(anchors.map((anchor) => anchor.download)).toEqual([
      'secureflow-scan-report.json',
      'secureflow-scan-report.sarif',
    ]);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:report');
  });

  it('keeps priority findings reachable while filtering other findings', () => {
    render(<ReportFindings scan={scan} />);

    expect(screen.getByText('Credential in node')).toBeTruthy();
    const severity = screen.getByRole('combobox', { name: 'Filter findings by severity' });
    const effect = screen.getByRole('combobox', { name: 'Filter findings by effect' });

    fireEvent.change(severity, { target: { value: 'LOW' } });
    fireEvent.change(effect, { target: { value: 'REPORT_ONLY' } });

    expect(screen.getByText('Credential in node')).toBeTruthy();
    expect(screen.getByText('Review note')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Showing 2 of 2 findings');

    fireEvent.click(screen.getByRole('button', { name: 'Clear finding filters' }));
    expect(screen.getByText('Credential in node')).toBeTruthy();
    expect(screen.getByText('Review note')).toBeTruthy();
  });

  it('makes an empty filtered result explicit without implying the scan was empty', () => {
    render(<ReportFindings scan={scan} />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter findings by severity' }), {
      target: { value: 'INFO' },
    });

    expect(screen.getByRole('status').textContent).toContain('No findings match these filters');
    expect(screen.getByRole('button', { name: 'Clear finding filters' })).toBeTruthy();
    expect(screen.getByText('Credential in node')).toBeTruthy();
    expect(screen.queryByText('Review note')).toBeNull();
  });

  it('renders a distinct no-findings state for an empty scan', () => {
    render(<ReportFindings scan={{ ...scan, analysisStatus: 'COMPLETE', analysisDiagnostics: [], findings: [], summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } }} />);

    expect(screen.getByRole('status').textContent).toBe('No findings were returned for this scan.');
    expect(screen.getByRole('note').textContent).toContain('No findings were returned for this scan.');
    expect(screen.getByText(/No critical or high findings were returned\./)).toBeTruthy();
  });

  it('shows bounded evidence and remediation without exposing source text', () => {
    const rawSource = 'const password = "plain-source-not-for-report";';
    const unsafeScan: ScanWorkflowResult = {
      ...scan,
      findings: scan.findings.map((finding, index) => index === 0 ? {
        ...finding,
        evidence: { ...finding.evidence, sourceCode: rawSource, longEvidence: 'x'.repeat(1_000) },
      } : finding),
    };

    const { container } = render(<ReportFindings scan={unsafeScan} />);

    expect(screen.getAllByRole('heading', { name: 'Evidence' })).toHaveLength(2);
    expect(screen.getAllByRole('heading', { name: 'Remediation' })).toHaveLength(2);
    expect(container.textContent).not.toContain(rawSource);
    expect(container.textContent).not.toContain('x'.repeat(1_000));
    expect(container.textContent).toContain('Rotate the token.');
  });

  it('does not render a grade for an indeterminate result', () => {
    const indeterminate: ScanWorkflowResult = {
      ...scan,
      analysisStatus: 'INDETERMINATE',
      riskAssessment: undefined,
      humanSummary: undefined,
      summary: undefined,
    };

    render(<ReportSummary scan={indeterminate} />);

    expect(screen.getByLabelText('Analysis status: Analysis indeterminate')).toBeTruthy();
    expect(screen.queryByText('HIGH risk')).toBeNull();
    expect(screen.getByText('Analysis could not be completed.')).toBeTruthy();
  });

  it('builds deterministic SARIF 2.1.0 with status, diagnostics, and report-only semantics', () => {
    const maybeBuilder = (reportAnatomy as unknown as {
      buildSarifReport?: (value: ScanWorkflowResult) => string;
    }).buildSarifReport;
    expect(typeof maybeBuilder).toBe('function');
    if (!maybeBuilder) return;

    const reversed = { ...scan, findings: [...scan.findings].reverse() };
    const first = maybeBuilder(scan);
    const second = maybeBuilder(reversed);
    const sarif = JSON.parse(first) as {
      $schema: string;
      version: string;
      runs: Array<{
        properties: Record<string, unknown>;
        results: Array<{ ruleId: string; properties: Record<string, unknown> }>;
        invocations: Array<{ executionSuccessful: boolean; toolExecutionNotifications: Array<{ descriptor: { id: string } }> }>;
      }>;
    };

    expect(first).toBe(second);
    expect(sarif.$schema).toBe('https://json.schemastore.org/sarif-2.1.0.json');
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].properties.analysisStatus).toBe('DEGRADED');
    expect(sarif.runs[0].invocations[0].executionSuccessful).toBe(true);
    expect(sarif.runs[0].invocations[0].toolExecutionNotifications[0].descriptor.id).toBe('SOURCE_SPAN_UNAVAILABLE');
    expect(sarif.runs[0].results.map((result) => result.ruleId)).toEqual(['TOKEN', 'NOTE']);
    expect(sarif.runs[0].results[1].properties.policyEffect).toBe('REPORT_ONLY');
    expect(first).not.toContain(secret);

    const indeterminate = maybeBuilder({
      ...scan,
      analysisStatus: 'INDETERMINATE',
      riskAssessment: undefined,
      humanSummary: undefined,
      summary: undefined,
    });
    const indeterminateSarif = JSON.parse(indeterminate) as { runs: Array<{ properties: Record<string, unknown> }> };
    expect(indeterminateSarif.runs[0].properties.analysisStatus).toBe('INDETERMINATE');
    expect(indeterminateSarif.runs[0].properties.riskGrade).toBeUndefined();
  });

  it('shows v2 capability coverage and exhausted limits for degraded assessment', () => {
    const v2Scan = {
      ...scan,
      assessment: {
        score: 80, grade: 'HIGH', scoringPolicyVersion: '2.0.0',
        basisFindingIds: [], excludedReportOnlyFindingIds: [],
        excludedUncertainFindingIds: [], excludedNotApplicableFindingIds: [], unknownEvidenceCount: 0,
      },
      limits: {
        usage: [{ id: 'workflow-nodes', maximum: 2, examined: 2, omitted: 1, exhausted: true }],
      },
      v2: {
        schemaVersion: 'scanner-result-v2',
        limits: {
          usage: [{ id: 'workflow-nodes', maximum: 2, examined: 2, omitted: 1, exhausted: true }],
        },
        analysis: {
          status: 'DEGRADED',
          capabilities: [{
            id: 'workflow-insights', version: '1.0.0', required: true, status: 'DEGRADED',
            seen: 2, analyzed: 1, skipped: 0, omitted: 1, diagnosticIds: ['diagnostic-limit'],
          }],
          diagnostics: [{
            id: 'diagnostic-limit', code: 'OPTIONAL_LIMIT_EXCEEDED', category: 'LIMIT',
            capabilityId: 'workflow-insights', aggregateEffect: 'DEGRADED', assessmentEligible: true,
            observed: 2, maximum: 2, omitted: 1,
          }],
        },
      },
    } as unknown as ScannerReportModelV2;
    render(<ReportSummary scan={v2Scan} />);
    expect(screen.getByLabelText('Analysis status: Analysis degraded')).toBeTruthy();

    expect(screen.getByRole('heading', { name: 'Analysis coverage' })).toBeTruthy();
    expect(screen.getByLabelText('Analysis capability coverage').textContent).toContain('workflow-insights');
    expect(screen.getByLabelText('Analysis capability coverage').textContent).toContain('1/2 analyzed');
    expect(screen.getByLabelText('Analysis limit usage').textContent).toContain('1 omitted');
    expect(screen.getByLabelText('Analysis limit usage').textContent).toContain('limit exhausted');
    expect(screen.getByText('Notice: OPTIONAL_LIMIT_EXCEEDED · DEGRADED')).toBeTruthy();
    expect(screen.getByText('HIGH risk')).toBeTruthy();
  });
  it('shows v2 coverage omissions and avoids complete wording in readiness', () => {
    const { container } = render(<ReportIntegrations scan={v2CoverageScan} />);

    expect(screen.getByRole('heading', { name: 'Analysis coverage' })).toBeTruthy();
    expect(screen.getByLabelText('Analysis capability coverage').textContent).toContain('workflow-insights');
    expect(screen.getByLabelText('Analysis capability coverage').textContent).toContain('1/2 analyzed');
    expect(screen.getByLabelText('Analysis limit usage').textContent).toContain('1 omitted');
    expect(screen.getByLabelText('Analysis limit usage').textContent).toContain('limit exhausted');
    expect(screen.getByText('Notice: OPTIONAL_LIMIT_EXCEEDED · DEGRADED')).toBeTruthy();
    expect(screen.getByText('Analysis has coverage limits.')).toBeTruthy();
    expect(container.textContent).not.toContain('Full local analysis completed.');
    expect(container.textContent?.toLowerCase()).not.toContain('safe to execute');
  });


});
