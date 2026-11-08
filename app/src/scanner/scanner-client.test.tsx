import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import type { ScanWorkflowResult } from './engine';
import { SCANNER_RESULT_SCHEMA_VERSION } from '@hub/contracts';
import { ScannerClient } from './scanner-client';
import { runScanV2, ScanError } from './run-scan';
import { toScannerReportModelV2 } from './scanner-v2-presentation';

vi.mock('./run-scan', () => ({
  runScanV2: vi.fn(), // ScannerClient calls runScanV2 (scanner-client.tsx:98) and owns its own AbortController (scanner-client.tsx:88-90)
  ScanError: class ScanError extends Error {
    constructor(public code: string, message: string, public details?: { observedNodeCount?: number }) { super(message); }
  },
}));

function scanResult(name: string): ScanWorkflowResult {
  return {
    schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
    scannerVersion: 'scanner-beta-1', policyProfile: 'beta-default', // v2 emits `profile.id` (scanner-v2-presentation.ts:17), admitted only as 'beta-default' (scanner-v2-adapter.ts:6)
    analysisStatus: 'COMPLETE', analysisDiagnostics: [],
    workflow: { name, nodeCount: 0, rawNodeCount: 0, annotationNodeCount: 0,
      triggerCount: 0, actionCount: 0, integrationCount: 0, connectionCount: 0,
      payloadBytes: 2, complexity: 'LOW', isSubWorkflow: false },
    functionSummary: { basicPurpose: 'Review', triggerDescription: 'None',
      dataFlowSummary: 'None', businessCategory: 'MANUAL_AUTOMATION', confidence: 'HIGH' },
    integrations: [], riskAssessment: { grade: 'LOW', score: 0, topRisks: [],
      dataExposure: 'None', complexityDrivers: [] },
    humanSummary: { headline: 'Review before import', verdict: 'No guarantee of safe execution.',
      plainLanguageOverview: 'Review the workflow.', riskNarrative: 'No priority finding.',
      recommendedActions: ['Review every node'], findingHighlights: [] },
    summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [],
  };
}

const PREREQUISITE_JSON = JSON.stringify({
  name: 'Prerequisite lifecycle',
  nodes: [
    { name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, parameters: { url: '={{ $env.API_URL }}' } },
    { name: 'Child', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1, parameters: { workflowId: '={{ $json.workflowId }}' } },
  ],
  connections: {},
});

const NEXT_PREREQUISITE_JSON = JSON.stringify({
  name: 'Next prerequisite lifecycle',
  nodes: [{ name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 1, parameters: { text: '={{ $vars.MESSAGE }}' } }],
  connections: {},
});

