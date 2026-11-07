import { describe, expect, it } from 'vitest';
import { createMockScanResult } from './run-scan.test-support';
import { parseScanWorkflowResult } from './scan-result-validation';

describe('parseScanWorkflowResult', () => {
  it.each([undefined, 'scanner-result-v0'])('rejects a missing or unsupported schema identity: %s', (schemaVersion) => {
    const valid = createMockScanResult('beta-default');
    expect(parseScanWorkflowResult({ ...valid, schemaVersion })).toBeNull();
  });

  it('accepts the worker result contract', () => {
    expect(parseScanWorkflowResult(createMockScanResult('beta-default'))?.scannerVersion).toBe('scanner-beta-1');
  });

  it('rejects inconsistent summaries, status, and dangerous nested evidence', () => {
    const valid = createMockScanResult('beta-default');
    expect(parseScanWorkflowResult({ ...valid, summary: { ...valid.summary, low: 1 } })).toBeNull();
    expect(parseScanWorkflowResult({ ...valid, analysisStatus: 'INDETERMINATE' })).toBeNull();
    expect(parseScanWorkflowResult({ ...valid, findings: [{ ...valid.findings[0], evidence: { __proto__: 'bad' } }] })).toBeNull();
  });

  // AUDIT-SCAN-001: this diagnostic is how a malformed connection target index reaches the
  // UI (it is what stops a scan from crossing the browser worker boundary as a falsely
  // COMPLETE result). If this boundary rejected or mis-shaped it, the fix in
  // `@hub/scanner-core` would never actually reach a user — same silent-drop failure mode
  // one layer up.
  it('accepts a DEGRADED result carrying a MALFORMED_CONNECTION_INDEX diagnostic across the worker boundary', () => {
    const valid = createMockScanResult('beta-default');
    const degraded = {
      ...valid,
      analysisStatus: 'DEGRADED' as const,
      analysisDiagnostics: [
        { code: 'MALFORMED_CONNECTION_INDEX' as const, category: 'GRAPH' as const, location: { path: '/connections/Webhook/main/0/0/index' } },
      ],
    };

    const parsed = parseScanWorkflowResult(degraded);
    expect(parsed).not.toBeNull();
    expect(parsed?.analysisStatus).toBe('DEGRADED');
    expect(parsed?.analysisDiagnostics).toEqual(degraded.analysisDiagnostics);
  });
});
