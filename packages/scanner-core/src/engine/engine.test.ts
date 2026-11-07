import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { parseSourceDocument } from '../source/source-parser';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import { parseWorkflowJson, type NormalizedWorkflow } from '../workflow';
import type { ScanFinding, ScanPolicy } from '../policy/policy';
import type { RuleCatalogEntry } from '../policy/rule-catalog';
import { betaHardenedRuleCatalog } from '../policy/rule-catalog';
import type { AnalyzerContextV2 } from '../capabilities/scheduler';
import { RULE_PACK_DIGEST_V2 } from '../capabilities/candidate-validator';
import { resolvePolicyProfile } from '../policies/profile';
import { scanCapabilitiesV2, scanWorkflowCore, type CoreAnalyzer } from './engine';

const encoder = new TextEncoder();
const rules = new Map(betaHardenedRuleCatalog.map((entry) => [entry.policyId, {
  ruleId: entry.policyId, revision: '1', capabilityId: entry.policyId.startsWith('N8N_') || entry.policyId.startsWith('RAW_') || entry.policyId === 'UNAPPROVED_DOMAIN' || entry.policyId === 'UNKNOWN_NODE_PACKAGE' || entry.policyId === 'WEBHOOK_EXPOSURE' ? 'structural-policies' : entry.policyId === 'JAVASCRIPT_DYNAMIC_EXECUTION' ? 'javascript-security' : entry.policyId === 'PYTHON_DYNAMIC_EXECUTION' ? 'python-security' : entry.policyId === 'AI_AGENT_UNGATED_TOOL' ? 'agentic-control' : 'taint-integrity', effect: entry.policyEffect === 'REPORT_ONLY' ? 'REPORT_ONLY' as const : 'SCORING' as const, severity: entry.defaultSeverity, confidence: entry.defaultConfidence, evidenceSchemaId: entry.policyId.startsWith('N8N_') ? 'v1.node-type' : entry.policyId === 'RAW_AUTH_HEADER' ? 'v1.auth-header' : entry.policyId === 'RAW_SECRET_INDICATOR' ? 'v1.secret-indicator' : entry.policyId === 'UNAPPROVED_DOMAIN' ? 'v1.domain' : entry.policyId === 'UNKNOWN_NODE_PACKAGE' ? 'v1.node-package' : entry.policyId === 'WEBHOOK_EXPOSURE' ? 'v1.webhook-auth' : entry.policyId.includes('DYNAMIC') ? 'v1.code-indicator' : entry.policyId === 'AI_AGENT_UNGATED_TOOL' ? 'v1.agent-control' : 'v1.taint', remediationId: 'r', cweIds: [...entry.cweIds], owaspAgenticIds: [...(entry.owaspAgenticIds ?? [])], packDigest: RULE_PACK_DIGEST_V2,
}]));

const catalog: readonly RuleCatalogEntry[] = [
  {
    policyId: 'LEGACY', defaultSeverity: 'HIGH', defaultConfidence: 'HIGH', precision: 'HIGH',
    policyEffect: 'LEGACY_SCORE', curationAction: 'NONE', serveAction: 'DISPLAY', cweIds: [],
  },
  {
    policyId: 'ADVISORY', defaultSeverity: 'MEDIUM', defaultConfidence: 'MEDIUM', precision: 'MEDIUM',
    policyEffect: 'REPORT_ONLY', curationAction: 'REVIEW', serveAction: 'DISPLAY', cweIds: [],
  },
  {
    policyId: 'ANALYZER', defaultSeverity: 'LOW', defaultConfidence: 'HIGH', precision: 'HIGH',
    policyEffect: 'REPORT_ONLY', curationAction: 'REVIEW', serveAction: 'DISPLAY', cweIds: [],
  },
];

