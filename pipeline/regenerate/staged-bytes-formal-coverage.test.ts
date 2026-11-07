import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { V2_ARTIFACT_GROUPS } from './v2-regenerate-entry.js';
import { sweepStagedBytes } from './staged-bytes-sweep.js';
import type { Q02FormalCoverageV1 } from './formal-node-coverage.js';

const DIGEST = 'a'.repeat(64);
const scratchDirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-coverage-sweep-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const binding = {
  inventoryFileSha256: DIGEST, inventorySha256: DIGEST, bodyMapSha256: DIGEST,
  scopedSemanticsDigest: DIGEST, legacySemanticsDigest: DIGEST, engineBuildDigest: DIGEST,
  sourceReceiptSha256: DIGEST, producerSourceSha256: DIGEST, sourceBindingsSha256: DIGEST,
  measurementContextSha256: DIGEST,
  executionContext: {
    limits: { ...DEFAULT_SCANNER_LIMITS_V2 }, lockfileSha256: DIGEST,
    runtime: { node: 'v22.17.0', v8: 'v12.4.254.21-node.26', platform: 'win32', arch: 'x64', loaderArgumentsSha256: DIGEST },
    tools: Object.fromEntries(['@humanwhocodes/momoa', '@noble/hashes', 'tsx', 'typescript']
      .map((name) => [name, `1.0.0:${DIGEST}`])),
  },
};

function completeCoverage() {
  const rates: Q02FormalCoverageV1['rates'] = {
    reviewedExecutableInstances: { numerator: 1, denominator: 1, ratio: 1, meets95Percent: true },
    fullyModelledWorkflows: { numerator: 1, denominator: 1, ratio: 1, meets90Percent: true },
  };
  return {
    schemaVersion: 'q02-formal-coverage-v1', status: 'COMPLETE', countsScope: 'FULL_COHORT',
    cohort: { id: 'q02-official-nodes-v1', ruleVersion: 'executable-official-scoped-v1', namespaces: ['n8n-nodes-base', '@n8n/n8n-nodes-langchain'] },
    binding,
    counts: { cohortWorkflows: 1, workflowsWithExecutableNodes: 1, executableInstances: 1, reviewedExecutableInstances: 1, fullyModelledWorkflows: 1, reviewedInertNodes: 0 },
    rates,
    exclusions: [], unknownMeasurements: [],
    wholeCorpus: {
      inventoryRows: 1, availableBodies: 1, missing: 0, sourceUnavailable: 0, malformed: 0, rejected: 0,
      measurementUnknown: 0, communityPackage: 0, invalidNodeIdentity: 0, noExecutableNode: 0,
      formalCohort: 1, disabledNodes: 0, reviewedInertNodes: 0,
      inventoryStatuses: { AVAILABLE: 1, MISSING: 0, SOURCE_UNAVAILABLE: 0, UNPARSEABLE: 0, REJECTED: 0 },
    },
  };
}

function incompleteCoverage(cause: unknown, stage = 'NORMALIZATION', code = 'WORKFLOW_TOO_COMPLEX') {
  const coverage = completeCoverage();
  const rates: Q02FormalCoverageV1['rates'] = {
    reviewedExecutableInstances: { numerator: null, denominator: null, ratio: null, meets95Percent: false },
    fullyModelledWorkflows: { numerator: null, denominator: null, ratio: null, meets90Percent: false },
  };
  return {
    ...coverage, status: 'INCOMPLETE', countsScope: 'EXAMINED_COHORT_ONLY',
    counts: { cohortWorkflows: 0, workflowsWithExecutableNodes: 0, executableInstances: 0, reviewedExecutableInstances: 0, fullyModelledWorkflows: 0, reviewedInertNodes: 0 },
    rates,
    unknownMeasurements: [{ entryId: '0000000000000001', stage, code, ...(cause === undefined ? {} : { cause }) }],
    wholeCorpus: { ...coverage.wholeCorpus, measurementUnknown: 1, formalCohort: 0 },
  };
}

