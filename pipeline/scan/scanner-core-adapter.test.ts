import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { canonicalJson, scannerParityFixtures } from '../../app/src/scanner/__fixtures__/scanner-parity.js';
import { scanWorkflow } from '../../app/src/scanner/engine.js';
import { scanWithScannerCore } from '../../app/src/scanner/scanner-core-adapter.js';
import { scanWorkflowWithCore } from './scanner-core-adapter.js';

function parse(source: unknown) {
  return parseJson(JSON.stringify(source));
}

function parseJson(source: string) {
  const result = parseWorkflowJson(source);
  if (!result.ok) throw new Error(result.code);
  return result.workflow;
}

describe('scanner-core pipeline adapter', () => {
  it.each(
    scannerParityFixtures.filter((fixture) => fixture.kind === 'valid').flatMap((fixture) => [
      { fixture, profile: 'beta-default' as const },
      { fixture, profile: 'beta-hardened' as const },
    ]),
  )('keeps shared-core fields identical to the app adapter for $fixture.id/$profile', ({ fixture, profile }) => {
    const workflow = parseJson(fixture.json);
    const appResult = scanWithScannerCore(workflow, {
      profileId: profile,
      maxAnalyzerFindings: 100,
    });
    const pipelineResult = scanWorkflowWithCore(workflow, {
      policyProfile: profile,
      maxAnalyzerFindings: 100,
    });

    expect(canonicalJson({
      analysisStatus: pipelineResult.analysisStatus,
      diagnostics: pipelineResult.analysisDiagnostics,
      findings: pipelineResult.findings,
      summary: pipelineResult.summary,
    })).toBe(canonicalJson({
      analysisStatus: appResult.analysisStatus,
      diagnostics: appResult.diagnostics,
      findings: appResult.findings,
      summary: appResult.summary,
    }));
  });

  it('returns the pipeline-compatible result from the selected default profile', () => {
    const result = scanWorkflowWithCore(parse({
      nodes: [{ id: '1', name: 'Run command', type: 'n8n-nodes-base.executeCommand' }],
      connections: {},
    }), { policyProfile: 'beta-default' });

    expect(result).toMatchObject({
      schemaVersion: 'scanner-result-v1',
      scannerVersion: 'scanner-beta-1',
      policyProfile: 'beta-default',
      analysisStatus: 'COMPLETE',
      riskAssessment: { grade: 'HIGH', score: 55 },
      summary: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
    });
    expect(result.findings.map((finding) => finding.policyId)).toEqual(['N8N_EXECUTE_COMMAND']);
  });

  it('keeps pipeline risk scoring identical to the browser consumer', () => {
    const fixture = scannerParityFixtures.find((candidate) => candidate.id === 'risky');
    if (!fixture) throw new Error('Missing risky parity fixture');
    const workflow = parseJson(fixture.json);

    const appResult = scanWorkflow(workflow, { policyProfile: 'beta-default' });
    const pipelineResult = scanWorkflowWithCore(workflow, {
      policyProfile: 'beta-default',
    });

    expect(pipelineResult.riskAssessment).toEqual(appResult.riskAssessment);
  });

  it('runs the hardened analyzers while keeping redacted canonical findings', () => {
    const result = scanWorkflowWithCore(parse({
      nodes: [{
        id: '1',
        name: 'Code',
        type: 'n8n-nodes-base.code',
        parameters: { jsCode: 'eval($json.input)' },
      }],
      connections: {},
    }), { policyProfile: 'beta-hardened' });

    expect(result.policyProfile).toBe('beta-hardened');
    expect(result.findings.some((finding) => finding.policyId === 'JAVASCRIPT_DYNAMIC_EXECUTION')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('eval($json.input)');
  });

  it('rejects an unknown profile before running policies', () => {
    expect(() => scanWorkflowWithCore(parse({ nodes: [], connections: {} }), {
      policyProfile: 'not-a-profile' as 'beta-default',
    })).toThrow('Unknown scanner profile: not-a-profile');
  });
});
