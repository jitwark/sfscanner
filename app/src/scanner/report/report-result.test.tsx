import type { RefObject } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import cleanJsonFixture from '../../../e2e/fixtures/clean.json';
import fallbackJsonFixture from '../../../e2e/fixtures/fallback.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import type { ScanWorkflowResult } from '../engine';
import { createMockScanResult } from '../run-scan.test-support';
import { toScannerReportModelV2, type ScannerReportModelV2 } from '../scanner-v2-presentation';
import { ReportResult } from './report-result';
import { createPrerequisiteSidecar, type ReportPrerequisitesModel } from '../prerequisite-sidecar';
import { buildExportReport } from './report-export';

const fixture = (name: 'clean.json' | 'fallback.json') => JSON.stringify(name === 'clean.json' ? cleanJsonFixture : fallbackJsonFixture);
const RAW_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const UNREADABLE = JSON.stringify({
  nodes: [
    { id: 'Start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
    { id: 'Broken', name: 'Broken', type: 'n8n-nodes-base.discord', typeVersion: 1, parameters: 'not-an-object' },
  ],
  connections: {},
});
const UNKNOWN_INNOCENT = JSON.stringify({
  nodes: [
    { id: 'Start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
    { id: 'Unknown', name: 'Unknown', type: 'n8n-nodes-base.discord', typeVersion: 1, parameters: { url: 'https://example.invalid/x' } },
  ],
  connections: { Start: { main: [[{ node: 'Unknown', type: 'main', index: 0 }]] } },
});

/** The real pipeline boundary: worker engine envelope -> the model the report consumes. */
function reportModel(json: string): ScannerReportModelV2 {
  const result = scanWorkflowV2({ bytes: Uint8Array.from(new TextEncoder().encode(json)), profile: { id: 'beta-default', version: '2.0.0' } });
  if (!result.ok) throw new Error(result.code);
  return toScannerReportModelV2(result.result);
}

function ref(): RefObject<HTMLHeadingElement | null> {
  return { current: null };
}

function renderReport(scan: ScanWorkflowResult, prerequisites?: ReportPrerequisitesModel) {
  return render(<ReportResult scan={scan} prerequisites={prerequisites} outcomeHeadingRef={ref()} onRetry={vi.fn()} />);
}

describe('ReportResult', () => {
  it('renders a closed prerequisite projection with exact pointers and live unknowns without leaking a secret canary', () => {
    const credentialCanary = 'credential-secret-canary-b7d1';
    const parameterCanary = 'sk-live-parameter-canary-4f2a';
    const keyCanary = 'private-dynamic-key-canary';
    const json = JSON.stringify({
      name: 'Prerequisite canary',
      nodes: [
        { name: 'Duplicate', type: 'n8n-nodes-base.slack', typeVersion: 1, credentials: {
          'a/b~c': { id: credentialCanary, name: 'Shared account' },
        }, parameters: { options: { headers: { authorization: `Bearer ${parameterCanary}` } } } },
        { name: 'Duplicate', type: 'n8n-nodes-base.slack', typeVersion: 2, credentials: { slackApi: { id: 'cred-2' } }, parameters: {} },
        { name: 'Community', type: 'n8n-nodes-acme.extension', typeVersion: '2.1', parameters: {
          url: '{{ $env.API_URL }}', [keyCanary]: '{{ $env.HIDDEN }}',
        } },
        { name: 'Dynamic child', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1, parameters: { workflowId: '={{ $json.workflowId }}' } },
        { name: 'Literal child', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1, parameters: { workflowId: 'child-123' } },
        { name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 1, parameters: { text: '{{ $vars.MESSAGE }}' } },
      ],
      connections: {},
    });
    const scan = reportModel(json);
    const prerequisites = createPrerequisiteSidecar(json, 7, scan);
    renderReport(scan, prerequisites);

    const region = screen.getByRole('region', { name: 'Prerequisites and provenance' });
    const report = within(region);
    expect(report.getByText('/nodes/0/credentials/a~1b~0c')).toBeTruthy();
    expect(report.getByText(/\$env\.API_URL/)).toBeTruthy();
    expect(report.getByText(/\$vars\.MESSAGE/)).toBeTruthy();
    expect(report.getByRole('heading', { name: 'Community packages' })).toBeTruthy();
    expect(report.getByRole('heading', { name: 'Integrations' })).toBeTruthy();
    expect(report.getByRole('heading', { name: 'Subworkflows' })).toBeTruthy();
    expect(report.getAllByText(/Environment value: UNKNOWN/).length).toBe(2);
    expect(report.getAllByText(/Environment availability: UNKNOWN/).length).toBe(2);
    expect(report.getAllByText(/Ownership: UNKNOWN/).length).toBeGreaterThan(0);
    expect(report.getByText(/Installed: UNKNOWN/)).toBeTruthy();
    expect(report.getAllByText('Target existence: UNKNOWN').length).toBe(2);
    expect(report.getByText(/Environment evidence omitted: yes/)).toBeTruthy();
    expect(report.getByText(/Repository: UNKNOWN/)).toBeTruthy();
    expect(report.queryByText(/nothing required/i)).toBeNull();
    expect(region.textContent).not.toContain(credentialCanary);
    expect(region.textContent).not.toContain(parameterCanary);
    expect(region.textContent).not.toContain(keyCanary);
    expect(JSON.stringify(buildExportReport(scan))).not.toContain('prerequisites');
  });

  it('renders an identity mismatch as unavailable and never as a clean inventory', () => {
    const scan = reportModel(fixture('clean.json'));
    const prerequisites = createPrerequisiteSidecar('{"nodes":[{"type":"n8n-nodes-base.set"}],"connections":{}}', 3, scan);
    renderReport(scan, prerequisites);

    const region = screen.getByRole('region', { name: 'Prerequisites and provenance' });
    expect(within(region).getByRole('alert').textContent).toContain('IDENTITY_MISMATCH');
    expect(region.textContent).not.toMatch(/no prerequisites|nothing required/i);
  });

  afterEach(cleanup);

  it('moves focus to the summary after the lazy report has mounted', async () => {
    const outcomeHeadingRef = { current: null } as RefObject<HTMLHeadingElement | null>;
    render(<ReportResult scan={createMockScanResult('beta-default')} outcomeHeadingRef={outcomeHeadingRef} onRetry={vi.fn()} />);

    const heading = screen.getByRole('heading', { name: 'Analyst summary' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('keeps the v1 report shape and grade when no v2 model is attached', () => {
    renderReport(createMockScanResult('beta-default'));

    expect(screen.getByRole('heading', { name: 'Analyst summary' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Readiness and integrations' })).toBeTruthy();
    expect(screen.getAllByText('LOW risk').length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Analysis coverage' })).toBeNull();
  });

  it('renders the worker grade and score for a complete v2 envelope with a truthful empty state', () => {
    const scan = reportModel(fixture('clean.json'));
    expect(scan.v2.analysis.status).toBe('COMPLETE');
    const assessment = scan.assessment!;

    renderReport(scan);

    expect(screen.getByLabelText('Analysis status: Analysis complete')).toBeTruthy();
    expect(screen.getByText(`${assessment.grade} risk`)).toBeTruthy();
    expect(screen.getByLabelText(`Risk score: ${assessment.score} out of 100`)).toBeTruthy();
    expect(screen.queryByText('No grade')).toBeNull();
    expect(screen.getAllByText(/No findings were returned for this scan\./).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Analysis did not complete/i)).toBeNull();
  });

  it('renders a graded degraded v2 envelope with both coverage codes and its retained, redacted finding', () => {
    const scan = reportModel(fixture('fallback.json'));
    expect(scan.v2.analysis.status).toBe('DEGRADED');
    expect(scan.assessment).not.toBeNull();

    const { container } = renderReport(scan);

    expect(screen.getByLabelText('Analysis status: Standard scan')).toBeTruthy();
    expect(screen.getAllByText(/Some node behavior is not modelled/i).length).toBeGreaterThan(0);
    expect(screen.getByText(`${scan.assessment!.grade} risk`)).toBeTruthy();
    expect(screen.getByText('SEMANTIC_CATALOGUE_MISS · DEGRADED')).toBeTruthy();
    expect(screen.getByText('GENERIC_NODE_UNMODELED_CAPABILITY · DEGRADED')).toBeTruthy();
    expect(screen.getByText('Workflow parameters contain raw secret material')).toBeTruthy();
    expect(screen.getAllByText('RAW_SECRET_INDICATOR', { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('HIGH').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain(RAW_SECRET);
  });

  it('labels a real readable unmodelled node Standard scan with the model caveat', () => {
    const scan = reportModel(UNKNOWN_INNOCENT);
    expect(scan.v2.analysis.status).toBe('DEGRADED');
    expect(scan.assessment).not.toBeNull();

    renderReport(scan);

    expect(screen.getByLabelText('Analysis status: Standard scan')).toBeTruthy();
    expect(screen.getAllByText(/Some node behavior is not modelled/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('No grade')).toBeNull();
  });

  it('keeps a genuine indeterminate result ungraded and explicitly non-conclusive', () => {
    const scan = reportModel(UNREADABLE);
    expect(scan.v2.analysis.status).toBe('INDETERMINATE');
    expect(scan.assessment).toBeNull();

    renderReport(scan);

    expect(screen.getByLabelText('Analysis status: Analysis incomplete')).toBeTruthy();
    expect(screen.getAllByText(/Assessment unavailable because required analysis did not finish/i).length).toBeGreaterThan(0);
    expect(screen.getByText('No grade')).toBeTruthy();
    expect(screen.queryByLabelText(/^Risk score:/)).toBeNull();
    expect(screen.queryByText(/^(?:LOW|MEDIUM|HIGH|CRITICAL) risk$/)).toBeNull();
    expect(screen.getByText(/Analysis did not complete; no findings can be treated as conclusive/)).toBeTruthy();
  });
});
