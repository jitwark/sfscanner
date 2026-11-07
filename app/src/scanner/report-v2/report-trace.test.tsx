import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { ReportTrace } from './report-trace';

const digest = 'd'.repeat(64);

function model(traces: unknown[]): ScannerReportModelV2 {
  return { v2: { schemaVersion: 'scanner-result-v2', traces } } as unknown as ScannerReportModelV2;
}

describe('ReportTrace', () => {
  afterEach(cleanup);
  it('shows verified trace metadata and redacted source-span state without raw payload', () => {
    render(<ReportTrace model={model([{
      traceId: digest, kind: 'CONFIDENTIALITY', payload: 'sk_live_trace_secret', steps: [
        { ordinal: 0, kind: 'SOURCE', subject: { kind: 'SOURCE', source: { pointer: '/nodes/0', occurrencePath: [], astNodeId: digest, span: { start: { line: 2, column: 1, utf16Offset: 2, utf8ByteOffset: 2 }, end: { line: 2, column: 8, utf16Offset: 9, utf8ByteOffset: 9 } } } }, factRefs: [digest] },
        { ordinal: 1, kind: 'SINK', subject: { kind: 'WORKFLOW' }, factRefs: [] },
      ],
    }])} />);

    expect(screen.getByRole('heading', { name: 'Verified traces' })).toBeTruthy();
    expect(screen.getByText(/CONFIDENTIALITY trace/)).toBeTruthy();
    expect(screen.getByText(/Step 1 · SOURCE/)).toBeTruthy();
    expect(screen.getByText(/Source span: line 2, column 1 to line 2, column 8/)).toBeTruthy();
    expect(screen.getByText(/Step 2 · SINK/)).toBeTruthy();
    expect(screen.getByText(/Source span unavailable/)).toBeTruthy();
    expect(screen.getByText(/2 verified steps/)).toBeTruthy();
    expect(screen.queryByText(/sk_live_trace_secret/)).toBeNull();
    expect(screen.queryByText(/\/nodes\/0/)).toBeNull();
  });

  it('makes absent traces explicit', () => {
    render(<ReportTrace model={model([])} />);

    expect(screen.getByRole('note').textContent).toContain('No verified trace was returned');
  });
});
