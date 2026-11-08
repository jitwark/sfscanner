import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCANNER_RESULT_SCHEMA_VERSION } from '@hub/contracts';
import type { ScanWorkflowResult } from '../engine';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { ReportFindings } from './report-findings';
import { ReportTrust } from './report-trust';

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

const scan: ScanWorkflowResult = {
  schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
  scannerVersion: 'scanner-beta-1',
  policyProfile: 'beta-hardened',
  analysisStatus: 'COMPLETE',
  analysisDiagnostics: [],
  workflow: { name: 'Synthetic report', nodeCount: 1, rawNodeCount: 1,
    annotationNodeCount: 0, triggerCount: 1, actionCount: 1, integrationCount: 0,
    connectionCount: 0, payloadBytes: 100, complexity: 'LOW', isSubWorkflow: false },
  functionSummary: { basicPurpose: 'Test', triggerDescription: 'Manual', dataFlowSummary: 'Local',
    businessCategory: 'GENERAL_AUTOMATION', confidence: 'HIGH' },
  integrations: [],
  findings: [
    { policyId: 'N8N_CODE_NODE', title: 'Code node', severity: 'LOW', location: {}, evidence: {},
      message: 'Review this node.', explanation: 'Code can change behavior.', whyItMatters: 'Review it.',
      possibleImpact: 'Unexpected behavior.', remediation: 'Review the code.', remediationSteps: [],
      confidence: 'HIGH', policyEffect: 'LEGACY_SCORE' },
  ],
  riskAssessment: { grade: 'LOW', score: 0, topRisks: [], dataExposure: 'Unknown', complexityDrivers: [] },
  humanSummary: { headline: 'Review', verdict: 'Advisory.', plainLanguageOverview: 'A workflow.',
    riskNarrative: 'Review the result.', recommendedActions: [], findingHighlights: [] },
  summary: { critical: 0, high: 0, medium: 0, low: 1, info: 0 },
};
const v2Scan = {
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
    findings: [{ effect: 'REPORT_ONLY' }, { effect: 'SCORING' }],
  },
  limits: {
    usage: [{ id: 'workflow-nodes', maximum: 2, examined: 2, omitted: 1, exhausted: true }],
  },
  assessment: null,
} as unknown as ScannerReportModelV2;

const indeterminateV2Scan = {
  ...v2Scan,
  v2: { ...v2Scan.v2, analysis: { ...v2Scan.v2.analysis, status: 'INDETERMINATE' } },
} as unknown as ScannerReportModelV2;

const completeWithoutAssessmentV2Scan = {
  ...v2Scan,
  v2: { ...v2Scan.v2, analysis: { ...v2Scan.v2.analysis, status: 'COMPLETE' } },
} as unknown as ScannerReportModelV2;


describe('scanner report trust and help', () => {
  it('explains what the result means and does not prove without unsupported claims', () => {
    const { container } = render(<ReportTrust scan={scan} />);

    expect(screen.getByRole('heading', { name: 'What this result means' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'What this result does not prove' })).toBeTruthy();
    expect(screen.getByText(/deterministic rule matches/i)).toBeTruthy();
    expect(screen.getByText(/not proof of runtime behavior/i)).toBeTruthy();
    expect(screen.getByText('scanner-beta-1')).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toMatch(/licen[cs]|risk grade|security verdict/);
  });

  it('shows a safe synthetic result example only when a finding and tool version support it', () => {
    render(<ReportTrust scan={scan} />);

    expect(screen.getByText('Safe synthetic result example')).toBeTruthy();
    expect(screen.getByText('Expected rule match')).toBeTruthy();
    expect(screen.getByText('N8N_CODE_NODE')).toBeTruthy();
  });

  it('guides users to report false positives and security concerns privately', () => {
    render(<ReportTrust scan={scan} />);

    expect(screen.getByText(/false positive or a security concern/i)).toBeTruthy();
    expect(screen.getByText(/do not disclose credentials, secrets, or customer data publicly/i)).toBeTruthy();
    const reportLink = screen.getByRole('link', { name: /report it privately/i });
    // Next's internal Link normalizes the trailing slash before the fragment in jsdom.
    expect(reportLink.getAttribute('href')).toBe('/takedown#security');
  });

  it('renders the rule id as text when no reference URL is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_RULE_REFERENCE_URL', '');
    render(<ReportFindings scan={scan} />);

    expect(screen.getAllByText('N8N_CODE_NODE', { exact: false }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /rule reference/i })).toBeNull();
  });

  it('links the rule id to the configured reference URL', () => {
    vi.stubEnv('NEXT_PUBLIC_RULE_REFERENCE_URL', 'https://example.test/rules#profiles');
    render(<ReportFindings scan={scan} />);

    const policyLink = screen.getByRole('link', { name: /rule reference/i });
    expect(policyLink.getAttribute('href')).toBe('https://example.test/rules#profiles');
    expect(policyLink.getAttribute('target')).toBe('_blank');
    expect(policyLink.getAttribute('rel')).toContain('noopener');
  });
  it('shows v2 native identities and distinguishes report-only evidence without claiming trust authority', () => {
    const { container } = render(<ReportTrust scan={v2Scan} />);

    expect(screen.getByRole('heading', { name: 'Scanner identity' })).toBeTruthy();
    expect(container.textContent).toContain('secureflow-scanner');
    expect(container.textContent).toContain('beta-default');
    expect(container.textContent).toContain('builtin-rules');
    expect(container.textContent).toContain('builtin-semantics');
    expect(container.textContent).toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(container.textContent).toMatch(/report-only.+does not change risk grade/i);
    expect(container.textContent).toMatch(/native.+assessment/i);
    expect(container.textContent).toMatch(/does not assert.+signature|trust store|sbom/i);
    expect(container.textContent?.toLowerCase()).not.toMatch(/verified signature|trusted ruleset|software bill of materials/);
  });

  it('keeps v2 null and indeterminate outcomes explicitly non-conclusive', () => {
    const { container, unmount } = render(<ReportTrust scan={indeterminateV2Scan} />);

    expect(container.textContent).toContain('Analysis incomplete');
    expect(container.textContent).toContain('Assessment unavailable because required analysis did not finish');
    expect(container.textContent).not.toMatch(/full local analysis completed|all node behavior.+modelled|safe to execute|analysis passed/i);
    unmount();

    const completeWithoutAssessment = render(<ReportTrust scan={completeWithoutAssessmentV2Scan} />);
    expect(completeWithoutAssessment.container.textContent).toMatch(/Assessment unavailable/i);
    expect(completeWithoutAssessment.container.textContent).not.toMatch(/Analysis complete\.|full local analysis completed|safe to execute/i);
  });
});
