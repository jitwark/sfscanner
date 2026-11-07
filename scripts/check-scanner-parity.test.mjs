import { describe, expect, it } from 'vitest';
import {
  projectBrowserEntrySecurity,
  runParityGate,
  validatePipelineParity,
  validateRejectedParity,
  validatePipelineRejection,
  validateSecretGuard,
  validateValidParity,
} from './check-scanner-parity.mjs';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { scanWorkflow } from '../app/src/scanner/engine.js';
import { scanCandidate } from '../pipeline/scan/scan-entry.js';
import { DEFAULT_SCANNER_LIMITS, toWorkflowParseOptions } from '@hub/contracts';

const validFixture = {
  id: 'synthetic-safe',
  kind: 'valid',
  json: JSON.stringify({ nodes: [], connections: {} }),
};

const rejectedFixture = {
  id: 'synthetic-malformed',
  kind: 'rejected',
  json: '{"nodes":[',
  rejectionCode: 'INVALID_JSON',
};

const browserResult = (profile) => ({
  schemaVersion: 'scanner-result-v1',
  scannerVersion: 'scanner-beta-1',
  policyProfile: profile,
  analysisStatus: 'COMPLETE',
  analysisDiagnostics: [],
  findings: [],
  riskAssessment: { score: 0, grade: 'LOW' },
  summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
});

const pipelineResult = {
  schemaVersion: 'scanner-result-v1',
  grade: 'LOW',
  score: 0,
  counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  findings: [],
  hardenedExtra: 0,
  scannerVersion: 'scanner-beta-1',
  profile: 'beta-default',
  analysisStatus: 'COMPLETE',
};

function cliSuccess(result) {
  return {
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({ results: [{ input: '-', ok: true, result }] }),
  };
}

function cliRejection(code) {
  return {
    exitCode: 3,
    stderr: '',
    stdout: JSON.stringify({
      results: [{ input: '-', ok: false, error: { kind: 'input', code, message: 'synthetic rejection' } }],
    }),
  };
}

describe('scanner parity gate', () => {
  it('accepts the complete synthetic valid/rejected matrix in both profiles', async () => {
    const result = await runParityGate({
      fixtures: [validFixture, rejectedFixture],
      scanBrowser: async (_fixture, profile) => browserResult(profile),
      scanCli: async (fixture, profile) => fixture.kind === 'valid'
        ? cliSuccess(browserResult(profile))
        : cliRejection(fixture.rejectionCode),
      scanPipeline: async (fixture) => fixture.kind === 'valid' ? pipelineResult : {
        ...pipelineResult,
        grade: 'UNKNOWN',
        analysisStatus: 'INDETERMINATE',
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      validChecks: 2,
      rejectedChecks: 2,
    }));
  });

  it('accepts an actual scanCandidate result against the browser projection', async () => {
    const parsed = parseWorkflowJson(validFixture.json, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
    if (!parsed.ok) throw new Error('Synthetic valid fixture did not parse');
    const browserResults = {
      'beta-default': scanWorkflow(parsed.workflow, { policyProfile: 'beta-default' }),
      'beta-hardened': scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' }),
    };
    const pipeline = await scanCandidate(
      { id: validFixture.id, json: validFixture.json },
      { scannerVersion: 'scanner-beta-1', scan: (workflow, options) => scanWorkflow(workflow, options) },
    );

    expect(validatePipelineParity({ fixture: validFixture, browserResults, pipelineResult: pipeline })).toEqual({ ok: true, errors: [] });
    expect(pipeline).toEqual(projectBrowserEntrySecurity(browserResults['beta-default'], browserResults['beta-hardened']));
  });

  it('fails closed when pipeline output does not match the browser projection', () => {
    const result = validatePipelineParity({
      fixture: validFixture,
      browserResults: { 'beta-default': browserResult('beta-default'), 'beta-hardened': browserResult('beta-hardened') },
      pipelineResult: { ...pipelineResult, profile: 'beta-hardened' },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('synthetic-safe pipeline output used unexpected profile beta-hardened');
  });

  it('reports a thrown pipeline adapter as a failed gate', async () => {
    const result = await runParityGate({
      fixtures: [validFixture, rejectedFixture],
      scanBrowser: async (_fixture, profile) => browserResult(profile),
      scanCli: async (fixture, profile) => fixture.kind === 'valid' ? cliSuccess(browserResult(profile)) : cliRejection(fixture.rejectionCode),
      scanPipeline: async () => { throw new Error('synthetic pipeline failure'); },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('synthetic-safe pipeline scan failed: synthetic pipeline failure');
  });

  it('requires rejected fixtures to remain indeterminate at the pipeline boundary', () => {
    expect(validatePipelineRejection({ fixture: rejectedFixture, pipelineResult: pipelineResult })).toMatchObject({
      ok: false,
      errors: ['synthetic-malformed pipeline rejection did not fail closed'],
    });
  });

  it('detects a canonical result mismatch', () => {
    const result = validateValidParity({
      fixture: validFixture,
      profile: 'beta-default',
      browserResult: { findings: [], score: 1 },
      cliRun: cliSuccess({ findings: [], score: 2 }),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('synthetic-safe [beta-default] browser/CLI result mismatch');
  });

  it('validates the declared input rejection code', () => {
    expect(validateRejectedParity({
      fixture: rejectedFixture,
      profile: 'beta-default',
      cliRun: cliRejection('WORKFLOW_TOO_LARGE'),
    })).toMatchObject({
      ok: false,
      errors: ['synthetic-malformed [beta-default] expected INVALID_JSON, received WORKFLOW_TOO_LARGE'],
    });
  });

  it('rejects emitted output containing a secret-like fixture value', () => {
    const fixture = {
      ...validFixture,
      json: JSON.stringify({ nodes: [{ parameters: { apiKey: 'synthetic_fixture_secret_value' } }], connections: {} }),
    };

    expect(validateSecretGuard(fixture, { message: 'synthetic_fixture_secret_value' }, 'browser')).toEqual({
      ok: false,
      errors: ['synthetic-safe browser output contains a secret-like fixture value'],
    });
  });
});