function staged(formalCoverage: unknown): string {
  const root = scratch();
  const report = {
    schemaVersion: 'v2-regeneration-run-v1', inventorySha256: DIGEST, entryCount: 1,
    states: { CURRENT: 0, NO_RESULT: 0, HISTORICAL: 0, UNSCANNED: 1, SOURCE_UNAVAILABLE: 0 },
    reasons: { 'admitted-receipt': 0, 'readiness-contradiction': 0, 'unadmitted-receipt': 0, 'no-result': 0, 'retained-verdict': 0, 'no-receipt': 1, 'owner-ruling': 0 },
    artifactGroups: V2_ARTIFACT_GROUPS.map((group) => ({ group, regenerated: 0, historical: 0, unavailable: 1 })),
    currentVerdicts: { count: 0, producingIdentities: [] },
    plans: [{
      schemaVersion: 'v2-entry-regeneration-plan-v1', entryId: '0000000000000001', state: 'UNSCANNED',
      stateReason: 'no-receipt', rightsClass: 'link_only', inventorySha256: DIGEST,
      assessment: null, bodySha256: null, resultDigest: null, receiptReasonCode: null,
      artifacts: V2_ARTIFACT_GROUPS.map((group) => ({ group, disposition: 'unavailable' })),
    }],
    formalCoverage,
  };
  fs.writeFileSync(path.join(root, 'v2-regeneration-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'v2-scan-evidence.ndjson'), `${JSON.stringify({
    schemaVersion: 'v2-scan-evidence-v1', entryId: '0000000000000001', scanFreshness: 'UNSCANNED',
    rightsClass: 'link_only', inventorySha256: DIGEST, scan: null, retainedVerdict: null, receiptReasonCode: null,
  })}\n`);
  return root;
}

function findingsFor(formalCoverage: unknown) {
  return sweepStagedBytes({ roots: [{ label: 'run-a', dir: staged(formalCoverage) }] }).findings
    .filter((finding) => finding.path.startsWith('$.formalCoverage'));
}

function summaryCoverage(cohort: number, executable: number, reviewed: number, fully: number) {
  const coverage = completeCoverage();
  coverage.counts = { ...coverage.counts, cohortWorkflows: cohort, workflowsWithExecutableNodes: cohort,
    executableInstances: executable, reviewedExecutableInstances: reviewed, fullyModelledWorkflows: fully };
  coverage.wholeCorpus = { ...coverage.wholeCorpus, inventoryRows: cohort, availableBodies: cohort,
    formalCohort: cohort, inventoryStatuses: { ...coverage.wholeCorpus.inventoryStatuses, AVAILABLE: cohort } };
  coverage.rates = {
    reviewedExecutableInstances: { numerator: reviewed, denominator: executable, ratio: executable === 0 ? null : reviewed / executable,
      meets95Percent: executable > 0 && BigInt(reviewed) * 100n >= BigInt(executable) * 95n },
    fullyModelledWorkflows: { numerator: fully, denominator: cohort, ratio: cohort === 0 ? null : fully / cohort,
      meets90Percent: cohort > 0 && BigInt(fully) * 100n >= BigInt(cohort) * 90n },
  };
  return coverage;
}

describe('staged formal coverage consistency', () => {
  it.each([false, true].flatMap((incomplete) => [[1, 2, 1, 1], [2, 2, 2, 1]]
    .map(([cohort, executable, reviewed, fully]) => ({ incomplete, cohort, executable, reviewed, fully }))))
  ('rejects impossible fully-modelled totals %j', ({ incomplete, cohort, executable, reviewed, fully }) => {
      const coverage = summaryCoverage(cohort, executable, reviewed, fully);
      const candidate = incomplete ? { ...coverage, status: 'INCOMPLETE', countsScope: 'EXAMINED_COHORT_ONLY',
        rates: incompleteCoverage('NODE_LIMIT').rates, unknownMeasurements: incompleteCoverage('NODE_LIMIT').unknownMeasurements,
        wholeCorpus: { ...coverage.wholeCorpus, inventoryRows: cohort + 1, availableBodies: cohort + 1, measurementUnknown: 1,
          inventoryStatuses: { ...coverage.wholeCorpus.inventoryStatuses, AVAILABLE: cohort + 1 } } } : coverage;
      expect(findingsFor(candidate), JSON.stringify(candidate.counts)).not.toEqual([]);
  });

  it.each([[0, 0, 0, 0], [1, 1, 1, 1], [1, 2, 1, 0], [2, 3, 2, 1]])
  ('preserves valid zero/full/partial totals %s/%s/%s/%s with and without unknown measurements', (cohort, executable, reviewed, fully) => {
    const coverage = summaryCoverage(cohort, executable, reviewed, fully);
    expect(findingsFor(coverage)).toEqual([]);
    expect(findingsFor({ ...coverage, status: 'INCOMPLETE', countsScope: 'EXAMINED_COHORT_ONLY',
      rates: incompleteCoverage('NODE_LIMIT').rates, unknownMeasurements: incompleteCoverage('NODE_LIMIT').unknownMeasurements,
      wholeCorpus: { ...coverage.wholeCorpus, inventoryRows: cohort + 1, availableBodies: cohort + 1, measurementUnknown: 1,
        inventoryStatuses: { ...coverage.wholeCorpus.inventoryStatuses, AVAILABLE: cohort + 1 } } })).toEqual([]);
  });

  it.each([[], ['n8n-nodes-base'], ['n8n-nodes-base', 'n8n-nodes-base'], ['@n8n/n8n-nodes-langchain', 'n8n-nodes-base']]
    .map((namespaces) => ({ namespaces })))
  ('rejects non-producer namespace sequence %j', ({ namespaces }) => {
    const coverage = completeCoverage();
    coverage.cohort.namespaces = namespaces;
    expect(findingsFor(coverage)).not.toEqual([]);
  });

  it('bounds cohort inert nodes by whole-corpus inert nodes while allowing excluded inert nodes', () => {
    const coverage = completeCoverage();
    coverage.counts.reviewedInertNodes = 999;
    expect(findingsFor(coverage)).not.toEqual([]);
    coverage.wholeCorpus.reviewedInertNodes = 999;
    expect(findingsFor(coverage)).toEqual([]);
    const excludedOnly = summaryCoverage(0, 0, 0, 0);
    expect(findingsFor({ ...excludedOnly, exclusions: [{ entryId: '0000000000000002', reason: 'NO_EXECUTABLE_NODE' }],
      wholeCorpus: { ...excludedOnly.wholeCorpus, inventoryRows: 1, availableBodies: 1, noExecutableNode: 1, reviewedInertNodes: 1,
        inventoryStatuses: { ...excludedOnly.wholeCorpus.inventoryStatuses, AVAILABLE: 1 } } })).toEqual([]);
  });

  it.each(['exclusions', 'unknown', 'overlap', 'distinct'])('checks disjoint row identities: %s', (mode) => {
    const coverage = summaryCoverage(0, 0, 0, 0);
    const refusal = incompleteCoverage('NODE_LIMIT').unknownMeasurements[0]!;
    const first = { entryId: '0000000000000001', reason: 'MISSING' };
    const exclusions = mode === 'exclusions' ? [first, { ...first }] : mode === 'unknown' ? [] : [first];
    const unknownMeasurements = mode === 'unknown' ? [refusal, { ...refusal }]
      : mode === 'exclusions' ? [] : [{ ...refusal, entryId: mode === 'distinct' ? '0000000000000002' : first.entryId }];
    const missing = exclusions.length; const unknown = unknownMeasurements.length;
    const candidate = { ...coverage, status: unknown ? 'INCOMPLETE' : 'COMPLETE',
      countsScope: unknown ? 'EXAMINED_COHORT_ONLY' : 'FULL_COHORT',
      rates: unknown ? incompleteCoverage('NODE_LIMIT').rates : coverage.rates, exclusions, unknownMeasurements,
      wholeCorpus: { ...coverage.wholeCorpus, inventoryRows: missing + unknown, availableBodies: unknown, missing, measurementUnknown: unknown,
        inventoryStatuses: { ...coverage.wholeCorpus.inventoryStatuses, AVAILABLE: unknown, MISSING: missing } } };
    if (mode === 'distinct') expect(findingsFor(candidate)).toEqual([]);
    else expect(findingsFor(candidate)).not.toEqual([]);
  });

  it('accepts null and the producer-shaped COMPLETE and INCOMPLETE reports', () => {
    expect(findingsFor(null)).toEqual([]);
    expect(findingsFor(completeCoverage())).toEqual([]);
    expect(findingsFor(incompleteCoverage('NODE_LIMIT'))).toEqual([]);
  });

  it('rejects impossible count and rate combinations', () => {
    const zeroDenominator = completeCoverage();
    zeroDenominator.counts.executableInstances = 0;
    zeroDenominator.counts.reviewedExecutableInstances = 0;
    zeroDenominator.rates.reviewedExecutableInstances = { numerator: 1, denominator: 0, ratio: null, meets95Percent: false };
    expect(findingsFor(zeroDenominator).some((finding) => finding.rule === 'unknown-value')).toBe(true);

    const fabricatedRatio = completeCoverage();
    fabricatedRatio.counts.executableInstances = 0;
    fabricatedRatio.counts.reviewedExecutableInstances = 0;
    fabricatedRatio.rates.reviewedExecutableInstances = { numerator: 0, denominator: 0, ratio: 0.5, meets95Percent: false };
    expect(findingsFor(fabricatedRatio).some((finding) => finding.rule === 'unknown-value')).toBe(true);

    const nullRatioMet = completeCoverage();
    nullRatioMet.rates.reviewedExecutableInstances = { numerator: 1, denominator: 1, ratio: null, meets95Percent: true };
    expect(findingsFor(nullRatioMet).some((finding) => finding.rule === 'unknown-value')).toBe(true);

    const wrongScope = completeCoverage();
    wrongScope.countsScope = 'EXAMINED_COHORT_ONLY';
    expect(findingsFor(wrongScope).some((finding) => finding.rule === 'unknown-value')).toBe(true);

    const incompleteNumeric = incompleteCoverage('NODE_LIMIT');
    incompleteNumeric.rates.reviewedExecutableInstances = { numerator: 1, denominator: 1, ratio: 1, meets95Percent: true };
    expect(findingsFor(incompleteNumeric).some((finding) => finding.rule === 'unknown-value')).toBe(true);
  });

  it.each([
    ['arbitrary cause', incompleteCoverage('raw workflow body with no markers')],
    ['source code paired with a normalization cause', incompleteCoverage('NODE_LIMIT', 'SOURCE', 'WORKFLOW_TOO_COMPLEX')],
    ['normalization too-large', incompleteCoverage(undefined, 'NORMALIZATION', 'WORKFLOW_TOO_LARGE')],
    ['source too-large with a cause', incompleteCoverage('SOURCE_WORK_LIMIT', 'SOURCE', 'WORKFLOW_TOO_LARGE')],
    ['normalization too-complex without a cause', incompleteCoverage(undefined, 'NORMALIZATION', 'WORKFLOW_TOO_COMPLEX')],
  ])('rejects a %s', (_label, coverage) => {
    expect(findingsFor(coverage).some((finding) => finding.rule === 'unknown-value')).toBe(true);
  });
});