function workflow(): NormalizedWorkflow {
  const parsed = parseWorkflowJson(JSON.stringify({
    nodes: [{ id: 'node-1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} }],
    connections: {},
  }));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
}
function capabilityContext(): AnalyzerContextV2 {
  const sourceResult = parseSourceDocument(encoder.encode('{"nodes":[],"connections":{}}'), DEFAULT_SCANNER_LIMITS_V2);
  if (!sourceResult.ok) throw new Error(sourceResult.message);
  const workflowResult = normalizeSecurityWorkflow(sourceResult.document, DEFAULT_SCANNER_LIMITS_V2);
  if (!workflowResult.ok) throw new Error(workflowResult.message);
  return {
    source: sourceResult.document,
    workflow: workflowResult.workflow,
    target: {
      schemaVersion: 'scanner-target-v3',
      edition: 'COMMUNITY',
      deployment: 'SELF_HOSTED',
      role: 'OWNER',
      taskRunner: 'NATIVE',
      communityPackages: [],
      configuration: [],
      contextDigest: 'c'.repeat(64),
    },
    limits: DEFAULT_SCANNER_LIMITS_V2,
    semantics: { id: 'semantics', version: '1', digest: 's'.repeat(64), resolvedNodeSemantics: new Map() },
    rules: { id: 'rules', version: '1', digest: 'r'.repeat(64), rules },
    priorOutcomes: new Map(),
  };
}

describe('scanCapabilitiesV2', () => {
  it('reaches the admitted beta-default adapter through the engine boundary', () => {
    const profile = resolvePolicyProfile('beta-default');
    const result = scanCapabilitiesV2(capabilityContext(), profile);
    expect('ok' in result).toBe(false);
    if ('ok' in result) return;
    expect(result.executions.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'source-normalization', status: 'COMPLETED' },
      { id: 'workflow-insights', status: 'COMPLETED' },
      { id: 'structural-policies', status: 'COMPLETED' },
      { id: 'assessment', status: 'COMPLETED' },
      { id: 'presentation-facts', status: 'COMPLETED' },
    ]);
  });

  it('returns a closed result before scanning non-admitted and unknown profiles', () => {
    const hardened = scanCapabilitiesV2(capabilityContext(), resolvePolicyProfile('beta-hardened'));
    const unknown = scanCapabilitiesV2(capabilityContext(), resolvePolicyProfile('unknown'));

    expect(hardened).toEqual({ ok: false, code: 'PROFILE_NOT_ADMITTED', profileId: 'beta-hardened' });
    expect(unknown).toEqual({ ok: false, code: 'UNKNOWN_PROFILE', profileId: 'unknown' });
  });

  it('rejects a forged admitted profile before invoking its registry factory', () => {
    const canonical = resolvePolicyProfile('beta-default');
    if (!canonical.ok) throw new Error('expected beta-default to be admitted');
    let factoryCalls = 0;
    const forged = {
      ...canonical,
      capabilityManifest: null,
      createCapabilityRegistry: () => {
        factoryCalls += 1;
        throw new Error('forged factory detail');
      },
    };

    expect(scanCapabilitiesV2(capabilityContext(), forged)).toEqual({
      ok: false,
      code: 'PROFILE_NOT_ADMITTED',
      profileId: 'beta-default',
    });
    expect(factoryCalls).toBe(0);
  });

  it('returns a typed unknown result for a success-shaped unknown profile', () => {
    const canonical = resolvePolicyProfile('beta-default');
    if (!canonical.ok) throw new Error('expected beta-default to be admitted');
    const forged = { ...canonical, profileId: 'missing-profile' as never };

    expect(scanCapabilitiesV2(capabilityContext(), forged)).toEqual({
      ok: false,
      code: 'UNKNOWN_PROFILE',
      profileId: 'missing-profile',
    });
  });
});

function finding(policyId: string, severity: ScanFinding['severity'] = 'LOW'): ScanFinding {
  return {
    policyId,
    title: `${policyId} finding`,
    severity,
    location: { nodeId: 'node-1', nodeName: 'Start' },
    evidence: { source: policyId },
    message: 'Review this finding.',
    explanation: 'The workflow requires review.',
    whyItMatters: 'It may affect workflow safety.',
    possibleImpact: 'Unexpected behavior may occur.',
    remediation: 'Apply the documented control.',
    remediationSteps: ['Apply the documented control.'],
    confidence: 'HIGH',
  };
}

function policy(evaluate: ScanPolicy['evaluate']): ScanPolicy {
  return { id: 'test-policy', name: 'Test policy', description: 'Test policy', evaluate };
}

