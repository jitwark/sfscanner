import type { NormalizedWorkflow } from '@hub/scanner-core/workflow';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { scanWorkflow, type ScanWorkflowResult } from '../../app/src/scanner/engine.js';
import { scannerParityFixtures, canonicalJson } from '../../app/src/scanner/__fixtures__/scanner-parity.js';
import { makeCandidate } from '../__fixtures__/make-entry.js';
import {
  DEFAULT_SCANNER_LIMITS,
  LIMITS,
  SCANNER_RESULT_SCHEMA_VERSION,
  toWorkflowParseOptions,
  type PublicFinding,
} from '@hub/contracts';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { scanCandidate } from './scan-entry.js';

const severityWeight: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
const scannerVersion = 'parity-fixture';

function scanBrowserInput(input: unknown, options?: { policyProfile?: 'beta-default' | 'beta-hardened' }): ScanWorkflowResult {
  if (isNormalizedWorkflow(input)) return scanWorkflow(input, options);
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  const parsed = parseWorkflowJson(raw, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
  if (!parsed.ok) throw new Error(parsed.code);
  return scanWorkflow(parsed.workflow, options);
}

function isNormalizedWorkflow(value: unknown): value is NormalizedWorkflow {
  return Boolean(value && typeof value === 'object' && 'fingerprint' in value && 'graph' in value);
}

function projectBrowserResult(defaultResult: ScanWorkflowResult, hardenedResult: ScanWorkflowResult): Record<string, unknown> {
  const project = (finding: ScanWorkflowResult['findings'][number]): PublicFinding => ({
    id: finding.policyId,
    title: finding.title,
    severity: finding.severity,
    ...(finding.location.nodeName || finding.location.nodeId ? { node: finding.location.nodeName ?? finding.location.nodeId } : {}),
    why: finding.whyItMatters,
    fix: finding.remediation,
  });
  const findings = defaultResult.findings.map(project).sort((left, right) =>
    severityWeight[left.severity]! - severityWeight[right.severity]! || left.id.localeCompare(right.id));
  const defaultKeys = new Set(defaultResult.findings.map((finding) => `${finding.policyId}:${finding.location.nodeName ?? finding.location.nodeId ?? ''}`));
  const hardenedExtra = hardenedResult.findings.filter((finding) =>
    !defaultKeys.has(`${finding.policyId}:${finding.location.nodeName ?? finding.location.nodeId ?? ''}`),
  ).length;

  return {
    schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
    grade: defaultResult.riskAssessment?.grade ?? 'UNKNOWN',
    score: defaultResult.riskAssessment?.score ?? 0,
    counts: defaultResult.summary ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    findings: findings.slice(0, LIMITS.maxPublicFindings),
    hardenedExtra,
    scannerVersion,
    profile: 'beta-default',
    ...(defaultResult.analysisStatus ? { analysisStatus: defaultResult.analysisStatus } : {}),
    ...(defaultResult.analysisDiagnostics.length > 0
      ? { analysisDiagnosticCodes: defaultResult.analysisDiagnostics.map((diagnostic) => diagnostic.code) }
      : {}),
  };
}

const validCases = scannerParityFixtures
  .filter((fixture) => fixture.kind === 'valid')
  .flatMap((fixture) => [
    { ...fixture, inputKind: 'object' as const, input: JSON.parse(fixture.json) },
    { ...fixture, inputKind: 'json-string' as const, input: fixture.json },
  ]);

function candidate(id: string, json: unknown) {
  return makeCandidate({ id, json });
}

function canonicalSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('browser and pipeline scanner parity', () => {
  it('pins the redacted risky result contract and canonical hash', async () => {
    const fixture = scannerParityFixtures.find((candidate) => candidate.id === 'risky');
    if (!fixture) throw new Error('Missing risky parity fixture');

    const browserInput = JSON.parse(fixture.json);
    const browserDefault = scanBrowserInput(browserInput, { policyProfile: 'beta-default' });
    const browserHardened = scanBrowserInput(browserInput, { policyProfile: 'beta-hardened' });
    const expected = projectBrowserResult(browserDefault, browserHardened);
    const pipeline = await scanCandidate(candidate(fixture.id, fixture.json), { scannerVersion, scan: scanBrowserInput });

    expect(pipeline).toEqual(expected);
    expect(pipeline).toMatchObject({
      schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
      scannerVersion,
      profile: 'beta-default',
      analysisStatus: 'COMPLETE',
      grade: 'CRITICAL',
    });
    expect((pipeline.findings as PublicFinding[]).map((finding) => finding.id)).toEqual([
      'N8N_EXECUTE_COMMAND', 'RAW_SECRET_INDICATOR', 'WEBHOOK_EXPOSURE',
    ]);
    expect(canonicalJson(pipeline)).not.toContain('sk_live_parity_fixture_secret');
    expect(canonicalSha256(canonicalJson(pipeline))).toBe('11a87d934ef1a36ad6067bc8876ca6e4353f7a397fe863eb2b70477cd1bc935a');
  });

  it.each(validCases)(
    'matches canonical public output for the $id $inputKind fixture',
    async ({ id, input }) => {
      const browserInput = JSON.parse(JSON.stringify(input));
      const browserDefault = scanBrowserInput(browserInput, { policyProfile: 'beta-default' });
      const browserHardened = scanBrowserInput(browserInput, { policyProfile: 'beta-hardened' });
      const pipeline = await scanCandidate(candidate(id, input), { scannerVersion, scan: scanBrowserInput });

      expect(canonicalJson(pipeline)).toBe(canonicalJson(projectBrowserResult(browserDefault, browserHardened)));
    },
  );

  it.each(scannerParityFixtures.filter((fixture) => fixture.kind === 'rejected'))(
    'fails closed for the $id JSON string without invoking the scanner',
    async ({ id, json }) => {
      const scan = vi.fn(scanBrowserInput);
      const pipeline = await scanCandidate(candidate(id, json), { scannerVersion, scan });

      expect(scan).not.toHaveBeenCalled();
      expect(pipeline).toMatchObject({ grade: 'UNKNOWN', score: 0, findings: [], analysisStatus: 'INDETERMINATE' });
    },
  );
});
