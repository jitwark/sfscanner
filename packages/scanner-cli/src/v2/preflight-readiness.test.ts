import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLATFORM_FACTS_V1,
  PREFLIGHT_DISCLAIMER_V1,
  PREFLIGHT_SEVERITIES_V1,
  buildPreflightReadinessReport,
  type PlatformCompatibilityFactV1,
  type PreflightAnalysisSignalsV1,
} from './preflight-readiness';
import { collectPreflightInventory as collectLegacyPreflightInventory } from './preflight-readiness-prerequisites';
import { collectPreflightInventory as collectSharedPreflightInventory } from '@hub/contracts/preflight-prerequisites';
import { pinnedTargetFactV1 } from './preflight-target-facts';

type NodeInput = Readonly<Record<string, unknown>>;

/** Affirmative analysis evidence: the only shape that may support a COMPLETE verdict. */
function fullAnalysis(supportedNodes: number): PreflightAnalysisSignalsV1 {
  return Object.freeze({ supportedNodes, unsupportedNodes: 0, unresolvedEdges: 0, ambiguities: 0, truncated: false });
}

function node(name: string, type: string, extra: NodeInput = {}): NodeInput {
  return { name, type, typeVersion: 1, parameters: {}, ...extra };
}

function workflow(nodes: readonly NodeInput[], extra: NodeInput = {}): NodeInput {
  return { name: 'Preflight workflow', nodes: [...nodes], connections: {}, settings: {}, ...extra };
}

const TARGET_FACTS: readonly PlatformCompatibilityFactV1[] = Object.freeze([
  Object.freeze({
    featureId: 'data-tables',
    description: 'Data Tables node family',
    nodeTypes: Object.freeze(['n8n-nodes-base.dataTable']),
    supportedTargets: Object.freeze(['2.x'] as const),
    source: 'pinned:data-table-node',
  }),
  Object.freeze({
    featureId: 'code-node-v2',
    description: 'Code node typeVersion 2',
    nodeTypes: Object.freeze(['n8n-nodes-base.code']),
    supportedTargets: Object.freeze(['1.x', '2.x'] as const),
    maxTypeVersionByTarget: Object.freeze({ '1.x': '1.0.0', '2.x': '2.0.0' }),
    source: 'pinned:code-node-versions',
  }),
  Object.freeze({
    featureId: 'wait-http-resume',
    description: 'Wait node HTTP resume',
    nodeTypes: Object.freeze([] as string[]),
    supportedTargets: Object.freeze(['2.x'] as const),
    source: 'pinned:wait-node',
  }),
]);