function acceptedScan(json: string): ScanWorkflowResult {
  const outcome = scanWorkflowV2({ bytes: Uint8Array.from(new TextEncoder().encode(json)), profile: { id: 'beta-default', version: '2.0.0' } });
  if (!outcome.ok) throw new Error(outcome.code);
  return toScannerReportModelV2(outcome.result);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ScannerClient request ownership', () => {
  it('binds the safe prerequisite sidecar to the accepted digest and clears it when the draft changes', async () => {
    vi.mocked(runScanV2).mockResolvedValueOnce(acceptedScan(PREREQUISITE_JSON));
    render(<ScannerClient />);
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: PREREQUISITE_JSON } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    const region = await screen.findByRole('region', { name: 'Prerequisites and provenance' });
    expect(region.textContent).toContain('API_URL');
    expect(region.textContent).toContain('Environment value: UNKNOWN');
    fireEvent.click(screen.getByRole('button', { name: 'Edit JSON' }));
    expect(screen.getByRole('region', { name: 'Prerequisites and provenance' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: `${PREREQUISITE_JSON} ` } });
    expect(screen.queryByRole('region', { name: 'Prerequisites and provenance' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Decision and next step' })).toBeTruthy();
    expect(vi.mocked(runScanV2).mock.calls[0]![0]).toMatchObject({ json: PREREQUISITE_JSON, profile: 'beta-default' });
    expect(Object.keys(vi.mocked(runScanV2).mock.calls[0]![0]).sort()).toEqual([
      'approvedDomains', 'json', 'onProgress', 'profile', 'signal',
    ]);
  });

  it('refuses a stale digest without storing or rendering collector rows', async () => {
    vi.mocked(runScanV2).mockResolvedValueOnce(acceptedScan(PREREQUISITE_JSON));
    render(<ScannerClient />);
    const input = screen.getByLabelText('Workflow JSON');
    fireEvent.change(input, { target: { value: NEXT_PREREQUISITE_JSON } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('IDENTITY_MISMATCH');
    expect(alert.textContent).not.toContain('Bridge');
    expect(screen.queryByText('API_URL')).toBeNull();
  });

  it.each([
    ['new run and failure', 'failure'],
    ['cancel', 'cancel'],
  ] as const)('clears prerequisites on %s and refuses late completion', async (_label, path) => {
    const next = deferred<ScanWorkflowResult | 'cancelled'>();
    vi.mocked(runScanV2)
      .mockResolvedValueOnce(acceptedScan(PREREQUISITE_JSON))
      .mockReturnValueOnce(next.promise);
    render(<ScannerClient />);
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: PREREQUISITE_JSON } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));
    await screen.findByRole('region', { name: 'Prerequisites and provenance' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit JSON' }));
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    expect(screen.queryByRole('region', { name: 'Prerequisites and provenance' })).toBeNull();
    if (path === 'cancel') {
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel scan' }));
      await act(async () => next.resolve(acceptedScan(PREREQUISITE_JSON)));
    } else {
      await act(async () => next.reject(new ScanError('TIMEOUT', 'worker detail')));
    }
    expect(screen.queryByRole('region', { name: 'Prerequisites and provenance' })).toBeNull();
  });

  it('rebuilds the sidecar under the retry generation even when the JSON is unchanged', async () => {
    vi.mocked(runScanV2)
      .mockResolvedValueOnce(acceptedScan(PREREQUISITE_JSON))
      .mockRejectedValueOnce(new ScanError('TIMEOUT', 'worker detail'))
      .mockResolvedValueOnce(acceptedScan(PREREQUISITE_JSON));
    render(<ScannerClient />);
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: PREREQUISITE_JSON } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));
    await screen.findByRole('region', { name: 'Prerequisites and provenance' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit JSON' }));
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));
    await screen.findByRole('button', { name: 'Retry scan' });
    expect(screen.queryByRole('region', { name: 'Prerequisites and provenance' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry scan' }));
    expect(await screen.findByRole('region', { name: 'Prerequisites and provenance' })).toBeTruthy();
    expect(vi.mocked(runScanV2).mock.calls[1]![0].json).toBe(vi.mocked(runScanV2).mock.calls[2]![0].json);
  });

  it('keeps the scanner shell visible before a report result exists', () => {
    render(<ScannerClient />);

    expect(screen.getByRole('heading', { name: 'Scan a workflow' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Workflow JSON' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Analyst summary' })).toBeNull();
  });

  it('ignores a cancelled request that settles after a newer scan', async () => {
    const first = deferred<ScanWorkflowResult | 'cancelled'>();
    const second = deferred<ScanWorkflowResult | 'cancelled'>();
    vi.mocked(runScanV2).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<ScannerClient />);
    const input = screen.getByLabelText('Workflow JSON');
    fireEvent.change(input, { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel scan' })); // cancelCurrentScan aborts the client-owned controller (scanner-client.tsx:124-135)
    expect(vi.mocked(runScanV2).mock.calls[0]![0].signal?.aborted).toBe(true);
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: NEXT_PREREQUISITE_JSON } });
    fireEvent.click(await screen.findByRole('button', { name: 'Scan workflow' }));

    await act(async () => second.resolve(acceptedScan(NEXT_PREREQUISITE_JSON)));
    const current = await screen.findByRole('region', { name: 'Prerequisites and provenance' });
    expect(current.textContent).toContain('$vars.MESSAGE');
    await act(async () => first.resolve(acceptedScan(PREREQUISITE_JSON)));

    expect(current.textContent).toContain('$vars.MESSAGE');
    expect(current.textContent).not.toContain('$env.API_URL');
  });

  it('offers a 44px retry that recreates a failed scan request', async () => {
    vi.mocked(runScanV2)
      .mockRejectedValueOnce(new ScanError('INTERNAL' as never, 'Scanner worker failed.'))
      .mockResolvedValueOnce(scanResult('Recovered result'));
    render(<ScannerClient />);
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: PREREQUISITE_JSON } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    const retry = await screen.findByRole('button', { name: 'Retry scan' });
    expect(retry.className).toContain('min-h-11');
    fireEvent.click(retry);

    expect(await screen.findByText('Recovered result')).toBeTruthy();
    await waitFor(() => expect(runScanV2).toHaveBeenCalledTimes(2));
  });

  it('preserves the workflow input after a recoverable scan error', async () => {
    vi.mocked(runScanV2).mockRejectedValueOnce(new ScanError('INTERNAL' as never, 'Scanner worker failed.'));
    render(<ScannerClient />);
    const input = screen.getByLabelText('Workflow JSON') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '{"nodes":[{"name":"keep me"}]}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    await screen.findByRole('button', { name: 'Retry scan' });
    expect((screen.getByLabelText('Workflow JSON') as HTMLTextAreaElement).value)
      .toBe('{"nodes":[{"name":"keep me"}]}');
  });

  it('offers a one-click retry for an indeterminate result', async () => {
    const incomplete = {
      ...scanResult('Incomplete result'), analysisStatus: 'INDETERMINATE' as const,
      riskAssessment: undefined, humanSummary: undefined, summary: undefined,
    };
    vi.mocked(runScanV2).mockResolvedValueOnce(incomplete).mockResolvedValueOnce(scanResult('Recovered result'));
    render(<ScannerClient />);
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    expect(await screen.findByText('Risk assessment unavailable.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry scan' })); // in-report CTA; client error retry uses the same label.

    expect(await screen.findByText('Recovered result')).toBeTruthy();
    expect(runScanV2).toHaveBeenCalledTimes(2);
  });

  it('tolerates repeated cancel without starting or resurrecting a run', async () => {
    const pending = deferred<ScanWorkflowResult | 'cancelled'>();
    vi.mocked(runScanV2).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(scanResult('Fresh result'));
    render(<ScannerClient />);
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));
    const cancel = await screen.findByRole('button', { name: 'Cancel scan' });
    const request = vi.mocked(runScanV2).mock.calls[0]![0];

    act(() => {
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(request.signal?.aborted).toBe(true);
    expect(runScanV2).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve(scanResult('Late result')));
    expect(screen.queryByText('Late result')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));
    expect(await screen.findByText('Fresh result')).toBeTruthy();
    expect(runScanV2).toHaveBeenCalledTimes(2);
  });

  it('cancels the in-flight scan and ignores a late result on unmount', async () => {
    const pending = deferred<ScanWorkflowResult | 'cancelled'>();
    vi.mocked(runScanV2).mockReturnValueOnce(pending.promise);
    const { unmount } = render(<ScannerClient />);
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: PREREQUISITE_JSON } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));
    await screen.findByRole('button', { name: 'Cancel scan' });

    unmount();

    expect(vi.mocked(runScanV2).mock.calls[0]![0].signal?.aborted).toBe(true); // unmount cleanup aborts the client's own controller (scanner-client.tsx:72-75)
    // A result arriving after unmount must not touch state on the gone component.
    await act(async () => pending.resolve(acceptedScan(PREREQUISITE_JSON)));
    expect(screen.queryByRole('region', { name: 'Prerequisites and provenance' })).toBeNull();
  });

  it('shows cancellable progress, announces phases only, and returns to a usable idle surface', async () => {
    const pending = deferred<ScanWorkflowResult | 'cancelled'>();
    vi.mocked(runScanV2).mockReturnValueOnce(pending.promise);
    render(<ScannerClient />);
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    const status = screen.getByRole('status', { name: 'Scan status' });
    expect(status.textContent).toBe('Reading workflow JSON…'); // optimistic parse phase
    expect(screen.getByRole('progressbar', { name: 'Scan progress' }).getAttribute('aria-valuenow')).toBe('10');
    expect(screen.getByRole('button', { name: 'Cancel scan' }).className).toContain('h-11'); // 44px target
    expect((screen.getByRole('button', { name: 'Scanning…' }) as HTMLButtonElement).disabled).toBe(true); // submit stays mounted but cannot re-enter the run
    expect((screen.getByRole('button', { name: 'Cancel scan' }) as HTMLButtonElement).disabled).toBe(false); // cancel stays operable

    const request = vi.mocked(runScanV2).mock.calls[0]![0];
    act(() => request.onProgress?.('analyse', 60));

    expect(status.textContent).toBe('Analyzing workflow topology…');
    expect(status.textContent).not.toMatch(/[0-9%:]/); // no percentage, no clock: the tick never enters the live region
    expect(screen.getByRole('timer').closest('[aria-live], [role="status"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel scan' }));
    expect(request.signal?.aborted).toBe(true); // cancelCurrentScan aborts the client-owned controller (scanner-client.tsx:124-135)
    expect(status.textContent).toBe('');
    expect(screen.getByLabelText('Workflow JSON')).toBeTruthy();
    await act(async () => pending.resolve('cancelled'));
  });

  it('moves focus to the result heading after a successful scan', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(runScanV2).mockResolvedValueOnce(scanResult('Focused result'));
      render(<ScannerClient />);
      fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: '{}' } });
      fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

      await act(async () => { await Promise.resolve(); });
      const heading = screen.getByRole('heading', { name: 'Analyst summary' });
      expect(document.activeElement).toBe(heading);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a timed-out scan with a fresh request and a signal it never aborted', async () => {
    const first = deferred<ScanWorkflowResult>();
    vi.mocked(runScanV2)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(scanResult('Recovered result'));
    render(<ScannerClient />);
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    await act(async () => { first.reject(new ScanError('TIMEOUT', 'worker detail')); });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('TIMEOUT');
    expect(alert.textContent).toContain('30-second local time budget');

    const retry = screen.getByRole('button', { name: 'Retry scan' });
    fireEvent.click(retry);
    expect(await screen.findByText('Recovered result')).toBeTruthy();

    const calls = vi.mocked(runScanV2).mock.calls;
    expect(calls).toHaveLength(2);
    // Same workflow, and the retry's own controller was not the aborted one.
    expect(calls[1]![0].json).toBe(calls[0]![0].json);
    expect(calls[1]![0].signal).not.toBe(calls[0]![0].signal);
    expect(calls[1]![0].signal?.aborted).toBe(false);
  });

  it.each([
    ['INVALID_JSON', 'This is not valid JSON.', false],
    ['NOT_A_WORKFLOW', 'This JSON has no n8n workflow nodes array.', false],
    ['TOO_LARGE', 'This workflow is over the', false],
    ['TOO_MANY_NODES', 'This workflow has more than', false],
    ['TOO_MANY_EDGES', 'more connections between nodes than', false],
    ['CONNECTIONS_TOO_DEEP', 'nested deeper than', false],
    ['PARAMETERS_TOO_COMPLEX', 'parameters that are larger or more deeply nested', false],
    ['DOCUMENT_TOO_DEEP', 'JSON nesting exceeds the browser scanner', false],
    ['DUPLICATE_LOCATIONS_TOO_COMPLEX', 'source locations exceed the browser scanner', false],
    ['TIMEOUT', '30-second local time budget', true],
    ['INTERNAL', 'The local scanner worker failed.', true],
  ] as const)('maps %s to actionable guidance', async (code, expected, retryable) => {
    vi.mocked(runScanV2).mockRejectedValueOnce(new ScanError(code, 'worker detail'));
    render(<ScannerClient />);
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    expect(await screen.findByText(expected, { exact: false })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(code);
    expect(screen.queryByRole('button', { name: 'Retry scan' }) !== null).toBe(retryable);
  });

  it('never tells a PARAMETERS_TOO_COMPLEX rejection it has too many nodes (AUDIT-SCAN-003)', async () => {
    vi.mocked(runScanV2).mockRejectedValueOnce(new ScanError('PARAMETERS_TOO_COMPLEX', 'worker detail'));
    render(<ScannerClient />);
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('5,000 nodes');
    expect(alert.textContent).not.toContain('more than');
  });

  it('names the real observed node count when the worker supplies it', async () => {
    vi.mocked(runScanV2).mockRejectedValueOnce(
      new ScanError('TOO_MANY_NODES', 'worker detail', { observedNodeCount: 6431 }),
    );
    render(<ScannerClient />);
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    expect(await screen.findByText('6,431', { exact: false })).toBeTruthy();
  });
});
