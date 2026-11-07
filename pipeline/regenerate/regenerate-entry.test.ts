import { describe, expect, it, vi } from 'vitest';
import { SCANNER_RESULT_SCHEMA_VERSION, READINESS_UNSCANNED_DISCLAIMER, type Entry } from '@hub/contracts';
import { normaliseWithCommittedBody, normaliseWithoutBody, regenerateFromBody, unscannedReadiness } from './regenerate-entry.js';

const TARGET = { targetVersion: '2.34.6', checkedAt: '2026-08-16', source: 'npm view n8n version' };

/** A scanner that reports one HIGH finding, so the projection has something to carry. */
function mockScan() {
  return vi.fn().mockImplementation(() => ({
    schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
    scannerVersion: 'test',
    analysisStatus: 'COMPLETE',
    analysisDiagnostics: [],
    riskAssessment: { grade: 'HIGH', score: 55 },
    summary: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    findings: [{
      policyId: 'RAW_SECRET_INDICATOR',
      title: 'Secret-shaped value',
      severity: 'HIGH',
      location: { nodeId: '1', nodeName: 'HTTP' },
      whyItMatters: 'Literal secret material',
      remediation: 'Use a credential',
    }],
  }));
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    slug: 'e1',
    title: 'Title',
    summary: 'Summary',
    description: 'Description',
    descriptionSource: 'upstream',
    source: { kind: 'n8n_official', permalink: 'https://n8n.io/workflows/1', templateId: 1, fetchedAt: '2026-09-01T00:00:00.000Z' },
    rights: { status: 'link_only', licence: null, licenceUrl: null, reason: 'official n8n template' },
    structure: {
      nodeCount: 2,
      rawNodeCount: 2,
      annotationNodeCount: 0,
      connectionCount: 1,
      nodeTypes: ['n8n-nodes-base.googleSheets', 'n8n-nodes-base.httpRequest'],
      integrations: ['google-sheets', 'http-request', 'code'],
      trigger: 'Manual',
      isSubWorkflow: false,
      complexity: 'simple',
      hasCode: false,
      hasAI: false,
      hasWebhook: false,
      partial: true,
    },
    readiness: {
      credentials: [],
      replaceableValues: [],
      writeActions: [],
      aiModel: { present: false, model: null },
      extraPackages: [],
      versionNotes: [],
      pinnedData: { present: false, nodeCount: 0 },
      isSubWorkflow: false,
    },
    security: { grade: 'UNKNOWN', score: 0, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [], hardenedExtra: 0, scannerVersion: 'c998701', profile: 'beta-default' },
    tags: [],
    dedup: { fingerprint: 'f', structuralHash: 's', canonical: false, alsoFoundIn: [] },
    ...overrides,
  } as Entry;
}

describe('normaliseWithoutBody', () => {
  it('maps the published labels onto the canonical vocabulary and drops capability words', () => {
    const result = normaliseWithoutBody(entry());
    expect(result.structure.integrations).toEqual(['google-sheets']);
  });

  it('marks the readiness report unscanned instead of leaving an empty list that reads as "none required"', () => {
    const result = normaliseWithoutBody(entry());
    expect(result.readiness?.analysis).toBe('unscanned');
    expect(result.readiness?.credentials).toEqual([]);
  });

  it('keeps every other published field, including the partial-structure flag', () => {
    const before = entry();
    const result = normaliseWithoutBody(before);
    expect(result.structure.partial).toBe(true);
    expect(result.title).toBe(before.title);
    expect(result.security).toEqual(before.security);
    expect(result.source).toEqual(before.source);
  });

  it('publishes an explicit report when the entry had none', () => {
    const result = normaliseWithoutBody(entry({ readiness: undefined }));
    expect(result.readiness).toEqual(unscannedReadiness());
  });

  it('does not mutate the entry it is given', () => {
    const before = entry();
    normaliseWithoutBody(before);
    expect(before.structure.integrations).toEqual(['google-sheets', 'http-request', 'code']);
    expect(before.readiness?.analysis).toBeUndefined();
  });

  it('names no workflow JSON and claims nothing absent in its disclaimer', () => {
    expect(READINESS_UNSCANNED_DISCLAIMER).toContain('No workflow JSON was available');
    expect(READINESS_UNSCANNED_DISCLAIMER).toContain('unknown');
  });
});

describe('normaliseWithCommittedBody', () => {
  it('moves only the vocabulary and keeps the report a derived one', () => {
    const result = normaliseWithCommittedBody(entry());
    expect(result.structure.integrations).toEqual(['google-sheets']);
    expect(result.readiness?.analysis).toBe('derived');
  });

  it('does not touch the facts a sanitized body cannot reproduce', () => {
    const before = entry();
    const result = normaliseWithCommittedBody(before);
    expect(result.chartRef).toEqual(before.chartRef);
    expect(result.security).toEqual(before.security);
    expect(result.compatibility).toBeUndefined();
    expect(result.hostnames).toBeUndefined();
  });
});

describe('regenerateFromBody', () => {
  const body = {
    nodes: [
      { id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', position: [0, 0] },
      { id: '2', name: 'Send', type: 'n8n-nodes-base.slack', position: [240, 0], credentials: { slackApi: { id: 'x', name: 'Slack' } } },
    ],
    connections: { Start: { main: [[{ node: 'Send', type: 'main', index: 0 }]] } },
  };

  it('recomputes structure, chart, readiness and the verdict from the body', async () => {
    const result = await regenerateFromBody({
      entry: entry(),
      body,
      chart: { nodes: [], edges: [] },
      compatibilityTarget: TARGET,
      scan: mockScan(),
      scannerVersion: 'test',
    });

    expect(result.outcome).toBe('re-derived');
    expect(result.entry.structure.integrations).toEqual(['slack']);
    expect(result.entry.structure.partial).toBeUndefined();
    expect(result.entry.readiness?.analysis).toBe('derived');
    expect(result.entry.readiness?.credentials).toEqual(['Slack']);
    expect(result.entry.security.grade).toBe('HIGH');
    expect(result.entry.security.scannerVersion).toBe('test');
    expect(result.chart.nodes.map((node) => node.name)).toEqual(['Start', 'Send']);
    expect(result.chart.edges).toHaveLength(1);
  });

  it('publishes pinData presence and node count, never a payload', async () => {
    const withPin = { ...body, pinData: { Send: [{ json: { secret: 'payload-value' } }] } };
    const result = await regenerateFromBody({
      entry: entry(),
      body: withPin,
      chart: { nodes: [], edges: [] },
      compatibilityTarget: TARGET,
      scan: mockScan(),
      scannerVersion: 'test',
    });

    expect(result.entry.readiness?.pinnedData).toEqual({ present: true, nodeCount: 1 });
    expect(JSON.stringify(result.entry)).not.toContain('payload-value');
  });

  it('does not mutate the entry it is given', async () => {
    const before = entry();
    await regenerateFromBody({ entry: before, body, chart: { nodes: [], edges: [] }, compatibilityTarget: TARGET, scan: mockScan(), scannerVersion: 'test' });
    expect(before.structure.integrations).toEqual(['google-sheets', 'http-request', 'code']);
  });
});