describe('preflight readiness', () => {
  it('serves byte-identical legacy collector output from the browser-safe shared contract', () => {
    const input = workflow([
      node('Duplicate', 'n8n-nodes-base.slack', {
        credentials: { 'a/b~c': { id: 'credential-id', name: 'Shared account' } },
        parameters: { options: { headers: { authorization: '{{ $env.API_TOKEN }}' } } },
      }),
      node('Duplicate', 'n8n-nodes-base.httpRequest', {
        parameters: { url: '{{ $env.API_URL }}', options: { ['dynamic/secret']: '{{ $env.HIDDEN }}' } },
      }),
      node('Child', 'n8n-nodes-base.executeWorkflow', { parameters: { workflowId: '={{ $json.workflowId }}' } }),
      node('Extension', 'n8n-nodes-acme.extension', { typeVersion: '2.1', parameters: { text: '{{ $vars.MESSAGE }}' } }),
    ]);

    const shared = collectSharedPreflightInventory(input);
    const legacy = collectLegacyPreflightInventory(input);

    expect(shared).toEqual(legacy);
    expect(JSON.stringify(shared)).toBe(JSON.stringify(legacy));
    expect(shared.prerequisites.credentials[0]?.pointer).toBe('/nodes/0/credentials/a~1b~0c');
    expect(shared.prerequisites.integrations[0]?.evidence.map(({ pointer }) => pointer)).toEqual(['/nodes/1']);
    expect(shared.prerequisites.environment.map(({ name, evidence }) => [name, evidence.pointer])).toEqual([
      ['API_URL', '/nodes/1/parameters/url'],
      ['MESSAGE', '/nodes/3/parameters/text'],
    ]);
    expect(shared.environmentIncomplete).toEqual({ computed: false, omitted: true });
    expect(shared.prerequisites.subworkflows).toEqual([
      expect.objectContaining({ node: 'Child', pointer: '/nodes/2/parameters/workflowId', resolution: 'DYNAMIC', targetExistence: 'UNKNOWN' }),
    ]);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shared.prerequisites.environment)).toBe(true);
  });

  it('keeps analysis completeness separate from finding severity', () => {
    const clean = buildPreflightReadinessReport({ workflow: workflow([node('Set', 'n8n-nodes-base.set')]), analysis: fullAnalysis(1) });
    expect(clean.schemaVersion).toBe('n8n-preflight-readiness-v1');
    expect(clean.completeness.status).toBe('COMPLETE');
    expect(clean.completeness.reasons).toEqual([]);
    expect(clean.findings.total).toBe(0);
    expect(clean.findings.highestSeverity).toBeNull();
    expect(clean.findings.bySeverity).toEqual({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });
    expect(clean.safetyClearance).toBe('NOT_PROVIDED');

    const graded = buildPreflightReadinessReport({
      workflow: workflow([node('Set', 'n8n-nodes-base.set')]),
      analysis: fullAnalysis(1),
      findings: [{ ruleId: 'N8N_CODE_NODE', severity: 'critical' }],
    });
    expect(graded.completeness.status).toBe('COMPLETE');
    expect(graded.findings.highestSeverity).toBe('critical');
    expect(graded.safetyClearance).toBe('NOT_PROVIDED');
  });

  it('never reports COMPLETE without affirmative analysis evidence', () => {
    const target = workflow([node('Set', 'n8n-nodes-base.set')]);
    const statusOf = (analysis: unknown): string =>
      buildPreflightReadinessReport({ workflow: target, analysis: analysis as PreflightAnalysisSignalsV1 }).completeness.status;
    const codesOf = (analysis: unknown): readonly string[] =>
      buildPreflightReadinessReport({ workflow: target, analysis: analysis as PreflightAnalysisSignalsV1 })
        .completeness.reasons.map((reason) => reason.code);

    // An empty signal object proves nothing about analysis coverage.
    expect(statusOf({})).toBe('INDETERMINATE');
    expect(codesOf({})).toEqual(['ANALYSIS_NOT_REPORTED']);
    expect(statusOf(undefined)).toBe('INDETERMINATE');
    expect(codesOf(undefined)).toEqual(['ANALYSIS_NOT_REPORTED']);

    // Partial evidence: a counter or the truncation flag is missing.
    expect(statusOf({ supportedNodes: 1, truncated: false })).toBe('INDETERMINATE');
    expect(statusOf({ unsupportedNodes: 0, unresolvedEdges: 0, ambiguities: 0, truncated: false })).toBe('INDETERMINATE');

    // Malformed evidence: negative, fractional, non-boolean and out-of-range values.
    expect(statusOf({ ...fullAnalysis(1), unsupportedNodes: -1 })).toBe('INDETERMINATE');
    expect(statusOf({ ...fullAnalysis(1), unresolvedEdges: -2 })).toBe('INDETERMINATE');
    expect(statusOf({ ...fullAnalysis(1), ambiguities: 1.5 })).toBe('INDETERMINATE');
    expect(statusOf({ ...fullAnalysis(1), supportedNodes: 1.25 })).toBe('INDETERMINATE');
    expect(statusOf({ ...fullAnalysis(1), supportedNodes: -1 })).toBe('INDETERMINATE');
    expect(statusOf({ ...fullAnalysis(1), supportedNodes: 2 })).toBe('INDETERMINATE');
    expect(statusOf({ ...fullAnalysis(1), truncated: 'false' })).toBe('INDETERMINATE');
    expect(statusOf({ ...fullAnalysis(1), truncated: 0 })).toBe('INDETERMINATE');
    expect(codesOf({ ...fullAnalysis(1), ambiguities: 1.5 })).toEqual(['ANALYSIS_NOT_REPORTED']);

    for (const analysis of [{}, undefined, { supportedNodes: 1 }, { ...fullAnalysis(1), unresolvedEdges: -3 }]) {
      expect(statusOf(analysis)).not.toBe('COMPLETE');
    }
  });

  it('reports COMPLETE only for validated affirmative analysis over supported nodes', () => {
    const report = buildPreflightReadinessReport({
      workflow: workflow([node('Code', 'n8n-nodes-base.code', { typeVersion: 2 })]),
      analysis: { supportedNodes: 1, unsupportedNodes: 0, unresolvedEdges: 0, ambiguities: 0, truncated: false },
    });
    expect(report.completeness.status).toBe('COMPLETE');
    expect(report.completeness.reasons).toEqual([]);
    expect(report.safetyClearance).toBe('NOT_PROVIDED');
    expect(report.disclaimer.id).toBe('NOT_SAFETY_CLEARANCE');

    // Reported support that does not cover every exported node is a degradation, not completeness.
    const partially = buildPreflightReadinessReport({
      workflow: workflow([node('Set', 'n8n-nodes-base.set'), node('HTTP', 'n8n-nodes-base.httpRequest')]),
      analysis: fullAnalysis(1),
    });
    expect(partially.completeness.status).toBe('DEGRADED');
    expect(partially.completeness.reasons.map((reason) => reason.code)).toEqual(['UNSUPPORTED_NODE']);
    expect(partially.completeness.reasons[0]?.count).toBe(1);
  });

  it('does not report COMPLETE for an unknown core-namespace node', () => {
    const target = workflow([{ type: 'n8n-nodes-base.notARealNode' }]);

    const empty = buildPreflightReadinessReport({ workflow: target, analysis: {} });
    expect(empty.completeness.status).toBe('INDETERMINATE');
    expect(empty.completeness.reasons.map((reason) => reason.code)).toContain('ANALYSIS_NOT_REPORTED');

    const noSignals = buildPreflightReadinessReport({ workflow: target });
    expect(noSignals.completeness.status).not.toBe('COMPLETE');

    const affirmative = buildPreflightReadinessReport({ workflow: target, analysis: fullAnalysis(1) });
    expect(affirmative.completeness.status).not.toBe('COMPLETE');
    expect(affirmative.completeness.status).toBe('DEGRADED');
    expect(affirmative.completeness.reasons.map((reason) => reason.code)).toEqual(['UNKNOWN_NODE_TYPE']);
    expect(affirmative.safetyClearance).toBe('NOT_PROVIDED');
  });

  it('keeps local utility nodes out of the external integration inventory', () => {
    const report = buildPreflightReadinessReport({
      workflow: workflow([
        node('Crypto', 'n8n-nodes-base.crypto'),
        node('Crypto hashed', 'n8n-nodes-base.crypto', { parameters: { action: 'hash' } }),
        node('Imaginary', 'n8n-nodes-base.notARealNode'),
        node('Imaginary blank', 'n8n-nodes-base.notARealNode', { credentials: {} }),
      ]),
      analysis: fullAnalysis(4),
    });
    expect(report.prerequisites.integrations).toEqual([]);
    expect(report.completeness.reasons.map((reason) => reason.code)).toEqual(['UNKNOWN_NODE_TYPE']);
    expect(report.completeness.reasons[0]?.count).toBe(2);
    expect(report.completeness.status).toBe('DEGRADED');

    const external = buildPreflightReadinessReport({
      workflow: workflow([
        node('Crypto', 'n8n-nodes-base.crypto'),
        node('Slack', 'n8n-nodes-base.slack', { credentials: { slackApi: { id: 'cred-1' } } }),
        node('HTTP', 'n8n-nodes-base.httpRequest'),
      ]),
      analysis: fullAnalysis(3),
    });
    expect(external.prerequisites.integrations.map((integration) => integration.nodeType)).toEqual([
      'n8n-nodes-base.httpRequest', 'n8n-nodes-base.slack',
    ]);
  });

  it('does not admit an empty credential reference as a known identity or an integration', () => {
    const report = buildPreflightReadinessReport({
      workflow: workflow([node('Imaginary', 'n8n-nodes-base.notARealNode', { credentials: { bogus: {} } })]),
      analysis: fullAnalysis(1),
    });
    expect(report.completeness.reasons.length).toBeGreaterThan(0);
    expect(report.completeness.reasons.map((reason) => reason.code)).toEqual(['UNKNOWN_NODE_TYPE']);
    expect(report.completeness.reasons[0]?.count).toBe(1);
    expect(report.completeness.status).toBe('DEGRADED');
    expect(report.prerequisites.integrations).toEqual([]);

    // A fabricated type outside the official namespaces stays unmodelled even when it declares a credential id.
    const fabricated = buildPreflightReadinessReport({
      workflow: workflow([node('Fabricated', 'notARealNode', { credentials: { bogus: { id: 'cred-1' } } })]),
      analysis: fullAnalysis(1),
    });
    expect(fabricated.completeness.reasons.map((reason) => reason.code)).toEqual(['UNKNOWN_NODE_TYPE']);
    expect(fabricated.prerequisites.integrations).toEqual([]);
  });

  it('degrades a workflow with no findings when a node type is not modelled', () => {
    const report = buildPreflightReadinessReport({
      workflow: workflow([node('Set', 'n8n-nodes-base.set'), node('Stripe', 'n8n-nodes-acme.stripe', { typeVersion: 2 })]),
      analysis: fullAnalysis(2),
      findings: [],
    });
    expect(report.findings.total).toBe(0);
    expect(report.completeness.status).toBe('DEGRADED');
    expect(report.completeness.reasons.map((reason) => reason.code)).toContain('UNKNOWN_NODE_TYPE');
    expect(report.completeness.reasons.find((reason) => reason.code === 'UNKNOWN_NODE_TYPE')?.count).toBe(1);
    expect(report.safetyClearance).toBe('NOT_PROVIDED');
  });

  it('reports degraded completeness from explicit analysis signals and marks absent signals indeterminate', () => {
    const truncated = buildPreflightReadinessReport({
      workflow: workflow([node('Set', 'n8n-nodes-base.set')]),
      analysis: { supportedNodes: 0, unsupportedNodes: 1, unresolvedEdges: 2, ambiguities: 1, truncated: true },
    });
    expect(truncated.completeness.status).toBe('DEGRADED');
    expect(truncated.completeness.reasons.map((reason) => reason.code)).toEqual([
      'UNSUPPORTED_NODE', 'UNRESOLVED_EDGE', 'AMBIGUITY', 'TRUNCATED_ANALYSIS',
    ]);
    expect(truncated.findings.total).toBe(0);

    const unreported = buildPreflightReadinessReport({ workflow: workflow([node('Set', 'n8n-nodes-base.set')]) });
    expect(unreported.completeness.status).toBe('INDETERMINATE');
    expect(unreported.completeness.reasons.map((reason) => reason.code)).toEqual(['ANALYSIS_NOT_REPORTED']);
  });

  it('extracts credential references without claiming offline validity or ownership', () => {
    const report = buildPreflightReadinessReport({
      workflow: workflow([
        node('Slack', 'n8n-nodes-base.slack', { credentials: { slackApi: { id: 'cred-1', name: 'Slack account' } } }),
        node('Mail', 'n8n-nodes-base.gmail', { credentials: { gmailOAuth2: { id: 'cred-2' } } }),
        node('Empty', 'n8n-nodes-base.postgres', { credentials: { postgres: {} } }),
      ]),
      analysis: fullAnalysis(3),
    });
    expect(report.prerequisites.credentials.map((credential) => ({
      type: credential.credentialType,
      name: credential.credentialName,
      reference: credential.reference,
      node: credential.node,
      pointer: credential.pointer,
      validity: credential.offlineValidity,
      ownership: credential.ownership,
    }))).toEqual([
      { type: 'gmailOAuth2', name: null, reference: 'ID_ONLY', node: 'Mail', pointer: '/nodes/1/credentials/gmailOAuth2', validity: 'UNKNOWN', ownership: 'UNKNOWN' },
      { type: 'postgres', name: null, reference: 'EMPTY', node: 'Empty', pointer: '/nodes/2/credentials/postgres', validity: 'UNKNOWN', ownership: 'UNKNOWN' },
      { type: 'slackApi', name: 'Slack account', reference: 'ID_AND_NAME', node: 'Slack', pointer: '/nodes/0/credentials/slackApi', validity: 'UNKNOWN', ownership: 'UNKNOWN' },
    ]);
    expect(report.prerequisites.unknowns.join(' ')).toContain('credential');
  });

  it('never admits a fabricated official type as a known identity or an integration', () => {
    const coreNamespace = buildPreflightReadinessReport({
      workflow: workflow([node('Imaginary', 'n8n-nodes-base.notARealNode', { credentials: { bogus: { id: 'cred-1' } } })]),
      analysis: fullAnalysis(1),
    });
    expect(coreNamespace.completeness.status).toBe('DEGRADED');
    expect(coreNamespace.completeness.reasons.map((reason) => reason.code)).toEqual(['UNKNOWN_NODE_TYPE']);
    expect(coreNamespace.prerequisites.integrations).toEqual([]);

    const langchainNamespace = buildPreflightReadinessReport({
      workflow: workflow([node('Fake chain', '@n8n/n8n-nodes-langchain.fake', { credentials: { bogus: { id: 'cred-1' } } })]),
      analysis: fullAnalysis(1),
    });
    expect(langchainNamespace.completeness.status).toBe('DEGRADED');
    expect(langchainNamespace.completeness.reasons.map((reason) => reason.code)).toEqual(['UNKNOWN_NODE_TYPE']);
    expect(langchainNamespace.prerequisites.integrations).toEqual([]);

    // A whitespace-only identifier is not a credential reference, so it cannot rescue an unmodelled type either.
    const whitespaceReference = buildPreflightReadinessReport({
      workflow: workflow([node('Imaginary blank', 'n8n-nodes-base.notARealNode', { credentials: { bogus: { id: '   ', name: '  ' } } })]),
      analysis: fullAnalysis(1),
    });
    expect(whitespaceReference.completeness.status).toBe('DEGRADED');
    expect(whitespaceReference.completeness.reasons.map((reason) => reason.code)).toEqual(['UNKNOWN_NODE_TYPE']);
    expect(whitespaceReference.prerequisites.integrations).toEqual([]);

    // A modelled service type stays known, but a whitespace-only reference never enters the integration inventory.
    const knownTypeWhitespace = buildPreflightReadinessReport({
      workflow: workflow([node('Slack', 'n8n-nodes-base.slack', { credentials: { slackApi: { id: '   ' } } })]),
      analysis: fullAnalysis(1),
    });
    expect(knownTypeWhitespace.completeness.status).toBe('COMPLETE');
    expect(knownTypeWhitespace.prerequisites.integrations).toEqual([]);
  });

  it('extracts integrations, community packages and subworkflow references', () => {
    const report = buildPreflightReadinessReport({
      workflow: workflow([
        node('Set', 'n8n-nodes-base.set'),
        node('Code', 'n8n-nodes-base.code', { typeVersion: 2 }),
        node('HTTP', 'n8n-nodes-base.httpRequest', { parameters: { url: 'https://example.test' } }),
        node('Slack', 'n8n-nodes-base.slack', { credentials: { slackApi: { id: 'cred-1', name: 'Slack' } } }),
        node('Stripe', 'n8n-nodes-acme.stripe', { typeVersion: 2 }),
        node('Stripe two', 'n8n-nodes-acme.stripe', { typeVersion: '2.1' }),
        node('Child', 'n8n-nodes-base.executeWorkflow', { parameters: { workflowId: 'wf-123' } }),
      ]),
      analysis: fullAnalysis(7),
    });

    expect(report.prerequisites.integrations.map((integration) => integration.nodeType)).toEqual([
      'n8n-nodes-base.httpRequest', 'n8n-nodes-base.slack',
    ]);
    expect(report.prerequisites.integrations.find((i) => i.nodeType === 'n8n-nodes-base.slack')?.credentialTypes).toEqual(['slackApi']);

    expect(report.prerequisites.communityNodes).toEqual([
      expect.objectContaining({
        packageName: 'n8n-nodes-acme',
        nodeTypes: ['n8n-nodes-acme.stripe'],
        nodes: ['Stripe', 'Stripe two'],
        typeVersions: ['2', '2.1'],
        packageVersion: null,
        installed: 'UNKNOWN',
      }),
    ]);
    expect(report.prerequisites.subworkflows).toEqual([
      expect.objectContaining({ node: 'Child', targetWorkflowId: 'wf-123', resolution: 'LITERAL', targetExistence: 'UNKNOWN' }),
    ]);
    expect(report.completeness.status).toBe('DEGRADED');
  });

  it('keeps a dynamic subworkflow id unknown and degrades completeness', () => {
    const report = buildPreflightReadinessReport({
      workflow: workflow([
        node('Child', 'n8n-nodes-base.executeWorkflow', { parameters: { workflowId: '={{ $json.workflowId }}' } }),
        node('Absent', 'n8n-nodes-base.executeWorkflow'),
      ]),
      analysis: fullAnalysis(2),
    });
    expect(report.prerequisites.subworkflows.map((s) => [s.node, s.resolution, s.targetWorkflowId])).toEqual([
      ['Absent', 'ABSENT', null], ['Child', 'DYNAMIC', null],
    ]);
    expect(report.completeness.reasons.map((reason) => reason.code)).toContain('DYNAMIC_PREREQUISITE_VALUE');
    expect(report.completeness.status).toBe('DEGRADED');
  });

  it('anchors absent subworkflow ids at existing input locations and preserves present-id resolution', () => {
    const report = buildPreflightReadinessReport({
      workflow: workflow([
        { name: 'Missing parameters', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1 },
        node('Empty parameters', 'n8n-nodes-base.executeWorkflow', { parameters: {} }),
        node('Null parameters', 'n8n-nodes-base.executeWorkflow', { parameters: null }),
        node('Null workflow id', 'n8n-nodes-base.executeWorkflow', { parameters: { workflowId: null } }),
        node('Malformed workflow id', 'n8n-nodes-base.executeWorkflow', { parameters: { workflowId: 42 } }),
        node('Dynamic workflow id', 'n8n-nodes-base.executeWorkflow', { parameters: { workflowId: '={{ $json.workflowId }}' } }),
        node('Literal workflow id', 'n8n-nodes-base.executeWorkflow', { parameters: { workflowId: 'wf-123' } }),
      ]),
      analysis: fullAnalysis(7),
    });
    const observations = Object.fromEntries(report.prerequisites.subworkflows.map((row) => [row.node, {
      pointer: row.pointer,
      resolution: row.resolution,
      targetWorkflowId: row.targetWorkflowId,
      targetExistence: row.targetExistence,
    }]));

    expect(observations).toEqual({
      'Empty parameters': { pointer: '/nodes/1', resolution: 'ABSENT', targetWorkflowId: null, targetExistence: 'UNKNOWN' },
      'Dynamic workflow id': { pointer: '/nodes/5/parameters/workflowId', resolution: 'DYNAMIC', targetWorkflowId: null, targetExistence: 'UNKNOWN' },
      'Literal workflow id': { pointer: '/nodes/6/parameters/workflowId', resolution: 'LITERAL', targetWorkflowId: 'wf-123', targetExistence: 'UNKNOWN' },
      'Malformed workflow id': { pointer: '/nodes/4/parameters/workflowId', resolution: 'ABSENT', targetWorkflowId: null, targetExistence: 'UNKNOWN' },
      'Missing parameters': { pointer: '/nodes/0', resolution: 'ABSENT', targetWorkflowId: null, targetExistence: 'UNKNOWN' },
      'Null parameters': { pointer: '/nodes/2', resolution: 'ABSENT', targetWorkflowId: null, targetExistence: 'UNKNOWN' },
      'Null workflow id': { pointer: '/nodes/3/parameters/workflowId', resolution: 'ABSENT', targetWorkflowId: null, targetExistence: 'UNKNOWN' },
    });
  });

  it('detects target incompatibilities from admitted pinned facts and never claims migration success', () => {
    const target = workflow([node('Code', 'n8n-nodes-base.code', { typeVersion: 2 }), node('Table', 'n8n-nodes-base.dataTable')]);

    const incompatible = buildPreflightReadinessReport({ workflow: target, n8nTarget: '1.x', platformFacts: TARGET_FACTS, analysis: fullAnalysis(2) });
    expect(incompatible.target.declared).toBe('1.x');
    expect(incompatible.target.status).toBe('INCOMPATIBLE');
    expect(incompatible.target.migrationTested).toBe(false);
    expect(incompatible.target.findings.map((finding) => finding.code).sort()).toEqual([
      'FEATURE_NOT_SUPPORTED_BY_TARGET', 'TYPE_VERSION_NOT_SUPPORTED_BY_TARGET',
    ]);
    for (const finding of incompatible.target.findings) expect(finding.source.length).toBeGreaterThan(0);
    expect(incompatible.target.notes.join(' ')).toContain('not a migration test');

    const compatible = buildPreflightReadinessReport({ workflow: target, n8nTarget: '2.x', platformFacts: TARGET_FACTS, analysis: fullAnalysis(2) });
    expect(compatible.target.status).toBe('NO_RECOGNIZED_CHANGE');
    expect(compatible.target.findings).toEqual([]);
    expect(compatible.target.migrationTested).toBe(false);
    expect(compatible.target.notes.join(' ')).toContain('no recognized change');

    const featureOnly = buildPreflightReadinessReport({
      workflow: workflow([node('Set', 'n8n-nodes-base.set')]),
      n8nTarget: '1.x',
      platformFacts: TARGET_FACTS,
      requiredPlatformFeatures: ['wait-http-resume'],
      analysis: fullAnalysis(1),
    });
    expect(featureOnly.target.status).toBe('INCOMPATIBLE');
    expect(featureOnly.target.findings.map((finding) => finding.featureId)).toEqual(['wait-http-resume']);

    const typeVersionUnknown = buildPreflightReadinessReport({
      workflow: workflow([{ name: 'Code', type: 'n8n-nodes-base.code', parameters: {} }]),
      n8nTarget: '1.x',
      platformFacts: TARGET_FACTS,
      analysis: fullAnalysis(1),
    });
    expect(typeVersionUnknown.target.findings.map((finding) => finding.code)).toEqual(['TYPE_VERSION_UNKNOWN']);
    expect(typeVersionUnknown.target.status).toBe('UNKNOWN');

    const undeclared = buildPreflightReadinessReport({ workflow: target, analysis: fullAnalysis(2) });
    expect(DEFAULT_PLATFORM_FACTS_V1.length).toBe(0);
    expect(undeclared.target).toEqual(expect.objectContaining({ declared: null, status: 'INDETERMINATE', migrationTested: false }));
    expect(undeclared.target.notes.join(' ')).toContain('target');
  });

  it('looks up only the two exact pinned target sources and deep-freezes their evidence', () => {
    const first = pinnedTargetFactV1('2.0.0');
    const second = pinnedTargetFactV1('2.45.6');

    expect(first?.source).toBe('https://raw.githubusercontent.com/n8n-io/n8n/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/%40n8n/config/src/configs/nodes.config.ts');
    expect(first?.evidence).toEqual({
      kind: 'PINNED_SOURCE', tag: 'n8n@2.0.0', commit: 'a8ecda44f7627630bc8b78cf671405157ad41c4f',
      path: 'packages/@n8n/config/src/configs/nodes.config.ts', startLine: 29, endLine: 36,
      sha256: '88f7169bf5a39d053a8b256a7711afa5f0f66c0f84eeae214497537c6a70ebe8',
    });
    expect(second?.evidence).toEqual({
      kind: 'PINNED_SOURCE', tag: 'n8n@2.45.6', commit: 'e1024601bc8e523198804de13d2f8e27eed92896',
      path: 'packages/@n8n/config/src/configs/nodes.config.ts', startLine: 31, endLine: 39,
      sha256: '1f57a7f5044d4dc2df9b5880669fa37cc4928e4564c378c8e0aef17db30b5aa3',
    });
    for (const control of ['2.0.1', ' 2.0.0', '2.0.0\n', '1.123.22', '3.0.0']) expect(pinnedTargetFactV1(control)).toBeUndefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.evidence)).toBe(true);
  });

  it('evaluates exact pinned executeCommand type matches without selecting from host or command facts', () => {
    const cases = [
      {
        version: '2.0.0',
        evidence: {
          kind: 'PINNED_SOURCE', tag: 'n8n@2.0.0', commit: 'a8ecda44f7627630bc8b78cf671405157ad41c4f',
          path: 'packages/@n8n/config/src/configs/nodes.config.ts', startLine: 29, endLine: 36,
          sha256: '88f7169bf5a39d053a8b256a7711afa5f0f66c0f84eeae214497537c6a70ebe8',
        },
      },
      {
        version: '2.45.6',
        evidence: {
          kind: 'PINNED_SOURCE', tag: 'n8n@2.45.6', commit: 'e1024601bc8e523198804de13d2f8e27eed92896',
          path: 'packages/@n8n/config/src/configs/nodes.config.ts', startLine: 31, endLine: 39,
          sha256: '1f57a7f5044d4dc2df9b5880669fa37cc4928e4564c378c8e0aef17db30b5aa3',
        },
      },
    ] as const;
    const commandCanary = 'command-expression-must-not-escape-7f29';

    for (const { version, evidence } of cases) {
      const input = workflow([
        node('Set', 'n8n-nodes-base.set'),
        node('Duplicate command', 'n8n-nodes-base.executeCommand', { typeVersion: 1, parameters: { command: commandCanary } }),
        node('Duplicate command', 'n8n-nodes-base.executeCommand', { typeVersion: 'unreadable', parameters: { command: commandCanary } }),
      ]);
      const report = buildPreflightReadinessReport({
        workflow: input, n8nVersion: version, n8nTarget: '1.x', analysis: fullAnalysis(3),
        platformFacts: [{
          featureId: 'misleading-host-fact', description: 'Must not select exact facts',
          nodeTypes: ['n8n-nodes-base.executeCommand'], supportedTargets: ['1.x'], source: 'caller:misleading',
        }],
        requiredPlatformFeatures: ['misleading-host-feature'],
      });

      expect(report.target).toMatchObject({ declaredVersion: version, status: 'INDETERMINATE', migrationTested: false });
      expect(report.target.findings).toHaveLength(2);
      expect(report.target.findings.map(({ pointer, subject, typeVersion, nodeType }) => ({ pointer, subject, typeVersion, nodeType }))).toEqual([
        { pointer: '/nodes/1/type', subject: 'Duplicate command', typeVersion: '1', nodeType: 'n8n-nodes-base.executeCommand' },
        { pointer: '/nodes/2/type', subject: 'Duplicate command', typeVersion: null, nodeType: 'n8n-nodes-base.executeCommand' },
      ]);
      for (const finding of report.target.findings) {
        expect(finding).toMatchObject({
          code: 'DEFAULT_NODE_EXCLUSION_CONFIGURATION_UNKNOWN', featureId: 'execute-command-default-exclusion', sourceEvidence: evidence,
        });
        expect(finding.detail).toContain('pinned upstream default');
        expect(finding.detail).toContain('NODES_EXCLUDE');
        expect(finding.detail).toContain('actual host list');
        expect(finding.detail).not.toMatch(/\b(?:INCOMPATIBLE|available|enabled|importable|migration-tested)\b/i);
        expect(Object.isFrozen(finding.sourceEvidence)).toBe(true);
      }
      expect(report.target.notes.join(' ')).toContain('not a migration test');
      expect(report.target.notes.join(' ')).not.toContain('migration success');
      expect(JSON.stringify(report)).not.toContain(commandCanary);
      expect(JSON.stringify(report)).not.toContain('misleading-host');
      expect(JSON.stringify(buildPreflightReadinessReport({ workflow: input, n8nVersion: version, analysis: fullAnalysis(3) })))
        .toBe(JSON.stringify(buildPreflightReadinessReport({ workflow: input, n8nVersion: version, analysis: fullAnalysis(3) })));
    }
  });

  it('limits no-match and unadmitted exact versions to the frozen pinned subset', () => {
    const noMatch = buildPreflightReadinessReport({ workflow: workflow([]), n8nVersion: '2.45.6', analysis: fullAnalysis(0) });
    expect(noMatch.target).toMatchObject({ declaredVersion: '2.45.6', status: 'NO_RECOGNIZED_CHANGE', migrationTested: false, findings: [] });
    expect(noMatch.target.notes.join(' ')).toContain('frozen exact pinned subset');
    expect(noMatch.target.notes.join(' ')).toContain('not migration success');

    for (const version of ['1.123.22', '2.0.1', '2.45.5', '2.45.7', '2.0.0-rc.1', '2.0.0+build', '3.0.0']) {
      const report = buildPreflightReadinessReport({
        workflow: workflow([node('Command', 'n8n-nodes-base.executeCommand')]), n8nVersion: version, analysis: fullAnalysis(1),
      });
      expect(report.target).toMatchObject({ declaredVersion: version, status: 'INDETERMINATE', migrationTested: false, findings: [] });
      expect(report.target.notes.join(' ')).toContain('No applicable fact exists in this exact pinned subset');
      expect(report.target.notes.join(' ')).not.toMatch(/\b(?:supported|unsupported|compatible|incompatible)\b/i);
    }

    const absent = buildPreflightReadinessReport({ workflow: workflow([node('Command', 'n8n-nodes-base.executeCommand')]), analysis: fullAnalysis(1) });
    expect(absent.target).toMatchObject({ declared: null, status: 'INDETERMINATE', migrationTested: false, findings: [] });
    expect(absent.target.declaredVersion).toBeUndefined();
  });

  it('rejects a non-array requiredPlatformFeatures and never renders an absent fact description', () => {
    const target = workflow([node('Set', 'n8n-nodes-base.set')]);
    const notAnArray = 'wait-http-resume' as unknown as readonly string[];
    expect(() => buildPreflightReadinessReport({ workflow: target, n8nTarget: '1.x', requiredPlatformFeatures: notAnArray })).toThrow(TypeError);
    expect(() => buildPreflightReadinessReport({ workflow: target, requiredPlatformFeatures: notAnArray })).toThrow(TypeError);

    const undescribed = buildPreflightReadinessReport({
      workflow: target,
      n8nTarget: '1.x',
      platformFacts: [{
        featureId: 'undescribed',
        description: undefined as unknown as string,
        nodeTypes: ['n8n-nodes-base.set'],
        supportedTargets: ['2.x'],
        source: 'pinned:undescribed',
      }],
      analysis: fullAnalysis(1),
    });
    expect(undescribed.target.findings.map((finding) => finding.detail)).toEqual(['undescribed is not admitted as supported on n8n 1.x.']);
    expect(undescribed.target.status).toBe('INCOMPATIBLE');
  });

  it('rejects malformed platform compatibility facts instead of skipping them', () => {
    const target = workflow([node('Set', 'n8n-nodes-base.set')]);
    const malformed = [
      { description: 'no feature id', nodeTypes: ['n8n-nodes-base.set'], supportedTargets: ['1.x'], source: 'pinned:x' },
      { description: 'blank feature id', featureId: '  ', nodeTypes: ['n8n-nodes-base.set'], supportedTargets: ['1.x'], source: 'pinned:x' },
      { featureId: 'no-source', nodeTypes: ['n8n-nodes-base.set'], supportedTargets: ['1.x'] },
      { featureId: 'blank-source', nodeTypes: ['n8n-nodes-base.set'], supportedTargets: ['1.x'], source: '  ' },
      { featureId: 'not-an-array', nodeTypes: 'n8n-nodes-base.set', supportedTargets: ['1.x'], source: 'pinned:x' },
      { featureId: 'blank-node-type', nodeTypes: [''], supportedTargets: ['1.x'], source: 'pinned:x' },
      { featureId: 'targets-not-array', nodeTypes: ['n8n-nodes-base.set'], supportedTargets: '1.x', source: 'pinned:x' },
      { featureId: 'targets-unadmitted', nodeTypes: ['n8n-nodes-base.set'], supportedTargets: ['3.x'], source: 'pinned:x' },
      { featureId: 'max-version-not-a-map', nodeTypes: ['n8n-nodes-base.set'], supportedTargets: ['1.x'], maxTypeVersionByTarget: '1.0.0', source: 'pinned:x' },
      { featureId: 'max-version-number', nodeTypes: ['n8n-nodes-base.set'], supportedTargets: ['1.x'], maxTypeVersionByTarget: { '1.x': 3 }, source: 'pinned:x' },
      { featureId: 'max-version-unadmitted-target', nodeTypes: ['n8n-nodes-base.set'], supportedTargets: ['1.x'], maxTypeVersionByTarget: { '3.x': '1.0.0' }, source: 'pinned:x' },
      'not-a-fact',
    ] as unknown as readonly PlatformCompatibilityFactV1[];

    for (const fact of malformed) {
      expect(() => buildPreflightReadinessReport({ workflow: target, n8nTarget: '1.x', platformFacts: [fact] }))
        .toThrow('malformed platform compatibility fact');
      // Facts are validated as input, so they are rejected even when no target is declared.
      expect(() => buildPreflightReadinessReport({ workflow: target, platformFacts: [fact] })).toThrow(TypeError);
    }
  });

  it('never reports NO_RECOGNIZED_CHANGE when a required platform feature has no admitted fact', () => {
    const target = workflow([node('Set', 'n8n-nodes-base.set')]);

    const partiallyAdmitted = buildPreflightReadinessReport({
      workflow: target, n8nTarget: '2.x', platformFacts: TARGET_FACTS,
      requiredPlatformFeatures: ['wait-http-resume', 'not-admitted-feature'], analysis: fullAnalysis(1),
    });
    const unmatched = partiallyAdmitted.target.findings.find((finding) => finding.featureId === 'not-admitted-feature');
    expect(unmatched?.code).toBe('FEATURE_NOT_SUPPORTED_BY_TARGET');
    expect(unmatched?.detail).toBe('Required platform feature not-admitted-feature has no admitted fact.');
    expect(partiallyAdmitted.target.status).not.toBe('NO_RECOGNIZED_CHANGE');
    expect(partiallyAdmitted.target.status).toBe('INCOMPATIBLE');
    expect(partiallyAdmitted.target.migrationTested).toBe(false);

    const noFactsAdmitted = buildPreflightReadinessReport({
      workflow: target, n8nTarget: '2.x', requiredPlatformFeatures: ['absent-everywhere'], analysis: fullAnalysis(1),
    });
    expect(noFactsAdmitted.target.findings.map((finding) => finding.featureId)).toEqual(['absent-everywhere']);
    expect(noFactsAdmitted.target.status).not.toBe('NO_RECOGNIZED_CHANGE');

    // A requirement that resolves to an admitted, supported fact stays a clean no-change verdict.
    const satisfied = buildPreflightReadinessReport({
      workflow: target, n8nTarget: '2.x', platformFacts: TARGET_FACTS,
      requiredPlatformFeatures: ['wait-http-resume'], analysis: fullAnalysis(1),
    });
    expect(satisfied.target.findings).toEqual([]);
    expect(satisfied.target.status).toBe('NO_RECOGNIZED_CHANGE');
  });

  it('is deterministic, immutable and always carries the no-safety-clearance disclaimer', () => {
    const input = workflow([node('Slack', 'n8n-nodes-base.slack', { credentials: { slackApi: { id: 'c', name: 'S' } } })]);
    const snapshot = JSON.stringify(input);
    const first = buildPreflightReadinessReport({ workflow: input, n8nTarget: '2.x', platformFacts: TARGET_FACTS, analysis: fullAnalysis(1) });
    const second = buildPreflightReadinessReport({ workflow: input, n8nTarget: '2.x', platformFacts: TARGET_FACTS, analysis: fullAnalysis(1) });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.completeness.reasons)).toBe(true);
    expect(Object.isFrozen(first.prerequisites.credentials)).toBe(true);
    expect(Object.isFrozen(first.prerequisites.credentials[0])).toBe(true);
    expect(Object.isFrozen(first.target.notes)).toBe(true);
    expect(first.disclaimer).toBe(PREFLIGHT_DISCLAIMER_V1);
    expect(first.disclaimer.id).toBe('NOT_SAFETY_CLEARANCE');
    expect(first.disclaimer.text).toContain('not safety clearance');
    expect(first.disclaimer.text).toContain('bug-free');
    expect(first.disclaimer.text).toContain('runnable');
  });

  it('normalizes severities, orders findings and rejects unknown severity labels', () => {
    const report = buildPreflightReadinessReport({
      workflow: workflow([node('Set', 'n8n-nodes-base.set')]),
      analysis: fullAnalysis(1),
      findings: [
        { ruleId: 'B_INFO', severity: 'info' },
        { ruleId: 'A_CRITICAL', severity: 'CRITICAL', node: 'Set', message: 'critical' },
        { ruleId: 'C_HIGH', severity: 'High' },
      ],
    });
    expect(PREFLIGHT_SEVERITIES_V1).toEqual(['critical', 'high', 'medium', 'low', 'info']);
    expect(report.findings.items.map((item) => [item.ruleId, item.severity])).toEqual([
      ['A_CRITICAL', 'critical'], ['C_HIGH', 'high'], ['B_INFO', 'info'],
    ]);
    expect(report.findings.bySeverity.critical).toBe(1);
    expect(report.findings.highestSeverity).toBe('critical');
    expect(() => buildPreflightReadinessReport({ workflow: workflow([]), findings: [{ ruleId: 'X', severity: 'severe' }] }))
      .toThrow(TypeError);
  });

  it('retains each contributing community node, even with duplicate names', () => {
    const input = workflow([node('same', 'example-nodes.action'), node('same', 'example-nodes.action')]);
    const report = buildPreflightReadinessReport({ workflow: input, analysis: fullAnalysis(2) });
    expect(report.prerequisites.communityNodes[0]?.evidence).toEqual([
      expect.objectContaining({ pointer: '/nodes/0', node: 'same', source: 'WORKFLOW_EXPORT' }),
      expect.objectContaining({ pointer: '/nodes/1', node: 'same', source: 'WORKFLOW_EXPORT' }),
    ]);
    expect(report.prerequisites.communityNodes[0]?.installed).toBe('UNKNOWN');
    expect(report.prerequisites.communityNodes[0]?.packageVersion).toBeNull();
    expect(Object.isFrozen(report.prerequisites.communityNodes[0]?.evidence)).toBe(true);
  });

  it('escapes a credential key as a JSON pointer segment', () => {
    const input = workflow([node('n', 'n8n-nodes-base.httpRequest', {
      credentials: { 'a/b~c': { id: 'identifier' } },
    })]);
    const report = buildPreflightReadinessReport({ workflow: input, analysis: fullAnalysis(1) });
    expect(report.prerequisites.credentials[0]?.pointer).toBe('/nodes/0/credentials/a~1b~0c');
  });

  it('retains each contributing integration node, even with duplicate names', () => {
    const input = workflow([
      node('same', 'n8n-nodes-base.httpRequest'),
      node('same', 'n8n-nodes-base.httpRequest'),
      node('other', 'n8n-nodes-base.slack', { credentials: { slackApi: { id: 'cred-1' } } }),
    ]);
    const report = buildPreflightReadinessReport({ workflow: input, analysis: fullAnalysis(3) });
    expect(report.prerequisites.integrations.map(({ service, evidence }) => [service, evidence.map(({ pointer }) => pointer)])).toEqual([
      ['httpRequest', ['/nodes/0', '/nodes/1']],
      ['slack', ['/nodes/2']],
    ]);
  });

  it('anchors environment references to their string leaf and never claims a value', () => {
    const input = workflow([node('HTTP', 'n8n-nodes-base.httpRequest', {
      parameters: {
        url: '={{ $env.API_HOST }}/v1',
        options: { headers: { 'x-tenant': '={{ $vars.TENANT }}' } },
        list: ['$env.API_HOST', '{{ $env[$json.key] }}'],
      },
    })]);
    const report = buildPreflightReadinessReport({ workflow: input, analysis: fullAnalysis(1) });
    expect(report.prerequisites.environment.map(({ namespace, name, value, availability, evidence }) => [namespace, name, value, availability, evidence.pointer])).toEqual([
      ['ENV', 'API_HOST', 'UNKNOWN', 'UNKNOWN', '/nodes/0/parameters/list/0'],
      ['ENV', 'API_HOST', 'UNKNOWN', 'UNKNOWN', '/nodes/0/parameters/url'],
    ]);
    expect(report.prerequisites.unknowns.join(' ')).toContain('environment evidence omitted');
    expect(report.prerequisites.environment.every(({ evidence }) => evidence.source === 'WORKFLOW_EXPORT')).toBe(true);
    expect(Object.isFrozen(report.prerequisites.environment)).toBe(true);
  });

  it('omits potentially dynamic nested keys and never admits computed environment access', () => {
    const input = workflow([node('HTTP', 'n8n-nodes-base.httpRequest', {
      parameters: { 'a/b~c': { list: ['{{ $env.TOKEN }}', '{{ $env[$json.key] }}', '{{ $vars[key] }}'] } },
    })]);
    const report = buildPreflightReadinessReport({ workflow: input, analysis: fullAnalysis(1) });
    expect(report.prerequisites.environment).toEqual([]);
    expect(report.prerequisites.unknowns.join(' ')).toContain('environment evidence omitted');
    expect(report.prerequisites.unknowns).toContain('computed environment or variable access ($env[...] or $vars[...]) cannot be named offline and stays unknown.');
  });

  it('emits computed access unknown and preserves regex state across mixed string sequences', () => {
    const input = workflow([node('Mixed', 'n8n-nodes-base.httpRequest', {
      parameters: { list: ['plain text before', '{{ $env[computedKey] }}', '{{ $env.FOLLOWING }}', '{{ $vars[anotherComputed] }}', 'plain text after', '{{ $env.DUPE }} and {{ $env.DUPE }}'] },
    })]);
    const report = buildPreflightReadinessReport({ workflow: input, analysis: fullAnalysis(1) });
    expect(report.prerequisites.unknowns).toContain('computed environment or variable access ($env[...] or $vars[...]) cannot be named offline and stays unknown.');
    expect(report.prerequisites.environment.map(({ name, evidence }) => [name, evidence.pointer])).toEqual([
      ['FOLLOWING', '/nodes/0/parameters/list/2'],
      ['DUPE', '/nodes/0/parameters/list/5'],
    ]);
  });

  it('keeps provenance unknown even when the export self-declares identity', () => {
    const input = workflow([node('Set', 'n8n-nodes-base.set')], {
      id: 'wf-1', versionId: 'commit-like', meta: { repository: 'https://example.test/repo', licence: 'MIT' },
    });
    const report = buildPreflightReadinessReport({ workflow: input, analysis: fullAnalysis(1) });
    expect(report.prerequisites.provenance).toEqual({
      source: 'WORKFLOW_EXPORT', pointer: '/', repository: 'UNKNOWN', commit: 'UNKNOWN', licence: 'UNKNOWN', verification: 'UNKNOWN',
    });
  });

  it.each(['{{ $env [secretKey] }}', '{{ $vars?.[secretKey] }}', '{{ $env ?. [secretKey] }}'])
  ('reports computed references with whitespace or optional access without exposing the expression: %s', (expression) => {
    const input = workflow([node('Mixed', 'n8n-nodes-base.set', { parameters: { url: `${expression} {{ $env.NAMED }}` } })]);
    const report = buildPreflightReadinessReport({ workflow: input, analysis: fullAnalysis(1) });
    expect(report.prerequisites.unknowns.join(' ')).toContain('computed environment or variable access');
    expect(report.prerequisites.environment.map(({ name, evidence }) => [name, evidence.pointer])).toEqual([['NAMED', '/nodes/0/parameters/url']]);
    expect(JSON.stringify(report)).not.toContain('secretKey');
  });

  it.each(['array', 'object'] as const)('bounds child reads of a wide %s by the remaining value budget', (kind) => {
    let reads = 0;
    const parameters: Record<string, unknown> | unknown[] = kind === 'array' ? [] : {};
    for (let index = 0; index < 12_000; index += 1) {
      Object.defineProperty(parameters, String(index), { enumerable: true, get: () => { reads += 1; return null; } });
    }
    let laterReads = 0;
    const later = Object.defineProperty({}, 'value', { enumerable: true, get: () => { laterReads += 1; return '$env.LATER'; } });
    const report = buildPreflightReadinessReport({ workflow: workflow([
      node('Wide', 'n8n-nodes-base.set', { parameters }), node('Later', 'n8n-nodes-base.set', { parameters: later }),
    ]), analysis: fullAnalysis(2) });
    expect(reads).toBeLessThanOrEqual(9_999);
    expect(laterReads).toBe(0);
    expect(report.completeness.reasons.map(({ code }) => code)).toContain('PREREQUISITE_INVENTORY_LIMIT');
  });

  it.each(['sk-live-raw-token-value-0123456789', 'opaqueUserSuppliedKey'])('omits environment evidence below an unsafe dynamic key without leaking it', (secret) => {
    const input = workflow([node('Set', 'n8n-nodes-base.set', { parameters: { [secret]: '{{ $env.SERVICE }}' } })]);
    const report = buildPreflightReadinessReport({ workflow: input, analysis: fullAnalysis(1) });
    expect(report.prerequisites.environment).toEqual([]);
    expect(report.prerequisites.unknowns.join(' ')).toContain('environment evidence omitted');
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('degrades completeness for computed access independently of findings', () => {
    const computed = buildPreflightReadinessReport({ workflow: workflow([node('Set', 'n8n-nodes-base.set', { parameters: { url: '{{ $env [key] }}' } })]), analysis: fullAnalysis(1) });
    expect(computed.completeness.status).toBe('DEGRADED');
    expect(computed.completeness.reasons.map(({ code }) => code)).toContain('DYNAMIC_ENVIRONMENT_ACCESS');
    expect(computed.findings.total).toBe(0);
    const absentAnalysis = buildPreflightReadinessReport({ workflow: workflow([node('Set', 'n8n-nodes-base.set', { parameters: { url: '{{ $env[key] }}' } })]) });
    expect(absentAnalysis.completeness.status).toBe('INDETERMINATE');
  });

  it('degrades completeness when environment evidence is withheld', () => {
    const omitted = buildPreflightReadinessReport({ workflow: workflow([node('Set', 'n8n-nodes-base.set', { parameters: { arbitraryKey: '{{ $env.TOKEN }}' } })]), analysis: fullAnalysis(1) });
    expect(omitted.completeness.status).toBe('DEGRADED');
    expect(omitted.completeness.reasons.map(({ code }) => code)).toContain('ENVIRONMENT_EVIDENCE_OMITTED');
    expect(JSON.stringify(omitted)).not.toContain('arbitraryKey');
  });

  it.each(['jsCode', 'text', 'value', 'jsonBody'])('observes named references under admitted static field %s', (key) => {
    const report = buildPreflightReadinessReport({ workflow: workflow([node('Set', 'n8n-nodes-base.set', { parameters: { [key]: '{{ $env.SERVICE }}' } })]), analysis: fullAnalysis(1) });
    expect(report.prerequisites.environment.map(({ name, evidence }) => [name, evidence.pointer])).toEqual([['SERVICE', `/nodes/0/parameters/${key}`]]);
    expect(report.completeness.status).toBe('COMPLETE');
    const plain = buildPreflightReadinessReport({ workflow: workflow([node('Set', 'n8n-nodes-base.set', { parameters: { [key]: 'plain' } })]), analysis: fullAnalysis(1) });
    expect(plain.completeness.status).toBe('COMPLETE');
  });

  it('accepts exactly 10,000 values and marks an additional node as truncated', () => {
    const parameters = Array.from({ length: 9_999 }, () => null);
    const first = node('Exact', 'n8n-nodes-base.set', { parameters });
    const exact = buildPreflightReadinessReport({ workflow: workflow([first]), analysis: fullAnalysis(1) });
    expect(exact.completeness.reasons.map(({ code }) => code)).not.toContain('PREREQUISITE_INVENTORY_LIMIT');
    const over = buildPreflightReadinessReport({ workflow: workflow([first, node('Later', 'n8n-nodes-base.set')]), analysis: fullAnalysis(2) });
    expect(over.completeness.reasons.map(({ code }) => code)).toContain('PREREQUISITE_INVENTORY_LIMIT');
  });

  it('bounds a cyclic parameter graph and reports the prerequisite inventory limit', () => {
    const cyclic: Record<string, unknown> = { note: '{{ $env.CYCLE }}' };
    cyclic.self = cyclic;
    const report = buildPreflightReadinessReport({ workflow: workflow([node('Set', 'n8n-nodes-base.set', { parameters: cyclic })]), analysis: fullAnalysis(1) });
    expect(report.completeness.reasons.map(({ code }) => code)).toContain('PREREQUISITE_INVENTORY_LIMIT');
    expect(report.completeness.status).toBe('DEGRADED');
    expect(report.prerequisites.unknowns.join(' ')).toContain('inventory limit');
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it('reports the prerequisite inventory limit when parameter depth exceeds the declared bound', () => {
    let deep: Record<string, unknown> = { leaf: '{{ $env.TOO_DEEP }}' };
    for (let level = 0; level < 80; level += 1) deep = { nested: deep };
    const report = buildPreflightReadinessReport({ workflow: workflow([node('Set', 'n8n-nodes-base.set', { parameters: deep })]), analysis: fullAnalysis(1) });
    expect(report.prerequisites.environment).toEqual([]);
    expect(report.completeness.reasons.map(({ code }) => code)).toContain('PREREQUISITE_INVENTORY_LIMIT');
    expect(report.completeness.status).toBe('DEGRADED');
  });

  it('never reads a host environment value into the inventory', () => {
    const sentinel = 'COMMUNITY_HUB_PREFLIGHT_SENTINEL';
    process.env[sentinel] = 'sentinel-value-9f2c';
    try {
      const input = workflow([node('HTTP', 'n8n-nodes-base.httpRequest', { parameters: { url: `={{ $env.${sentinel} }}` } })]);
      const report = buildPreflightReadinessReport({ workflow: input, analysis: fullAnalysis(1) });
      expect(report.prerequisites.environment.map(({ name, value }) => [name, value])).toEqual([[sentinel, 'UNKNOWN']]);
      expect(JSON.stringify(report)).not.toContain('sentinel-value-9f2c');
    } finally {
      delete process.env[sentinel];
    }
  });

  it('stays a browser-safe, bounded module', () => {
    for (const path of ['./preflight-readiness.ts', './preflight-readiness-prerequisites.ts']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source.split('\n').length).toBeLessThanOrEqual(250);
      expect(source).not.toMatch(/from ['"]node:/);
      expect(source).not.toMatch(/require\(/);
      expect(source).not.toMatch(/\bprocess\./);
    }
  });
});
