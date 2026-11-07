import { describe, expect, it } from 'vitest';
import type {
  FindingConfidence,
  NormalizedWorkflow,
  NormalizedWorkflowNode,
  PolicyEffect,
  ScanFinding,
  ScanSeverity,
} from '../policy/policy';
import {
  betaDefaultRuleCatalog,
  betaHardenedRuleCatalog,
  type RuleCatalogEntry,
} from '../policy/rule-catalog';
import { resolvePolicyProfile, type PolicyProfileId } from './profile';

function node(id: string, type: string, parameters: Record<string, unknown> = {}): NormalizedWorkflowNode {
  return { id, name: id, type, parameters, sourcePath: `/nodes/${id}` };
}

function workflow(nodes: NormalizedWorkflowNode[]): NormalizedWorkflow {
  return { nodes } as NormalizedWorkflow;
}

const syntheticSecret = 'Q7vM2xR9pL4zK8nC6wH3tY5sD1';
const unsupportedWorkflow = workflow([node('unsupported', 'n8n-nodes-base.httpRequest', {
  nested: [null, false, 17, { value: 'not-a-url' }],
})]);

type PolicyCase = {
  id: string;
  positive: NormalizedWorkflow;
  negative: NormalizedWorkflow;
  approvedDomains?: readonly string[];
  secret?: string;
};

const policyCases: readonly PolicyCase[] = [
  {
    id: 'N8N_EXECUTE_COMMAND',
    positive: workflow([node('command', 'n8n-nodes-base.executeCommand', { command: 'echo synthetic' })]),
    negative: workflow([node('safe', 'n8n-nodes-base.set')]),
  },
  {
    id: 'N8N_CODE_NODE',
    positive: workflow([node('code', 'n8n-nodes-base.code', { jsCode: 'return []' })]),
    negative: workflow([node('safe', 'n8n-nodes-base.manualTrigger')]),
  },
  {
    id: 'RAW_AUTH_HEADER',
    positive: workflow([node('request', 'n8n-nodes-base.httpRequest', {
      headers: { Authorization: 'Bearer matrix-only-value' },
    })]),
    negative: workflow([node('request', 'n8n-nodes-base.httpRequest', {
      headers: { Accept: 'application/json' },
    })]),
  },
  {
    id: 'RAW_SECRET_INDICATOR',
    positive: workflow([node('secret', 'n8n-nodes-base.set', { apiKey: syntheticSecret })]),
    negative: workflow([node('managed', 'n8n-nodes-base.set', { token: '={{ $credentials.token }}' })]),
    secret: syntheticSecret,
  },
  {
    id: 'UNAPPROVED_DOMAIN',
    positive: workflow([node('request', 'n8n-nodes-base.httpRequest', {
      url: 'https://blocked.example.test/items',
    })]),
    negative: workflow([node('request', 'n8n-nodes-base.httpRequest', {
      url: 'https://approved.example.test/items',
    })]),
    approvedDomains: ['approved.example.test'],
  },
  {
    id: 'UNKNOWN_NODE_PACKAGE',
    positive: workflow([node('community', 'community-package.nodes.safe')]),
    negative: workflow([node('official', '@n8n/n8n-nodes-langchain.agent')]),
  },
  {
    id: 'WEBHOOK_EXPOSURE',
    positive: workflow([node('public-webhook', 'n8n-nodes-base.webhook')]),
    negative: workflow([node('private-webhook', 'n8n-nodes-base.webhook', { authentication: 'headerAuth' })]),
  },
];

type CatalogExpectation = {
  policyId: string;
  defaultSeverity: ScanSeverity;
  defaultConfidence: FindingConfidence;
  precision: RuleCatalogEntry['precision'];
  policyEffect: PolicyEffect;
  curationAction: RuleCatalogEntry['curationAction'];
  serveAction: RuleCatalogEntry['serveAction'];
  profiles: readonly PolicyProfileId[];
};

type CatalogRow = readonly [string, ScanSeverity, FindingConfidence, RuleCatalogEntry['precision'], PolicyEffect, RuleCatalogEntry['curationAction'], RuleCatalogEntry['serveAction'], readonly PolicyProfileId[]];

