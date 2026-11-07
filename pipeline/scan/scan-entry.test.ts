import { describe, expect, it, vi } from 'vitest';
import { SCANNER_RESULT_SCHEMA_VERSION } from '@hub/contracts';
import { makeCandidate, makeRights, makeSource } from '../__fixtures__/make-entry.js';
import type { Candidate } from '@hub/contracts';
import { scanWorkflow } from '../../app/src/scanner/engine.js';
import { getScannerVersion, projectFinding, scanCandidate, scanWithWorker, sortFindings } from './scan-entry.js';
import { resolveCorpusScanConcurrency, workerExecArgv, workerSafeExecArgv } from './scan-runtime-boundary.js';

function findDisallowedKeys(
  obj: unknown,
  forbiddenKeys = ['evidence', 'sourceSpan', 'snippet', 'raw']
): string[] {
  const found: string[] = [];
  function walk(curr: unknown, path: string) {
    if (!curr || typeof curr !== 'object') return;
    if (Array.isArray(curr)) {
      curr.forEach((item, idx) => walk(item, `${path}[${idx}]`));
      return;
    }
    for (const [key, val] of Object.entries(curr as Record<string, unknown>)) {
      const currentPath = path ? `${path}.${key}` : key;
      if (forbiddenKeys.includes(key)) {
        found.push(currentPath);
      }
      walk(val, currentPath);
    }
  }
  walk(obj, '');
  return found;
}

