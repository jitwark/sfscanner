import { describe, expect, it } from 'vitest';
import type { Entry, EntryReadiness } from '@hub/contracts';
import { makeEntry, makeRights, makeSecurity, makeSource, makeStructure } from '../__fixtures__/make-entry.js';
import { NODE_COUNT_BINS, deriveCorpusAnalytics } from './corpus-analytics.js';

function entries(...overrides: Parameters<typeof makeEntry>[0][]): Entry[] {
  return overrides.map((override, index) => makeEntry({ id: `e${index}`, slug: `e${index}`, ...override }));
}

/** The honest state of a link-only row: no body, so nothing was analysed. */
const UNSCANNED_READINESS: EntryReadiness = {
  analysis: 'unscanned',
  credentials: [],
  replaceableValues: [],
  writeActions: [],
  aiModel: { present: false, model: null },
  extraPackages: [],
  versionNotes: [],
  pinnedData: { present: false, nodeCount: 0 },
  isSubWorkflow: false,
};

/** `makeEntry` leaves `readiness` unset; the row states below are exactly what it decides. */
function unscannedEntry(override: Parameters<typeof makeEntry>[0] = {}): Entry {
  return { ...makeEntry(override), readiness: UNSCANNED_READINESS };
}

function coverageOf(list: Entry[]) {
  const counts = { complete: 0, degraded: 0, indeterminate: 0, noResult: 0, noBody: 0, historical: 0, sourceUnavailable: 0 };
  for (const entry of list) {
    const security = entry.security;
    if (security?.stampReason === 'source_unavailable') counts.sourceUnavailable += 1;
    else if (security?.noResult === true) counts.noResult += 1;
    else if (entry.readiness?.analysis === 'unscanned' || security?.scannerVersion === 'unscanned' || security?.scannerVersion === 'not-scanned') counts.noBody += 1;
    else if (security?.analysisStatus === 'COMPLETE') counts.complete += 1;
    else if (security?.analysisStatus === 'DEGRADED') counts.degraded += 1;
    else if (security?.analysisStatus === 'INDETERMINATE') counts.indeterminate += 1;
    else counts.historical += 1;
  }
  return counts;
}

const derive = (list: Entry[], searchableDocumentCount = 0) => {
  const counts = coverageOf(list);
  const current = counts.complete + counts.degraded + counts.indeterminate;
  return deriveCorpusAnalytics(list, {
    searchableDocumentCount,
    v2Evidence: {
      scannerVersion: '2.0.0', engineBuildDigest: 'a'.repeat(64), profileId: 'beta-default', profileVersion: '2.0.0',
      rulesetId: 'scanner-core-builtins', rulesetVersion: '2.0.0', rulesetDigest: 'b'.repeat(64), signatureStatus: 'VERIFIED',
      semanticsId: 'scanner-core-builtins', semanticsVersion: '2.2.0', semanticsDigest: 'c'.repeat(64), limitsDigest: 'd'.repeat(64),
      inventorySha256: 'e'.repeat(64),
      inventory: { available: list.length, missing: 0, sourceUnavailable: 0 },
      states: { current, noResult: counts.noResult, historical: counts.historical, unscanned: counts.noBody, sourceUnavailable: counts.sourceUnavailable },
      current: { complete: counts.complete, degraded: counts.degraded, indeterminate: counts.indeterminate },
      excludedByRuling: 0,
    },
    nodeCoverage: {
      observedNodeTypes: 0, observedNodeInstances: 0, modelledTypes: 0, partlyModelledTypes: 0, unmodelledTypes: 0,
      versions: [], unknownTypes: [],
    },
  });
};