describe('scanWorkflowCore', () => {
  it('returns policy findings in order and preserves catalog report-only effects', () => {
    const result = scanWorkflowCore(workflow(), {
      policies: [policy(() => [finding('LEGACY', 'HIGH'), finding('ADVISORY', 'MEDIUM')])],
      ruleCatalog: catalog,
    });

    expect(result.findings.map(({ policyId, policyEffect }) => [policyId, policyEffect])).toEqual([
      ['LEGACY', 'LEGACY_SCORE'],
      ['ADVISORY', 'REPORT_ONLY'],
    ]);
    expect(result.policyFailureCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
  });

  it('appends analyzer findings and diagnostics in declared order', () => {
    const diagnostic = { code: 'JAVASCRIPT_PARSE_FAILED', category: 'PARSER' } as const;
    const analyzers: CoreAnalyzer[] = [
      () => ({ findings: [finding('ANALYZER')], diagnostics: [diagnostic] }),
      () => ({ findings: [finding('ADVISORY')], diagnostics: [{ code: 'GRAPH_ANALYSIS_DEGRADED', category: 'GRAPH' }] }),
    ];

    const result = scanWorkflowCore(workflow(), {
      policies: [policy(() => [finding('LEGACY')])], analyzers, ruleCatalog: catalog,
    });

    expect(result.findings.map((entry) => entry.policyId)).toEqual(['LEGACY', 'ANALYZER', 'ADVISORY']);
    expect(result.diagnostics.slice(0, 2)).toEqual([
      { code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY' },
      { code: 'GRAPH_ANALYSIS_DEGRADED', category: 'GRAPH' },
    ]);
  });

  it('reduces a required parser failure to REQUIRED_STAGE_FAILURE and keeps findings', () => {
    const analyzer: CoreAnalyzer = () => ({
      findings: [finding('ANALYZER')],
      diagnostics: [{ code: 'JAVASCRIPT_PARSE_FAILED', category: 'PARSER' }],
    });
    const result = scanWorkflowCore(workflow(), { policies: [], analyzers: [analyzer], ruleCatalog: catalog });
    expect(result.analysisStatus).toBe('INDETERMINATE');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('REQUIRED_STAGE_FAILURE');
    expect(result.findings).toHaveLength(1);
  });

  it('isolates a thrown policy, keeps other findings, and records an indeterminate failure', () => {
    const result = scanWorkflowCore(workflow(), {
      policies: [
        policy(() => { throw new Error('secret policy detail'); }),
        policy(() => [finding('LEGACY')]),
      ],
      ruleCatalog: catalog,
    });

    expect(result.findings.map((entry) => entry.policyId)).toEqual(['LEGACY']);
    expect(result.policyFailureCount).toBe(1);
    expect(result.diagnostics).toEqual([{ code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' }]);
    expect(result.analysisStatus).toBe('INDETERMINATE');
    expect(JSON.stringify(result)).not.toContain('secret policy detail');
  });

  it('bounds analyzer findings while leaving legacy findings uncapped', () => {
    const result = scanWorkflowCore(workflow(), {
      policies: [policy(() => [finding('LEGACY'), finding('LEGACY', 'HIGH')])],
      analyzers: [() => ({ findings: [finding('ANALYZER'), finding('ANALYZER'), finding('ANALYZER')], diagnostics: [] })],
      ruleCatalog: catalog,
      maxAnalyzerFindings: 1,
    });

    expect(result.findings).toHaveLength(3);
    expect(result.findings.filter((entry) => entry.policyId === 'LEGACY')).toHaveLength(2);
    expect(result.findings.filter((entry) => entry.policyId === 'ANALYZER')).toHaveLength(1);
    expect(result.diagnostics).toContainEqual({ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' });
    expect(result.analysisStatus).toBe('DEGRADED');
  });

  it('collapses duplicate findings and exposes the collapse diagnostic', () => {
    const result = scanWorkflowCore(workflow(), {
      policies: [policy(() => [finding('LEGACY'), finding('LEGACY')])], ruleCatalog: catalog,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.collapsedCount).toBe(1);
    expect(result.diagnostics).toContainEqual({ code: 'DUPLICATE_FINDING_COLLAPSED', category: 'POLICY' });
    expect(result.analysisStatus).toBe('DEGRADED');
  });

  it('summarizes canonical findings deterministically and counts report-only findings', () => {
    const result = scanWorkflowCore(workflow(), {
      policies: [policy(() => [finding('LEGACY', 'CRITICAL'), finding('ADVISORY', 'MEDIUM')])],
      ruleCatalog: catalog,
    });

    expect(result.summary).toEqual({ critical: 1, high: 0, medium: 1, low: 0, info: 0 });
    expect(result.analysisStatus).toBe('COMPLETE');
    expect(result.diagnostics).toEqual([]);
  });

  it('produces byte-identical JSON for repeated scans', () => {
    const options = {
      policies: [policy(() => [finding('LEGACY', 'HIGH')])],
      analyzers: [() => ({ findings: [finding('ANALYZER')], diagnostics: [] })],
      ruleCatalog: catalog,
    };

    expect(JSON.stringify(scanWorkflowCore(workflow(), options)))
      .toBe(JSON.stringify(scanWorkflowCore(workflow(), options)));
  });
});