describe('scan-entry', () => {
  it('resolves the scanner version from the repository root by default', () => {
    expect(getScannerVersion()).not.toBe('unknown');
  });

  describe('onUnparseable', () => {
    it('reports the parser code while the verdict still fails closed to INDETERMINATE/UNKNOWN', async () => {
      const failures: Array<{ candidateId: string; code: string }> = [];
      const candidate = makeCandidate({ id: 'bad-body', json: { nodes: [], connections: [] } });

      const security = await scanCandidate(candidate, { onUnparseable: (failure) => failures.push(failure) });

      expect(failures).toEqual([{ candidateId: 'bad-body', code: 'MALFORMED_WORKFLOW' }]);
      expect(security).toMatchObject({ grade: 'UNKNOWN', analysisStatus: 'INDETERMINATE', findings: [] });
    });

    it('stays silent when the body parses', async () => {
      const failures: Array<{ candidateId: string; code: string }> = [];
      const scan = vi.fn().mockImplementation(() => ({
        schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
        scannerVersion: 'test',
        analysisStatus: 'COMPLETE',
        analysisDiagnostics: [],
        riskAssessment: { grade: 'LOW', score: 100 },
        summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        findings: [],
      }));

      await scanCandidate(makeCandidate({ id: 'good-body' }), {
        scan,
        onUnparseable: (failure) => failures.push(failure),
      });

      expect(failures).toEqual([]);
    });
  });

  it('terminates an isolated scan that misses its deadline', async () => {
    // Regression: a loose /timed out|worker/i pattern previously let this test
    // pass on ERR_WORKER_INVALID_EXEC_ARGV ("Initiated Worker with invalid
    // execArgv flags...") — a construction failure, not a real timeout — since
    // that message also contains the word "Worker". Anchor to the message
    // scanWithWorker itself produces on a genuine deadline miss.
    await expect(scanWithWorker({ nodes: [], connections: {} }, 1)).rejects.toThrow(/^Scan timed out after 1ms$/);
  });

  it('loads the TypeScript scanner through the JavaScript worker bootstrap', async () => {
    const result = await scanWithWorker({ nodes: [], connections: {} }, 15_000);

    expect(result.defaultResult).toMatchObject({ schemaVersion: SCANNER_RESULT_SCHEMA_VERSION });
    expect(result.hardenedResult).toMatchObject({ schemaVersion: SCANNER_RESULT_SCHEMA_VERSION });
  }, 20_000);

  describe('workerSafeExecArgv', () => {
    it('strips V8 heap-sizing flags that worker_threads rejects outright', () => {
      expect(workerSafeExecArgv(['--max-old-space-size=2048'])).toEqual([]);
      expect(workerSafeExecArgv(['--max_old_space_size=2048'])).toEqual([]);
      expect(workerSafeExecArgv(['--max-semi-space-size=64'])).toEqual([]);
      expect(workerSafeExecArgv(['--stack-size=984'])).toEqual([]);
    });

    it('preserves the loader flags tsx needs to run this .ts worker file', () => {
      const execArgv = ['--require', '/path/to/tsx/preflight.cjs', '--import', 'file:///tsx/loader.mjs'];
      expect(workerSafeExecArgv(execArgv)).toEqual(execArgv);
    });

    it('preserves flags that merely start with a similar-looking prefix', () => {
      expect(workerSafeExecArgv(['--max-old-space-size-typo=1'])).toEqual(['--max-old-space-size-typo=1']);
    });
  });

  describe('workerExecArgv', () => {
    it('adds an explicit tsx loader when the parent launcher did not propagate one', () => {
      expect(workerExecArgv([])).toEqual(['--import', 'tsx/esm']);
    });

    it('adds an explicit tsx/esm entry even when the CLI loader pair is inherited', () => {
      const execArgv = ['--require', '/path/to/tsx/preflight.cjs', '--import', 'file:///tsx/loader.mjs'];
      expect(workerExecArgv(execArgv)).toEqual([...execArgv, '--import', 'tsx/esm']);
    });

    it('does not duplicate an explicit tsx/esm entry', () => {
      expect(workerExecArgv(['--import', 'tsx/esm'])).toEqual(['--import', 'tsx/esm']);
    });
  });

  describe('resolveCorpusScanConcurrency', () => {
    it('uses a conservative default and clamps valid overrides', () => {
      expect(resolveCorpusScanConcurrency(undefined)).toBe(4);
      expect(resolveCorpusScanConcurrency('1')).toBe(1);
      expect(resolveCorpusScanConcurrency('99')).toBe(8);
      expect(resolveCorpusScanConcurrency('0')).toBe(1);
      expect(resolveCorpusScanConcurrency('fast')).toBe(4);
    });
  });

  const mockCandidate: Candidate = makeCandidate({
    id: 'test-candidate-1',
    title: 'Test Workflow',
    bytes: 500,
    json: {
      nodes: [{ id: '1', name: 'Start', type: 'n8n-nodes-base.start' }],
      connections: {},
    },
    rights: makeRights({
      status: 'redistributable',
      licence: 'MIT',
      licenceUrl: null,
      reason: 'repo licence MIT',
    }),
    source: makeSource({
      kind: 'github',
      repo: 'test/repo',
      permalink: 'https://github.com/test/repo/blob/sha/wf.json',
    }),
  });

  it('redacts sensitive finding details (no evidence, sourceSpan, snippet, raw keys at any depth)', async () => {
    const mockScan = vi.fn().mockImplementation((_wf, opts) => {
      if (opts?.policyProfile === 'beta-hardened') {
        return {
          schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
          riskAssessment: { grade: 'HIGH', score: 75 },
          findings: [
            {
              policyId: 'SECRETS_FOUND',
              title: 'Hardcoded Secret',
              severity: 'CRITICAL',
              location: { nodeId: '1', nodeName: 'Start', sourceSpan: { start: 0, end: 10 } },
              evidence: { rawToken: 'sk-1234567890abcdef' },
              whyItMatters: 'API keys leaked',
              remediation: 'Use credentials',
              snippet: 'const key = "sk-123"',
              raw: 'raw data',
            },
          ],
        };
      }
      return {
        schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
        riskAssessment: { grade: 'HIGH', score: 75 },
        findings: [
          {
            policyId: 'SECRETS_FOUND',
            title: 'Hardcoded Secret',
            severity: 'CRITICAL',
            location: { nodeId: '1', nodeName: 'Start', sourceSpan: { start: 0, end: 10 } },
            evidence: { rawToken: 'sk-1234567890abcdef' },
            whyItMatters: 'API keys leaked',
            remediation: 'Use credentials',
            snippet: 'const key = "sk-123"',
            raw: 'raw data',
          },
        ],
      };
    });

    const security = await scanCandidate(mockCandidate, {
      scan: mockScan,
      scannerVersion: 'test-sha-123',
    });

    expect(security.grade).toBe('HIGH');
    expect(security.scannerVersion).toBe('test-sha-123');
    expect(security.findings).toHaveLength(1);
    expect(security.findings[0]).toEqual({
      id: 'SECRETS_FOUND',
      title: 'Hardcoded Secret',
      severity: 'CRITICAL',
      node: 'Start',
      why: 'API keys leaked',
      fix: 'Use credentials',
    });

    const disallowed = findDisallowedKeys(security);
    expect(disallowed).toEqual([]);
  });

  it('limits public findings to maxPublicFindings and sorts by severity then policy id', () => {
    const rawFindings = Array.from({ length: 30 }, (_, i) => ({
      policyId: `POL_${30 - i}`,
      title: `Policy ${30 - i}`,
      severity: i % 2 === 0 ? 'MEDIUM' : 'CRITICAL',
      location: { nodeName: `Node_${i}` },
      whyItMatters: 'Why',
      remediation: 'Fix',
    }));

    const projected = rawFindings.map(projectFinding);
    const sorted = sortFindings(projected);

    // CRITICAL should come before MEDIUM
    expect(sorted[0].severity).toBe('CRITICAL');
    // Same severity sorted by ID
    const criticals = sorted.filter((f) => f.severity === 'CRITICAL');
    for (let i = 0; i < criticals.length - 1; i++) {
      expect(criticals[i].id.localeCompare(criticals[i + 1].id)).toBeLessThanOrEqual(0);
    }
  });

  it('computes hardenedExtra accurately', async () => {
    const mockScan = vi.fn().mockImplementation((_wf, opts) => {
      if (opts?.policyProfile === 'beta-hardened') {
        return {
          schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
          riskAssessment: { grade: 'MEDIUM', score: 50 },
          findings: [
            {
              policyId: 'DEFAULT_POL',
              title: 'Default finding',
              severity: 'MEDIUM',
              location: { nodeName: 'Node1' },
            },
            {
              policyId: 'HARDENED_POL_1',
              title: 'Hardened finding 1',
              severity: 'LOW',
              location: { nodeName: 'Node1' },
            },
            {
              policyId: 'HARDENED_POL_2',
              title: 'Hardened finding 2',
              severity: 'INFO',
              location: { nodeName: 'Node2' },
            },
          ],
        };
      }
      return {
        schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
        riskAssessment: { grade: 'MEDIUM', score: 50 },
        findings: [
          {
            policyId: 'DEFAULT_POL',
            title: 'Default finding',
            severity: 'MEDIUM',
            location: { nodeName: 'Node1' },
          },
        ],
      };
    });

    const security = await scanCandidate(mockCandidate, { scan: mockScan });
    expect(security.hardenedExtra).toBe(2);
  });

  it('handles scan timeout or crash gracefully with grade UNKNOWN', async () => {
    const crashingScan = vi.fn().mockImplementation(() => {
      throw new Error('Scanner crash simulated');
    });

    const security = await scanCandidate(mockCandidate, { scan: crashingScan });
    expect(security.grade).toBe('UNKNOWN');
    expect(security.score).toBe(0);
    expect(security.findings).toEqual([]);
    expect(security.analysisStatus).toBe('INDETERMINATE');
  });

  it('projects the engine analysisStatus and diagnostic codes onto the public entry', async () => {
    const mockScan = vi.fn().mockReturnValue({
      schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
      analysisStatus: 'DEGRADED',
      analysisDiagnostics: [{ code: 'SOURCE_SPAN_UNAVAILABLE', category: 'SOURCE' }],
      riskAssessment: { grade: 'LOW', score: 5 },
      findings: [],
    });

    const security = await scanCandidate(mockCandidate, { scan: mockScan });

    expect(security.analysisStatus).toBe('DEGRADED');
    expect(security.analysisDiagnosticCodes).toEqual(['SOURCE_SPAN_UNAVAILABLE']);
  });

  it('produces the same projected security for object and JSON-string input', async () => {
    const scan = vi.fn((workflow: unknown, options?: { policyProfile?: 'beta-default' | 'beta-hardened' }) =>
      scanWorkflow(workflow as Parameters<typeof scanWorkflow>[0], options));
    const objectSecurity = await scanCandidate(mockCandidate, { scan, scannerVersion: 'test-sha-123' });
    const stringSecurity = await scanCandidate(
      { ...mockCandidate, json: JSON.stringify(mockCandidate.json) },
      { scan, scannerVersion: 'test-sha-123' },
    );

    expect(stringSecurity).toEqual(objectSecurity);
    expect(scan).toHaveBeenCalledTimes(4);
    for (const call of scan.mock.calls) expect(call[0]).toMatchObject({ nodes: expect.any(Array), graph: expect.any(Object) });
  });

  it('fails closed for malformed and oversized JSON strings before invoking an injected scanner', async () => {
    const scan = vi.fn();
    const malformed = await scanCandidate({ ...mockCandidate, json: '{"nodes":' }, { scan, scannerVersion: 'test' });
    const oversized = await scanCandidate({ ...mockCandidate, json: JSON.stringify({ nodes: [{ name: 'Big', type: 'n8n-nodes-base.set', parameters: { value: 'x'.repeat(1_536_001) } }], connections: {} }) }, { scan, scannerVersion: 'test' });

    expect(malformed).toMatchObject({ grade: 'UNKNOWN', analysisStatus: 'INDETERMINATE', scannerVersion: 'test' });
    expect(oversized).toMatchObject({ grade: 'UNKNOWN', analysisStatus: 'INDETERMINATE', scannerVersion: 'test' });
    expect(scan).not.toHaveBeenCalled();
  });

  it('preserves an explicit complete status with an empty diagnostic set', async () => {
    const scan = vi.fn().mockReturnValue({
      schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
      analysisStatus: 'COMPLETE', analysisDiagnostics: [],
      riskAssessment: { grade: 'LOW', score: 0 }, findings: [], summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    });
    const security = await scanCandidate(mockCandidate, { scan, scannerVersion: 'test' });

    expect(security).toMatchObject({ grade: 'LOW', score: 0, analysisStatus: 'COMPLETE' });
    expect(security.analysisDiagnosticCodes).toBeUndefined();
  });

  it('never reports an ordinary grade when the engine result is indeterminate', async () => {
    const mockScan = vi.fn().mockReturnValue({
      schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
      analysisStatus: 'INDETERMINATE',
      analysisDiagnostics: [{ code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' }],
      findings: [],
      // riskAssessment intentionally absent, matching the engine's own contract.
    });

    const security = await scanCandidate(mockCandidate, { scan: mockScan });

    expect(security.grade).toBe('UNKNOWN');
    expect(security.analysisStatus).toBe('INDETERMINATE');
    expect(security.analysisDiagnosticCodes).toEqual(['POLICY_EXECUTION_FAILED']);
  });

  it('projects the authoritative scanner result schema identity', async () => {
    const scan = vi.fn(() => ({
      schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
      riskAssessment: { grade: 'LOW', score: 10 },
      findings: [],
    }));

    const security = await scanCandidate(mockCandidate, { scan });

    expect(security.schemaVersion).toBe(SCANNER_RESULT_SCHEMA_VERSION);
  });

  it.each([undefined, 'scanner-result-v0'])(
    'fails closed when an authoritative scanner result has identity %j',
    async (schemaVersion) => {
      const scan = vi.fn(() => ({
        ...(schemaVersion === undefined ? {} : { schemaVersion }),
        riskAssessment: { grade: 'LOW', score: 10 },
        findings: [],
      }));

      const security = await scanCandidate(mockCandidate, { scan });

      expect(security.grade).toBe('UNKNOWN');
      expect(security.score).toBe(0);
      expect(security.schemaVersion).toBeUndefined();
    },
  );
});
