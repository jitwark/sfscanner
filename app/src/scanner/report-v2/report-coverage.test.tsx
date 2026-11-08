import { cleanup, render, screen, within } from '@testing-library/react';
import type { RefObject } from 'react';
import type { AnalysisDiagnosticV2 } from '@hub/contracts/scanner-v2-result';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { ReportResult } from '../report/report-result';
import { ReportCoverage } from './report-coverage';
import { ReportV2Sections } from './report-v2-sections';

const digest = 'a'.repeat(64);

function model(overrides: Record<string, unknown> = {}): ScannerReportModelV2 {
  return {
    schemaVersion: 'scanner-result-v1',
    scannerVersion: 'scanner-beta-1',
    policyProfile: 'beta-default',
    analysisStatus: 'DEGRADED',
    analysisDiagnostics: [],
    workflow: { name: 'Coverage fixture', nodeCount: 2, rawNodeCount: 2, annotationNodeCount: 0, triggerCount: 1, actionCount: 1, integrationCount: 0, connectionCount: 1, payloadBytes: 20, complexity: 'LOW', isSubWorkflow: false },
    functionSummary: { basicPurpose: 'Test', triggerDescription: 'Manual', dataFlowSummary: 'Unknown', businessCategory: 'GENERAL_AUTOMATION', confidence: 'LOW' },
    integrations: [], findings: [],
    v2: {
      schemaVersion: 'scanner-result-v2',
      engine: { id: 'secureflow-scanner', version: '2.0.0', buildDigest: digest },
      input: { rawSha256: digest, semanticSha256: digest, ambiguitySha256: digest, ambiguityCount: 0, utf8Bytes: 20 },
      profile: { id: 'beta-default', version: '2.0.0' },
      ruleset: { id: 'builtin', version: '2.0.0', digest, signatureStatus: 'UNVERIFIED' },
      semantics: { id: 'builtin', version: '1.0.0', digest },
      target: { edition: 'UNKNOWN', deployment: 'UNKNOWN', role: 'UNKNOWN', taskRunner: 'UNKNOWN', communityPackages: [], configuration: [], contextDigest: digest },
      limits: { schemaVersion: 'scanner-limits-v2', digest, usage: [] },
      analysis: { status: 'DEGRADED', capabilities: [], diagnostics: [] },
      workflow: { name: 'Coverage fixture', nodeCount: 2, rawNodeCount: 2, annotationNodeCount: 0, triggerCount: 1, actionCount: 1, integrationCount: 0, edgeCount: 1, resolvedEdgeCount: 1, payloadBytes: 20, complexity: 'LOW', isSubWorkflow: false },
      facts: [], traces: [], findings: [], assessment: null,
      stats: { rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings: 0, serializedBytes: 100 },
    },
    limits: { usage: [] }, assessment: null,
    ...overrides,
  } as unknown as ScannerReportModelV2;
}

function ref(): RefObject<HTMLHeadingElement | null> {
  return { current: null };
}

const assessment = {
  score: 80, grade: 'HIGH', scoringPolicyVersion: '2.0.0', basisFindingIds: [],
  excludedReportOnlyFindingIds: [], excludedUncertainFindingIds: [],
  excludedNotApplicableFindingIds: [], unknownEvidenceCount: 0,
};

function modelOnly(): ScannerReportModelV2 {
  const base = model();
  const diagnosticIds = ['c'.repeat(64), 'd'.repeat(64)];
  return model({
    assessment,
    v2: {
      ...base.v2,
      analysis: {
        status: 'DEGRADED',
        capabilities: [{
          id: 'workflow-insights', version: '1.0.0', required: false, status: 'DEGRADED',
          seen: 3, analyzed: 3, skipped: 0, omitted: 0, diagnosticIds,
        }],
        diagnostics: [
          { id: diagnosticIds[0], code: 'SEMANTIC_CATALOGUE_MISS', category: 'CATALOGUE', capabilityId: 'workflow-insights', aggregateEffect: 'DEGRADED', assessmentEligible: true },
          { id: diagnosticIds[1], code: 'GENERIC_NODE_UNMODELED_CAPABILITY', category: 'CATALOGUE', capabilityId: 'workflow-insights', aggregateEffect: 'DEGRADED', assessmentEligible: true },
        ],
      },
      limits: { ...base.v2.limits, usage: [] },
      stats: { ...base.v2.stats, rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings: 0 },
    },
    limits: { usage: [] },
  });
}

  afterEach(cleanup);
