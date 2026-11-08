import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CorpusAnalytics } from '@hub/contracts';
import AnalyticsPage from './page';

const state = vi.hoisted(() => ({ analytics: null as unknown as CorpusAnalytics }));

vi.mock('../../src/catalogue/analytics-node', () => ({
  readAnalyticsSync: () => state.analytics,
  readReleaseSnapshotSync: () => ({
    generatedAt: '2026-11-07T09:32:14.957Z',
    corpusSha256: '025e8707c8a9c93d99e6f191e9e23ec73403b7af0e2f419695857e32cd9ab634',
  }),
}));
vi.mock('../../src/seo/json-ld', () => ({ JsonLdScript: () => null, pageJsonLd: () => ({}) }));

const ANALYTICS: CorpusAnalytics = {
  schemaVersion: 4,
  total: 25,
  searchable: 20,
  rights: { redistributable: 5, linkOnly: 20 },
  grades: { LOW: 20, MEDIUM: 2, HIGH: 1, CRITICAL: 0, UNKNOWN: 2 },
  triggers: [{ label: 'Webhook', count: 25 }],
  complexity: { simple: 10, medium: 10, complex: 5 },
  capabilities: { hasCode: 1, hasAI: 1, hasWebhook: 25 },
  integrations: [{ label: 'slack', count: 25 }],
  nodeTypes: [{ label: 'n8n-nodes-base.slack', count: 25 }],
  tags: [{ label: 'ops', count: 25 }],
  sources: [{ label: 'github', count: 25 }],
  findings: {
    totalOccurrences: 7,
    workflowsWithFindings: 4,
    cleanScanned: 13,
    noFindingsRecorded: 19,
    bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 1, LOW: 5, INFO: 0 },
    policies: [{ id: 'WEBHOOK_EXPOSURE', title: 'Webhook exposed', severity: 'HIGH', workflows: 4, occurrences: 7 }],
  },
  nodeCountBins: [
    { label: '1–3', min: 1, max: 3, count: 25 },
    { label: '4–7', min: 4, max: 7, count: 0 },
  ],
  nodeCountMedian: 2,
  gradeByComplexity: { cells: [], max: 0 },
  enrichment: { generated: 5, upstream: 15, fallback: 5 },
  scanCoverage: {
    total: 25,
    bodyAvailable: 22,
    scanned: 19,
    notScanned: 6,
    completed: 17,
    degraded: 2,
    indeterminate: 0,
    noResult: 1,
    noBody: 3,
    historical: 0,
    sourceUnavailable: 2,
  },
  v2Evidence: {
    scannerVersion: '2.1.0',
    engineBuildDigest: 'a'.repeat(64),
    profileId: 'beta-default',
    profileVersion: '4',
    rulesetId: 'v2-default',
    rulesetVersion: '7',
    rulesetDigest: 'b'.repeat(64),
    signatureStatus: 'verified',
    semanticsId: 'catalogue',
    semanticsVersion: '2.1.0',
    semanticsDigest: 'c'.repeat(64),
    limitsDigest: 'd'.repeat(64),
    inventorySha256: 'e'.repeat(64),
    inventory: { available: 20, missing: 3, sourceUnavailable: 2 },
    states: { current: 19, noResult: 1, historical: 0, unscanned: 3, sourceUnavailable: 2 },
    current: { complete: 17, degraded: 2, indeterminate: 0 },
    excludedByRuling: 2,
  },
  nodeCoverage: {
    observedNodeTypes: 10,
    observedNodeInstances: 100,
    modelledTypes: 6,
    partlyModelledTypes: 2,
    unmodelledTypes: 2,
    versions: [],
    unknownTypes: [],
  },
};

const ZERO_ANALYTICS: CorpusAnalytics = {
  ...ANALYTICS,
  total: 0,
  searchable: 0,
  rights: { redistributable: 0, linkOnly: 0 },
  grades: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, UNKNOWN: 0 },
  triggers: [],
  complexity: { simple: 0, medium: 0, complex: 0 },
  capabilities: { hasCode: 0, hasAI: 0, hasWebhook: 0 },
  integrations: [],
  nodeTypes: [],
  tags: [],
  sources: [],
  findings: {
    totalOccurrences: 0,
    workflowsWithFindings: 0,
    cleanScanned: 0,
    noFindingsRecorded: 0,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    policies: [],
  },
  nodeCountBins: [{ label: '1–3', min: 1, max: 3, count: 0 }],
  nodeCountMedian: 0,
  scanCoverage: {
    total: 0,
    bodyAvailable: 0,
    scanned: 0,
    notScanned: 0,
    completed: 0,
    degraded: 0,
    indeterminate: 0,
    noResult: 0,
    noBody: 0,
    historical: 0,
    sourceUnavailable: 0,
  },
  v2Evidence: {
    ...ANALYTICS.v2Evidence,
    inventory: { available: 0, missing: 0, sourceUnavailable: 0 },
    states: { current: 0, noResult: 0, historical: 0, unscanned: 0, sourceUnavailable: 0 },
    current: { complete: 0, degraded: 0, indeterminate: 0 },
  },
};

beforeEach(() => {
  state.analytics = ANALYTICS;
});

afterEach(() => cleanup());

describe('AnalyticsPage', () => {
  it('renders current counts and a readable release snapshot date', () => {
    render(<AnalyticsPage />);

    const copy = document.body.textContent!.replace(/\s+/g, ' ');
    expect(copy).toContain('25 workflows');
    expect(copy).toContain('20');
    expect(copy).toContain('7 Nov 2026');
    expect(copy).toContain('With findings');
    expect(copy).toContain('16.0% of catalogue');
    expect(copy).not.toContain('2026-11-07T09:32:14.957Z');
    expect(copy).not.toContain('025e8707');
    expect(copy).not.toContain('beta-default');
    expect(copy).not.toContain('Current v2 results');
    expect(copy).not.toContain('17 complete · 2 partial · 0 incomplete');
  });

  it('removes both coverage sections and their descriptive copy', () => {
    const { container } = render(<AnalyticsPage />);

    expect(screen.queryByRole('heading', { name: 'Node semantics coverage' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Scan coverage' })).toBeNull();
    expect(container.querySelector('#nodes-heading')).toBeNull();
    expect(container.querySelector('#coverage-heading')).toBeNull();

    const copy = document.body.textContent!.replace(/\s+/g, ' ');
    expect(copy).not.toContain('catalogue coverage, not security accuracy');
    expect(copy).not.toContain('bound readable inputs');
    expect(copy).not.toContain('every entry lands in exactly one state');
    expect(copy).not.toContain('signature verified');
  });

  it('keeps chart denominators explicit and concise', () => {
    render(<AnalyticsPage />);

    const copy = document.body.textContent!.replace(/\s+/g, ' ');
    expect(copy).toContain('Reach across 25 workflows');
    expect(copy).toContain('4 of 25 workflows');
    expect(copy).toContain('13 clean of 17 complete scans');
    expect(copy).toContain('6 rows without a clean completed scan');
    expect(copy).toContain('80.0% of catalogue');
  });

  it('renders empty and zero data without NaN, Infinity or a false clean claim', () => {
    state.analytics = ZERO_ANALYTICS;
    render(<AnalyticsPage />);

    const copy = document.body.textContent!.replace(/\s+/g, ' ');
    expect(copy).not.toMatch(/NaN|Infinity/);
    expect(copy).toContain('No findings recorded.');
    expect(copy).toContain('0.0% of catalogue');
    expect(screen.getByRole('heading', { name: 'Security grades' })).toBeTruthy();
    expect(screen.getByText('Unknown excluded')).toBeTruthy();
  });
});