describe('deriveCorpusAnalytics', () => {
  it('counts rights, grades, triggers and complexity from the entries themselves', () => {
    const analytics = derive(
      entries(
        { rights: makeRights({ status: 'redistributable' }), security: makeSecurity({ grade: 'LOW' }), structure: makeStructure({ trigger: 'Webhook', complexity: 'simple' }) },
        { rights: makeRights({ status: 'link_only' }), security: makeSecurity({ grade: 'HIGH' }), structure: makeStructure({ trigger: 'Schedule', complexity: 'complex' }) },
        { rights: makeRights({ status: 'link_only' }), security: makeSecurity({ grade: 'HIGH' }), structure: makeStructure({ trigger: 'Schedule', complexity: 'complex' }) },
      ),
    );

    expect(analytics.total).toBe(3);
    expect(analytics.rights).toEqual({ redistributable: 1, linkOnly: 2 });
    expect(analytics.grades.LOW).toBe(1);
    expect(analytics.grades.HIGH).toBe(2);
    expect(analytics.triggers).toEqual([
      { label: 'Schedule', count: 2 },
      { label: 'Webhook', count: 1 },
    ]);
    expect(analytics.complexity).toEqual({ simple: 1, medium: 0, complex: 2 });
  });

  /**
   * The measured number, never the corpus total. `search-index.json` was stamped
   * with 13,221 over an index holding 1,962; the same mistake here would put a
   * wrong figure under a heading that reads "Searchable".
   */
  it('takes the searchable count from the index, not from the entry list', () => {
    const analytics = derive(entries({}, {}, {}), 2);
    expect(analytics.total).toBe(3);
    expect(analytics.searchable).toBe(2);
  });

  it('ranks the scanner policies that fire, separating workflows from occurrences', () => {
    const analytics = derive(
      entries(
        {
          security: makeSecurity({
            grade: 'HIGH',
            counts: { critical: 0, high: 2, medium: 0, low: 0, info: 0 },
            findings: [
              { id: 'N8N_CODE_NODE', title: 'Code node', severity: 'HIGH', why: 'w', fix: 'f' },
              { id: 'N8N_CODE_NODE', title: 'Code node', severity: 'HIGH', why: 'w', fix: 'f' },
            ],
          }),
        },
        {
          security: makeSecurity({
            grade: 'MEDIUM',
            counts: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
            findings: [{ id: 'WEBHOOK_EXPOSURE', title: 'Webhook', severity: 'MEDIUM', why: 'w', fix: 'f' }],
          }),
        },
        { security: makeSecurity({ grade: 'LOW', findings: [], analysisStatus: 'COMPLETE' }) },
      ),
    );

    expect(analytics.findings.workflowsWithFindings).toBe(2);
    expect(analytics.findings.cleanScanned).toBe(1);
    expect(analytics.findings.noFindingsRecorded).toBe(1);
    expect(analytics.findings.totalOccurrences).toBe(3);
    expect(analytics.findings.policies).toEqual([
      { id: 'N8N_CODE_NODE', title: 'Code node', severity: 'HIGH', workflows: 1, occurrences: 2 },
      { id: 'WEBHOOK_EXPOSURE', title: 'Webhook', severity: 'MEDIUM', workflows: 1, occurrences: 1 },
    ]);
  });

  /**
   * Row states, not stamps. A row whose readiness was never derived has no
   * scan behind it, whatever `scannerVersion` a retired build left on it: that
   * value records which scanner last touched the entry, not that one read a
   * body. Counting the stamp is how `data/analytics.json` came to report every
   * one of 11,464 rows as scanned.
   */
  it('does not count a retained old scanner stamp on an unscanned row as scanned', () => {
    const analytics = derive([
      makeEntry({
        id: 'e0',
        slug: 'e0',
        security: makeSecurity({ scannerVersion: 'scanner-beta-1', analysisStatus: 'COMPLETE' }),
      }),
      unscannedEntry({
        id: 'e1',
        slug: 'e1',
        security: makeSecurity({ scannerVersion: 'c998701', schemaVersion: 'scanner-result-v1' }),
      }),
    ]);

    expect(analytics.scanCoverage.scanned).toBe(1);
    expect(analytics.scanCoverage.notScanned).toBe(1);
    expect(analytics.scanCoverage.bodyAvailable).toBe(1);
    expect(analytics.scanCoverage.noBody).toBe(1);
    expect(analytics.scanCoverage.completed).toBe(1);
    expect(analytics.scanCoverage.historical).toBe(0);
    expect(analytics.scanCoverage.sourceUnavailable).toBe(0);
  });

  /**
   * The body exists — it is in the release's pack — but the upstream source could
   * not be re-acquired, which is why the stamp records `source_unavailable`.
   * Counting it as "no body at all" states something false about the artifact, so
   * it is its own row state, outside `noBody` and outside the scanned set, and it
   * stays inside `bodyAvailable`.
   */
  it('counts a source-unavailable stamp as its own row state, not as a row with no body', () => {
    const analytics = derive([
      makeEntry({
        id: 'e0',
        slug: 'e0',
        security: makeSecurity({ scannerVersion: 'scanner-beta-1', analysisStatus: 'COMPLETE' }),
      }),
      makeEntry({
        id: 'e1',
        slug: 'e1',
        security: makeSecurity({ scannerVersion: 'not-scanned', schemaVersion: 'scanner-result-v1', stampReason: 'source_unavailable' }),
      }),
      unscannedEntry({
        id: 'e2',
        slug: 'e2',
        security: makeSecurity({ scannerVersion: 'unscanned' }),
      }),
    ]);

    expect(analytics.scanCoverage).toEqual({
      total: 3,
      bodyAvailable: 2,
      scanned: 1,
      notScanned: 2,
      completed: 1,
      degraded: 0,
      indeterminate: 0,
      noResult: 0,
      noBody: 1,
      historical: 0,
      sourceUnavailable: 1,
    });
    // The row states partition the corpus exactly once.
    expect(
      analytics.scanCoverage.completed +
        analytics.scanCoverage.degraded +
        analytics.scanCoverage.indeterminate +
        analytics.scanCoverage.noResult +
        analytics.scanCoverage.noBody +
        analytics.scanCoverage.historical +
        analytics.scanCoverage.sourceUnavailable,
    ).toBe(analytics.scanCoverage.total);
  });

  /**
   * "Clean" is a claim a scan makes. A row with no body has no finding rows
   * either, and reading that absence as clean is the same mistake as reading
   * an empty credential list as "needs nothing".
   */
  it('does not count an unscanned row with zero findings as clean', () => {
    const analytics = derive([
      makeEntry({ id: 'e0', slug: 'e0', security: makeSecurity({ analysisStatus: 'COMPLETE' }) }),
      unscannedEntry({ id: 'e1', slug: 'e1', security: makeSecurity({ scannerVersion: 'c998701' }) }),
    ]);

    expect(analytics.findings.cleanScanned).toBe(1);
    expect(analytics.findings.noFindingsRecorded).toBe(2);
  });

  /**
   * A histogram is a distribution: the bins keep bin order. Sorting them by
   * magnitude destroys the only thing the chart exists to show.
   */
  it('bins node counts in bin order, including empty bins', () => {
    const analytics = derive(
      entries(
        { structure: makeStructure({ nodeCount: 1 }) },
        { structure: makeStructure({ nodeCount: 4 }) },
        { structure: makeStructure({ nodeCount: 4 }) },
        { structure: makeStructure({ nodeCount: 400 }) },
      ),
    );

    expect(analytics.nodeCountBins).toHaveLength(NODE_COUNT_BINS.length);
    expect(analytics.nodeCountBins.map((bin) => bin.label)).toEqual(NODE_COUNT_BINS.map((bin) => bin.label));
    expect(analytics.nodeCountBins[0]).toMatchObject({ label: '1–3', count: 1 });
    expect(analytics.nodeCountBins[1]).toMatchObject({ label: '4–7', count: 2 });
    expect(analytics.nodeCountBins.at(-1)).toMatchObject({ count: 1 });
    expect(analytics.nodeCountBins.reduce((sum, bin) => sum + bin.count, 0)).toBe(4);
    expect(analytics.nodeCountMedian).toBe(4);
  });

  it('cross-tabulates grade against complexity with every cell present', () => {
    const analytics = derive(
      entries(
        { security: makeSecurity({ grade: 'LOW' }), structure: makeStructure({ complexity: 'simple' }) },
        { security: makeSecurity({ grade: 'CRITICAL' }), structure: makeStructure({ complexity: 'complex' }) },
        { security: makeSecurity({ grade: 'CRITICAL' }), structure: makeStructure({ complexity: 'complex' }) },
      ),
    );

    // 4 grades (UNKNOWN excluded from the matrix) x 3 complexity bands.
    expect(analytics.gradeByComplexity.cells).toHaveLength(12);
    const critical = analytics.gradeByComplexity.cells.find((cell) => cell.grade === 'CRITICAL' && cell.complexity === 'complex');
    expect(critical).toMatchObject({ count: 2 });
    const empty = analytics.gradeByComplexity.cells.find((cell) => cell.grade === 'LOW' && cell.complexity === 'complex');
    expect(empty).toMatchObject({ count: 0 });
    expect(analytics.gradeByComplexity.max).toBe(2);
  });

  it('ranks integrations, node types and tags, and caps each list', () => {
    const analytics = derive(
      entries(
        { structure: makeStructure({ integrations: ['slack', 'set'], nodeTypes: ['n8n-nodes-base.slack'] }), tags: ['ops'] },
        { structure: makeStructure({ integrations: ['slack'], nodeTypes: ['n8n-nodes-base.slack', 'n8n-nodes-base.if'] }), tags: ['ops', 'ai'] },
      ),
    );

    expect(analytics.integrations[0]).toEqual({ label: 'slack', count: 2 });
    expect(analytics.nodeTypes[0]).toEqual({ label: 'n8n-nodes-base.slack', count: 2 });
    expect(analytics.tags[0]).toEqual({ label: 'ops', count: 2 });
    expect(analytics.integrations.length).toBeLessThanOrEqual(20);
  });

  it('rejects evidence whose current statuses disagree with the derived scanned count', () => {
    const list = [makeEntry({ id: 'one', security: { scannerVersion: '2.0.0', analysisStatus: 'COMPLETE', grade: 'LOW', score: 90 } })];
    expect(() => deriveCorpusAnalytics(list, {
      searchableDocumentCount: 1,
      v2Evidence: {
        scannerVersion: '2.0.0', engineBuildDigest: 'a'.repeat(64), profileId: 'beta-default', profileVersion: '2.0.0',
        rulesetId: 'scanner-core-builtins', rulesetVersion: '2.0.0', rulesetDigest: 'b'.repeat(64), signatureStatus: 'VERIFIED',
        semanticsId: 'scanner-core-builtins', semanticsVersion: '2.2.0', semanticsDigest: 'c'.repeat(64), limitsDigest: 'd'.repeat(64),
        inventorySha256: 'e'.repeat(64), inventory: { available: 1, missing: 0, sourceUnavailable: 0 },
        states: { current: 1, noResult: 0, historical: 0, unscanned: 0, sourceUnavailable: 0 },
        current: { complete: 0, degraded: 0, indeterminate: 0 }, excludedByRuling: 0,
      },
      nodeCoverage: { observedNodeTypes: 0, observedNodeInstances: 0, modelledTypes: 0, partlyModelledTypes: 0, unmodelledTypes: 0, versions: [], unknownTypes: [] },
    })).toThrow(/current statuses/);
  });

  it('reports provenance: sources, description origin and one row state per entry', () => {
    const analytics = derive(
      entries(
        { source: makeSource({ kind: 'github' }), descriptionSource: 'generated', security: makeSecurity({ scannerVersion: 'scanner-beta-1' }) },
        { source: makeSource({ kind: 'n8n_official' }), descriptionSource: 'upstream', security: makeSecurity({ scannerVersion: 'not-scanned' }) },
      ),
    );

    expect(analytics.sources).toEqual([
      { label: 'github', count: 1 },
      { label: 'n8n_official', count: 1 },
    ]);
    expect(analytics.enrichment).toEqual({ generated: 1, upstream: 1, fallback: 0 });
    // Row one carries a retired scanner's stamp but no published verdict, so its
    // body exists and its scan does not. Row two was never scanned: the stamp is
    // the acquirer's own "no body arrived" marker.
    expect(analytics.scanCoverage).toEqual({
      total: 2,
      bodyAvailable: 1,
      scanned: 0,
      notScanned: 2,
      completed: 0,
      degraded: 0,
      indeterminate: 0,
      noResult: 0,
      noBody: 1,
      historical: 1,
      sourceUnavailable: 0,
    });
  });

  it('is stable under an empty corpus rather than dividing by zero', () => {
    const analytics = derive([]);
    expect(analytics.total).toBe(0);
    expect(analytics.nodeCountMedian).toBe(0);
    expect(analytics.gradeByComplexity.max).toBe(0);
    expect(analytics.findings.policies).toEqual([]);
  });
});