const catalogExpectations = ([
  ['N8N_EXECUTE_COMMAND', 'CRITICAL', 'HIGH', 'HIGH', 'LEGACY_SCORE', 'NONE', 'DISPLAY', ['beta-default', 'beta-hardened']],
  ['N8N_CODE_NODE', 'LOW', 'HIGH', 'HIGH', 'LEGACY_SCORE', 'NONE', 'DISPLAY', ['beta-default', 'beta-hardened']],
  ['RAW_AUTH_HEADER', 'HIGH', 'MEDIUM', 'MEDIUM', 'LEGACY_SCORE', 'NONE', 'DISPLAY', ['beta-default', 'beta-hardened']],
  ['RAW_SECRET_INDICATOR', 'HIGH', 'MEDIUM', 'MEDIUM', 'LEGACY_SCORE', 'NONE', 'DISPLAY', ['beta-default', 'beta-hardened']],
  ['UNAPPROVED_DOMAIN', 'MEDIUM', 'HIGH', 'HIGH', 'LEGACY_SCORE', 'NONE', 'DISPLAY', ['beta-default', 'beta-hardened']],
  ['UNKNOWN_NODE_PACKAGE', 'LOW', 'MEDIUM', 'MEDIUM', 'LEGACY_SCORE', 'NONE', 'DISPLAY', ['beta-default', 'beta-hardened']],
  ['WEBHOOK_EXPOSURE', 'MEDIUM', 'MEDIUM', 'MEDIUM', 'LEGACY_SCORE', 'NONE', 'DISPLAY', ['beta-default', 'beta-hardened']],
  ['JAVASCRIPT_DYNAMIC_EXECUTION', 'HIGH', 'HIGH', 'HIGH', 'REPORT_ONLY', 'REVIEW', 'DISPLAY', ['beta-hardened']],
  ['PYTHON_DYNAMIC_EXECUTION', 'HIGH', 'MEDIUM', 'MEDIUM', 'REPORT_ONLY', 'REVIEW', 'DISPLAY', ['beta-hardened']],
  ['TAINTED_COMMAND', 'CRITICAL', 'MEDIUM', 'MEDIUM', 'REPORT_ONLY', 'REVIEW', 'DISPLAY', ['beta-hardened']],
  ['TAINTED_SQL_QUERY', 'HIGH', 'MEDIUM', 'MEDIUM', 'REPORT_ONLY', 'REVIEW', 'DISPLAY', ['beta-hardened']],
  ['TAINTED_REQUEST_URL', 'HIGH', 'MEDIUM', 'MEDIUM', 'REPORT_ONLY', 'REVIEW', 'DISPLAY', ['beta-hardened']],
  ['TAINTED_FILE_PATH', 'HIGH', 'MEDIUM', 'MEDIUM', 'REPORT_ONLY', 'REVIEW', 'DISPLAY', ['beta-hardened']],
  ['TAINTED_CODE_INPUT', 'HIGH', 'MEDIUM', 'MEDIUM', 'REPORT_ONLY', 'REVIEW', 'DISPLAY', ['beta-hardened']],
  ['TAINTED_REQUEST_HEADER', 'MEDIUM', 'MEDIUM', 'MEDIUM', 'REPORT_ONLY', 'REVIEW', 'DISPLAY', ['beta-hardened']],
  ['TAINTED_AI_PROMPT', 'MEDIUM', 'LOW', 'LOW', 'REPORT_ONLY', 'REVIEW', 'DISPLAY', ['beta-hardened']],
  ['AI_AGENT_UNGATED_TOOL', 'MEDIUM', 'LOW', 'LOW', 'REPORT_ONLY', 'REVIEW', 'DISPLAY', ['beta-hardened']],
] as const satisfies readonly CatalogRow[]).map(([policyId, defaultSeverity, defaultConfidence, precision, policyEffect, curationAction, serveAction, profiles]) => ({
  policyId,
  defaultSeverity,
  defaultConfidence,
  precision,
  policyEffect,
  curationAction,
  serveAction,
  profiles,
})) satisfies readonly CatalogExpectation[];

const profileCatalogs: readonly [PolicyProfileId, readonly RuleCatalogEntry[]][] = [
  ['beta-default', betaDefaultRuleCatalog],
  ['beta-hardened', betaHardenedRuleCatalog],
];

function assertFindingContract(findings: readonly ScanFinding[], policyId: string, nodeId: string, secret?: string): void {
  expect(findings.length).toBeGreaterThan(0);
  for (const finding of findings) {
    expect(finding.policyId).toBe(policyId);
    expect(finding.location).toMatchObject({ nodeId, nodeName: nodeId });
    expect(Object.keys(finding.evidence)).not.toHaveLength(0);
    expect(finding.remediation.trim()).not.toBe('');
    expect(finding.remediationSteps.length).toBeGreaterThan(0);
    if (secret) expect(JSON.stringify(finding)).not.toContain(secret);
  }
}

const directCases = profileCatalogs.flatMap(([profileId]) => policyCases.map((policyCase) => ({
  profileId,
  policyCase,
  policyId: policyCase.id,
})));

describe('scanner-core policy/profile coverage matrix', () => {
  it('keeps every catalog ID, metadata tuple, and profile membership stable', () => {
    for (const [profileId, catalog] of profileCatalogs) {
      const expected = catalogExpectations.filter((entry) => entry.profiles.some((profile) => profile === profileId));
      const profile = resolvePolicyProfile(profileId);
      expect(profile).toMatchObject({ ok: true, profileId, version: 'scanner-beta-1' });
      expect(catalog.map((entry) => entry.policyId)).toEqual(expected.map((entry) => entry.policyId));
      expect(catalog).toHaveLength(expected.length);
      for (const entry of catalog) {
        const expectedEntry = expected.find((candidate) => candidate.policyId === entry.policyId);
        expect(expectedEntry).toBeDefined();
        if (!expectedEntry) continue;
        expect(entry).toMatchObject({
          policyId: expectedEntry.policyId,
          defaultSeverity: expectedEntry.defaultSeverity,
          defaultConfidence: expectedEntry.defaultConfidence,
          precision: expectedEntry.precision,
          policyEffect: expectedEntry.policyEffect,
          curationAction: expectedEntry.curationAction,
          serveAction: expectedEntry.serveAction,
        });
        expect(expectedEntry.profiles).toContain(profileId);
      }
    }
  });

  it.each(directCases)('$profileId / $policyId evaluates positive, negative, and unsupported cases', ({
    profileId,
    policyCase,
  }) => {
    const profile = resolvePolicyProfile(profileId);
    expect(profile.ok).toBe(true);
    if (!profile.ok) return;
    const policy = profile.createPolicies({ approvedDomains: policyCase.approvedDomains })
      .find((entry) => entry.id === policyCase.id);
    expect(policy).toBeDefined();
    if (!policy) return;

    assertFindingContract(policy.evaluate(policyCase.positive), policyCase.id,
      policyCase.positive.nodes[0]?.id ?? '', policyCase.secret);
    expect(policy.evaluate(policyCase.negative)).toEqual([]);
    expect(() => policy.evaluate(unsupportedWorkflow)).not.toThrow();
    expect(policy.evaluate(unsupportedWorkflow)).toEqual([]);
  });
});
