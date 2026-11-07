import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CorpusAnalytics } from '@hub/contracts';
import AnalyticsPage from './page';

afterEach(() => cleanup());

// Five rows short of the corpus total (20 of 25) are read under the current contract, so
// every figure below has a denominator that is visibly not the whole catalogue.
// The numbers are small on purpose: the page's job is to state them, and a test
// that mirrors the shipped corpus would only prove it can repeat itself.
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
    versions: [
      { nodeType: 'n8n-nodes-base.slack', version: '2', workflows: 25, instances: 30, semantics: 'MODELLED' },
    ],
    unknownTypes: [{ nodeType: 'n8n-nodes-base.mystery', workflows: 4, instances: 5, versions: ['1'] }],
  },
};

vi.mock('../../src/catalogue/analytics-node', () => ({
  readAnalyticsSync: () => ANALYTICS,
  readReleaseSnapshotSync: () => ({ generatedAt: '2026-10-20T00:00:00.000Z', corpusSha256: 'f'.repeat(64) }),
}));
vi.mock('../../src/seo/json-ld', () => ({ JsonLdScript: () => null, pageJsonLd: () => ({}) }));

describe('AnalyticsPage', () => {
  /**
   * The header used to claim the stored findings came "from the same
   * deterministic scanner that runs in your browser". They do not: catalogue
   * verdicts are admitted against a recorded v2 identity, and the browser is a
   * separate run. The scanned figure has exclusions the page has to name, or
   * "20 scanned" reads as "the corpus was scanned".
   */
  it('states the admitted v2 identity and what the current-verdict count excludes', () => {
    render(<AnalyticsPage />);

    const copy = document.body.textContent!.replace(/\s+/g, ' ');
    expect(copy).not.toContain('same deterministic scanner that runs in your browser');
    expect(copy).toContain('admitted v2 receipt matches the full engine, profile, ruleset and semantics identity');
    expect(copy).toContain('17 complete, 2 degraded, 0 indeterminate');
    expect(copy).toContain('1 was refused without a result and publish no grade');
    expect(copy).toContain('0 carry only a retired-engine verdict');
    expect(copy).toContain('3 have no input');
    expect(copy).toContain('2 are owner-ruled source-unavailable');
    expect(copy).toContain('not security accuracy');
  });

  /**
   * A clean count is a claim about scans. The page must not let it stand as a
   * whole-catalogue rate, and must name the rows that only have no finding
   * recorded.
   */
  it('denominates findings by the scans that completed, not by the catalogue', () => {
    render(<AnalyticsPage />);

    const copy = document.body.textContent!.replace(/\s+/g, ' ');
    expect(copy).toContain('13 of the 17 scans that completed carry none');
    expect(copy).toContain('6 entries have no findings recorded but were not scanned');
  });

  /**
   * The policy bars divide by the population their numerators came from, and a
   * finding recorded on a row without a current-contract scan is still in that
   * numerator — so the denominator is the catalogue, and the prose says so.
   */
  it('measures policy reach over the catalogue its findings were counted on', () => {
    render(<AnalyticsPage />);

    const copy = document.body.textContent!.replace(/\s+/g, ' ');
    expect(copy).toContain('how many of the 25 catalogued workflows it reaches');
    expect(copy).toContain('not a scanned-only rate');
  });

  /** States partition the catalogue; the page prints the identity receipts were checked against. */
  it('renders coverage states that reconcile and the identity they were admitted under', () => {
    render(<AnalyticsPage />);

    const copy = document.body.textContent!.replace(/\s+/g, ' ');
    expect(copy).toContain('every entry lands in exactly one state');
    expect(copy).toContain('beta-default v4');
    expect(copy).toContain('v2-default v7 · signature verified');
    expect(copy).toContain('catalogue v2.1.0');
    expect(copy).toContain('20 available · 3 missing · 2 source-unavailable');
    expect(copy).toContain('2026-10-20T00:00:00.000Z');
  });

  /** Node coverage is catalogue coverage; the page must not imply it is a safety measure. */
  it('shows node semantics coverage with unmodelled types named', () => {
    render(<AnalyticsPage />);

    const copy = document.body.textContent!.replace(/\s+/g, ' ');
    expect(copy).toContain('catalogue coverage, not security accuracy');
    expect(copy).toContain('Counted over the 20 bound readable inputs, including the 1 engine refusal');
    expect(screen.getByText('n8n-nodes-base.mystery')).toBeTruthy();
  });
});