describe('v2 analytics evidence', () => {
  it('reports the admitted evidence and node coverage it was given', () => {
    const list = [makeEntry({ id: 'one', security: { scannerVersion: '2.0.0', analysisStatus: 'COMPLETE', grade: 'LOW', score: 90 } })];
    const analytics = deriveCorpusAnalytics(list, {
      searchableDocumentCount: 1,
      v2Evidence: {
        scannerVersion: '2.0.0', engineBuildDigest: 'a'.repeat(64), profileId: 'beta-default', profileVersion: '2.0.0',
        rulesetId: 'scanner-core-builtins', rulesetVersion: '2.0.0', rulesetDigest: 'b'.repeat(64), signatureStatus: 'VERIFIED',
        semanticsId: 'scanner-core-builtins', semanticsVersion: '2.2.0', semanticsDigest: 'c'.repeat(64), limitsDigest: 'd'.repeat(64),
        inventorySha256: 'e'.repeat(64), inventory: { available: 1, missing: 0, sourceUnavailable: 0 },
        states: { current: 1, noResult: 0, historical: 0, unscanned: 0, sourceUnavailable: 0 },
        current: { complete: 1, degraded: 0, indeterminate: 0 }, 
      excludedByRuling: 0,
      },
      nodeCoverage: {
        observedNodeTypes: 1, observedNodeInstances: 2, modelledTypes: 1, partlyModelledTypes: 0, unmodelledTypes: 0,
        versions: [{ nodeType: 'n8n-nodes-base.gmail', version: '2.2.0', workflows: 1, instances: 2, semantics: 'MODELLED' }],
        unknownTypes: [],
      },
    });
    expect(analytics.schemaVersion).toBe(4);
    expect(analytics.v2Evidence.states.current).toBe(1);
    expect(analytics.nodeCoverage.versions[0]?.version).toBe('2.2.0');
  });

  it('refuses evidence whose states do not account for every entry', () => {
    const list = [makeEntry({ id: 'one' })];
    expect(() => deriveCorpusAnalytics(list, {
      searchableDocumentCount: 1,
      v2Evidence: {
        scannerVersion: '2.0.0', engineBuildDigest: 'a'.repeat(64), profileId: 'beta-default', profileVersion: '2.0.0',
        rulesetId: 'scanner-core-builtins', rulesetVersion: '2.0.0', rulesetDigest: 'b'.repeat(64), signatureStatus: 'VERIFIED',
        semanticsId: 'scanner-core-builtins', semanticsVersion: '2.2.0', semanticsDigest: 'c'.repeat(64), limitsDigest: 'd'.repeat(64),
        inventorySha256: 'e'.repeat(64), inventory: { available: 1, missing: 0, sourceUnavailable: 0 },
        states: { current: 0, noResult: 0, historical: 0, unscanned: 0, sourceUnavailable: 0 },
        current: { complete: 0, degraded: 0, indeterminate: 0 }, 
      excludedByRuling: 0,
      },
      nodeCoverage: { observedNodeTypes: 0, observedNodeInstances: 0, modelledTypes: 0, partlyModelledTypes: 0, unmodelledTypes: 0, versions: [], unknownTypes: [] },
    })).toThrow(/do not sum/);
  });
});