describe('ReportCoverage', () => {
  it('renders capability counts, omissions, diagnostics, and Assessment unavailable for a null assessment', () => {
    const scan = model({
      v2: {
        ...model().v2,
        analysis: {
          status: 'DEGRADED',
          capabilities: [{ id: 'javascript-security', version: '1.0.0', required: false, status: 'DEGRADED', seen: 4, analyzed: 3, skipped: 0, omitted: 1, diagnosticIds: [digest] }],
          diagnostics: [{ id: digest, code: 'OPTIONAL_LIMIT_EXCEEDED', category: 'LIMIT', capabilityId: 'javascript-security', aggregateEffect: 'DEGRADED', assessmentEligible: true, observed: 4, maximum: 3, omitted: 1 }],
        },
        limits: { schemaVersion: 'scanner-limits-v2', digest, usage: [{ id: 'code-bytes', maximum: 3, examined: 3, omitted: 1, exhausted: true }] },
      },
      limits: { usage: [{ id: 'code-bytes', maximum: 3, examined: 3, omitted: 1, exhausted: true }] },
    });
    render(<ReportCoverage model={scan} />);

    expect(screen.getByRole('heading', { name: 'Analysis coverage' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Assessment unavailable');
    expect(screen.getByText(/javascript-security/)).toBeTruthy();
    expect(screen.getByText(/3\/4 analyzed/)).toBeTruthy();
    expect(screen.getAllByText(/1 omitted/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Recorded omissions are not a clean result/i)).toBeTruthy();
    expect(screen.queryByText(/LOW risk/)).toBeNull();

    const capabilities = screen.getByRole('list', { name: 'Analysis capability coverage' });
    expect(within(capabilities).getByText(/OPTIONAL_LIMIT_EXCEEDED/)).toBeTruthy();
    expect(within(capabilities).getByText('observed 4 · maximum 3 · omitted 1')).toBeTruthy();
    expect(within(capabilities).getByText(/optional analysis bound was reached/i)).toBeTruthy();
    expect(within(capabilities).getByText(/ran with bounded omissions/i)).toBeTruthy();

    const limitRows = screen.getByRole('list', { name: 'Analysis limit usage' });
    expect(within(limitRows).getByText((_, element) => element?.tagName === 'P' && element.textContent === 'code-bytes: 3/3 examined · 1 omitted · limit exhausted')).toBeTruthy();
    expect(within(limitRows).getByText(/Omitted evidence is not a clean result/i)).toBeTruthy();
    expect(within(limitRows).getByText(/exhausted, so further evidence was not reviewed/i)).toBeTruthy();
  });

  it('uses Standard scan only for positive, non-adverse model coverage evidence', () => {
    render(<ReportCoverage model={modelOnly()} />);

    expect(screen.getByRole('status').textContent).toContain('Standard scan');
    expect(screen.getByText(/No numeric omissions were reported, but coverage is incomplete/i)).toBeTruthy();
    expect(screen.queryByText(/Some node behavior is not modelled/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a model-only result with a recorded limit at Partial analysis', () => {
    const scan = modelOnly();
    const usage = [{ id: 'code-bytes', maximum: 3, examined: 3, omitted: 1, exhausted: true }];
    const mixed = model({ ...scan, v2: { ...scan.v2, limits: { ...scan.v2.limits, usage } }, limits: { usage } });
    render(<ReportCoverage model={mixed} />);

    expect(screen.getByRole('status').textContent).toContain('Partial analysis');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Recorded omissions are not a clean result/i)).toBeTruthy();
    expect(screen.queryByText('Standard scan')).toBeNull();
  });

  it('keeps an unknown diagnostic code at Partial analysis even when it replaces a model notice', () => {
    const scan = modelOnly();
    const first = scan.v2.analysis.diagnostics[0];
    const diagnostic = { ...first, code: 'OPTIONAL_LIMIT_EXCEEDED' };
    const unknown = model({
      ...scan,
      v2: {
        ...scan.v2,
        analysis: {
          ...scan.v2.analysis,
          diagnostics: [diagnostic],
          capabilities: [{ ...scan.v2.analysis.capabilities[0], diagnosticIds: [diagnostic.id] }],
        },
      },
    });
    render(<ReportCoverage model={unknown} />);

    expect(screen.getByRole('status').textContent).toContain('Partial analysis');
    expect(screen.getByText(/OPTIONAL_LIMIT_EXCEEDED/)).toBeTruthy();
    expect(screen.queryByText('Standard scan')).toBeNull();
  });

  it('explains diagnostics that no capability row references without inventing a capability reason', () => {
    const diagnostics = [
      { id: digest, code: 'SEMANTIC_CATALOGUE_MISS', category: 'CATALOGUE', capabilityId: 'workflow-insights', aggregateEffect: 'DEGRADED', assessmentEligible: true },
    ] satisfies readonly AnalysisDiagnosticV2[];
    render(<ReportCoverage model={model({ v2: { ...model().v2, analysis: { status: 'DEGRADED', capabilities: [], diagnostics: [...diagnostics] } } })} />);

    const list = screen.getByRole('list', { name: 'Analysis diagnostics' });
    expect(within(list).getByText('SEMANTIC_CATALOGUE_MISS · DEGRADED')).toBeTruthy();
    expect(within(list).getByText(/no semantic catalogue entry/i)).toBeTruthy();
    expect(within(list).getByText(/not linked to a capability row/i)).toBeTruthy();
  });

  it('renders explicit empty and indeterminate coverage states without a grade', () => {
    const scan = model({
      v2: { ...model().v2, analysis: { status: 'INDETERMINATE', capabilities: [], diagnostics: [] } },
    });
    render(<ReportCoverage model={scan} />);

    expect(screen.getByRole('status').textContent).toContain('Analysis incomplete');
    expect(screen.getByText(/No capability executions were returned/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/No bounded omissions were reported/)).toBeNull();
    expect(screen.getByText(/No numeric omissions were reported, but coverage is incomplete/i)).toBeTruthy();
    expect(screen.queryByText(/risk$/i)).toBeNull();
  });

  it('does not show a green no-omissions cue when analysis has no assessment', () => {
    const base = model();
    const scan = model({
      v2: { ...base.v2, analysis: { status: 'COMPLETE', capabilities: [], diagnostics: [] } },
    });

    render(<ReportCoverage model={scan} />);

    expect(screen.getByRole('status').textContent).toContain('Assessment unavailable');
    expect(screen.queryByText(/No bounded omissions were reported/)).toBeNull();
    expect(screen.getByText(/No numeric omissions were reported, but no risk assessment is available/i)).toBeTruthy();
  });

  it('shows capability omissions without a green clean cue when coverage is incomplete', () => {
    const base = model();
    const scan = model({
      v2: {
        ...base.v2,
        analysis: {
          status: 'DEGRADED',
          capabilities: [{
            id: 'workflow-insights', version: '1.0.0', required: true, status: 'DEGRADED',
            seen: 2, analyzed: 1, skipped: 0, omitted: 1, diagnosticIds: [],
          }],
          diagnostics: [],
        },
        limits: { ...base.v2.limits, usage: [] },
        stats: { ...base.v2.stats, omittedFindings: 0 },
      },
      limits: { usage: [] },
    });

    render(<ReportCoverage model={scan} />);

    expect(screen.getByText(/1 capability unit omitted/)).toBeTruthy();
    expect(screen.getByText(/Recorded omissions are not a clean result/)).toBeTruthy();
    expect(screen.queryByText(/No bounded omissions were reported/)).toBeNull();
  });

  it('composes v2 sections once, never grades degraded analysis, and keeps the v1 fallback intact', () => {
    const v2 = model();
    const { container: sectionsContainer, unmount: unmountSections } = render(<ReportV2Sections model={v2} />);
    expect(sectionsContainer.querySelectorAll('h2')).toHaveLength(4);
    expect(screen.getAllByRole('heading', { name: 'Analysis coverage' })).toHaveLength(1);
    unmountSections();

    const { unmount: unmountV2 } = render(<ReportResult scan={v2} outcomeHeadingRef={ref()} onRetry={() => undefined} />);
    expect(screen.getAllByRole('heading', { name: 'Analysis coverage' })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Evidence and conclusions' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Applicability and target context' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Verified traces' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Readiness and integrations' })).toBeNull();
    expect(screen.queryByText(/LOW risk/)).toBeNull();
    unmountV2();

    render(<ReportResult scan={model({ v2: undefined, assessment: undefined })} outcomeHeadingRef={ref()} onRetry={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Analyst summary' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Readiness and integrations' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Evidence and conclusions' })).toBeNull();
  });

  it('does not claim no grade when a degraded report carries an assessment', () => {
    const base = model();
    const scan = model({
      assessment: {
        score: 80, grade: 'HIGH', scoringPolicyVersion: '2.0.0', basisFindingIds: [],
        excludedReportOnlyFindingIds: [], excludedUncertainFindingIds: [], excludedNotApplicableFindingIds: [],
        unknownEvidenceCount: 0,
      },
      v2: { ...base.v2, analysis: { status: 'DEGRADED', capabilities: [], diagnostics: [] } },
    });
    render(<ReportCoverage model={scan} />);

    expect(screen.queryByText(/no risk grade/i)).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Partial analysis');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/No numeric omissions were reported, but coverage is incomplete/i)).toBeTruthy();
  });

  it('keeps the indeterminate caveat in the decision instead of repeating it in technical sections', () => {
    const base = model();
    const scan = model({
      assessment: null,
      v2: { ...base.v2, analysis: { status: 'INDETERMINATE', capabilities: [], diagnostics: [] } },
    });

    render(<ReportResult scan={scan} outcomeHeadingRef={ref()} onRetry={() => undefined} />);

    expect(screen.getAllByText(/Assessment unavailable because required analysis did not finish/i)).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders both fallback coverage codes (renderer-only)', () => {
    // Renderer-only fixture: it types the two diagnostics but is not a full engine-valid result
    // (`capabilities` is intentionally empty); this test asserts label rendering only.
    const diagnostics = [
      { id: digest, code: 'SEMANTIC_CATALOGUE_MISS', category: 'CATALOGUE', capabilityId: 'workflow-insights', aggregateEffect: 'DEGRADED', assessmentEligible: true },
      { id: 'b'.repeat(64), code: 'GENERIC_NODE_UNMODELED_CAPABILITY', category: 'CATALOGUE', capabilityId: 'workflow-insights', aggregateEffect: 'DEGRADED', assessmentEligible: true },
    ] satisfies readonly AnalysisDiagnosticV2[];
    const scan = model({
      v2: {
        ...model().v2,
        analysis: { status: 'DEGRADED', capabilities: [], diagnostics: [...diagnostics] },
      },
    });
    render(<ReportCoverage model={scan} />);

    const list = screen.getByRole('list', { name: 'Analysis diagnostics' });
    expect(within(list).getByText('SEMANTIC_CATALOGUE_MISS · DEGRADED')).toBeTruthy();
    expect(within(list).getByText('GENERIC_NODE_UNMODELED_CAPABILITY · DEGRADED')).toBeTruthy();
    expect(within(list).getByText(/no semantic catalogue entry/i)).toBeTruthy();
    expect(within(list).getAllByText(/not linked to a capability row/i)).toHaveLength(2);
  });
});
