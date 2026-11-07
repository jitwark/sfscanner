import { describe, expect, it } from 'vitest';
import {
  buildPreflightReadinessReport,
  prepareWorkflowPrivacy,
  type PlatformCompatibilityFactV1,
  type PreflightCompletenessV1,
  type PreflightFindingInputV1,
  type PreflightFindingV1,
  type PreflightReadinessOptionsV1,
  type PreflightReadinessReportV1,
  type PrivacyChange,
  type PrivacyChangeKind,
  type PrivacyPrepareOptions,
  type PrivacyPrepareResult,
} from './index.js';
import { PREFLIGHT_READINESS_SCHEMA_V1, buildPreflightReadinessReport as buildFromModule } from './v2/preflight-readiness.js';
import { PRIVACY_PREPARE_SCHEMA_V1, prepareWorkflowPrivacy as prepareFromModule } from './v2/privacy-prepare.js';

type Dict = Record<string, unknown>;

function workflow(nodes: readonly Dict[], extra: Dict = {}): Dict {
  return { name: 'Track B workflow', nodes: [...nodes], connections: {}, settings: {}, ...extra };
}

const PLATFORM_FACT: PlatformCompatibilityFactV1 = Object.freeze({
  featureId: 'data-tables',
  description: 'Data Tables node family',
  nodeTypes: Object.freeze(['n8n-nodes-base.dataTable']),
  supportedTargets: Object.freeze(['2.x'] as const),
  source: 'pinned:data-table-node',
});

const REPORTED_FINDING: PreflightFindingInputV1 = Object.freeze({ ruleId: 'SF-1', severity: 'high', node: 'Set', message: 'reported by the scanner' });

const PREFLIGHT_INPUT: PreflightReadinessOptionsV1 = Object.freeze({
  workflow: workflow([{ name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 1, parameters: {} }]),
  n8nTarget: '2.x',
  platformFacts: Object.freeze([PLATFORM_FACT]),
  analysis: Object.freeze({ supportedNodes: 1, unsupportedNodes: 0, unresolvedEdges: 0, ambiguities: 0, truncated: false }),
  findings: Object.freeze([REPORTED_FINDING]),
});

describe('package entry point', () => {
  it('re-exports buildPreflightReadinessReport and reports on an inspected workflow', () => {
    // The entry point must expose the same function the module exports, not a wrapper.
    expect(buildPreflightReadinessReport).toBe(buildFromModule);

    const report: PreflightReadinessReportV1 = buildPreflightReadinessReport(PREFLIGHT_INPUT);
    const status: PreflightCompletenessV1 = report.completeness.status;
    const finding: PreflightFindingV1 = report.findings.items[0];

    expect(report.schemaVersion).toBe(PREFLIGHT_READINESS_SCHEMA_V1);
    expect(status).toBe('COMPLETE');
    expect(report.safetyClearance).toBe('NOT_PROVIDED');
    expect(finding.ruleId).toBe('SF-1');
    expect(report.findings.highestSeverity).toBe('high');
    expect(report.target.declared).toBe('2.x');
  });

  it('re-exports prepareWorkflowPrivacy and redacts a copied workflow', () => {
    expect(prepareWorkflowPrivacy).toBe(prepareFromModule);

    const source = workflow([
      {
        id: 'node-http',
        name: 'Fetch orders',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4,
        parameters: { url: 'https://internal.corp/api/orders?token=abc123secret' },
        credentials: { httpHeaderAuth: { id: 'cred-9f8e7d', name: 'Prod Orders API' } },
      },
      {
        id: 'node-public',
        name: 'Fetch public orders',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4,
        parameters: { url: 'https://api.example.com/orders?access_token=abc123secret' },
      },
    ]);
    const options: PrivacyPrepareOptions = Object.freeze({ internalHostSuffixes: Object.freeze(['.corp']) });
    const prepared: PrivacyPrepareResult = prepareWorkflowPrivacy(source, options);
    const kinds: readonly PrivacyChangeKind[] = prepared.changes.map((change) => change.kind);
    const change: PrivacyChange = prepared.changes[0];

    expect(prepared.schemaVersion).toBe(PRIVACY_PREPARE_SCHEMA_V1);
    expect(prepared.changed).toBe(true);
    expect(kinds).toContain('CREDENTIAL');
    expect(kinds).toContain('TOKEN');
    expect(change.path.startsWith('/nodes/0/')).toBe(true);
    expect(prepared.workflow).not.toBe(source);
    expect(JSON.stringify(prepared.workflow)).not.toContain('cred-9f8e7d');
    expect(JSON.stringify(source)).toContain('cred-9f8e7d');
    expect(prepared.completeRedactionGuaranteed).toBe(false);
  });
});
