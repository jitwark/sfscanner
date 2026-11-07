import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { CROSS_MACHINE_POLICY, MAX_BOUND_LATENCY_MS, MICRO_LATENCY_BASELINE_THRESHOLD_MS, MICRO_LATENCY_FLOOR_MS, MICRO_LATENCY_HARD_CEILING_MS, P95_RATCHET, compareScannerV2Budget, latencyBudgetForBaselineP95 } from './compare-scanner-v2-budget.mjs';
import { MEASUREMENT_AGGREGATION_V2, validateBaselineV2Report } from './measure-scanner-v2.mjs';
import { preserveP95BudgetOverrides } from './scanner-v2-budget-baseline.mjs';

const digest = (letter) => letter.repeat(64);
const metric = (p50, p95, max = p95) => ({ p50, p95, max });
const caseFor = (overrides = {}) => ({
  key: 'safe-workflow:beta-default@2.0.0',
  id: 'safe-workflow',
  kind: 'valid',
  fixtureClass: 'safe',
  profile: { id: 'beta-default', version: '2.0.0' },
  inputSha256: digest('b'),
  outcome: 'SUCCESS',
  status: 'COMPLETE',
  failureCode: null,
  latencyMs: metric(10, 100, 110),
  rssBytes: metric(10, 20, 25),
  serializedBytes: metric(100, 120, 130),
  evidenceBytes: metric(20, 30, 35),
  redactedArtifactBytes: metric(100, 120, 130),
  ...overrides,
});
const report = (overrides = {}) => ({
  schemaVersion: 'scanner-baseline-v2',
  gate: 'scanner-v2-performance',
  claim: 'same-machine repeatability evidence; not cross-machine production performance',
  measurement: { warmups: 1, samples: 100, batches: 3, aggregation: MEASUREMENT_AGGREGATION_V2, clock: 'performance.now', rss: 'process.memoryUsage.rss', serialization: 'secureflow-canonical-json-v1' },
  environment: { node: 'v22.17.0', platform: 'win32', arch: 'x64', cpuCount: 16, digest: digest('d') },
  tool: { scannerVersion: 'scanner-beta-1', hash: 'sha256', scriptSha256: digest('e'), digest: digest('f') },
  fixtures: { source: 'packages/scanner-core/src/__fixtures__/v2-adapter-fixtures.ts', profile: { id: 'beta-default', version: '2.0.0' }, count: 1, order: ['safe-workflow:beta-default@2.0.0'], digest: digest('c') },
  byteCeilings: { maxSerializedResultBytes: 5000000, maxEvidenceBytes: 1536000, maxRedactedArtifactBytes: 1536000 },
  cases: [caseFor()],
  ...overrides,
});

describe('scanner v2 budget comparator', () => {

  it('applies the explicit micro-latency floor to a 10ms baseline', () => {
    const baseline = report({ cases: [caseFor({ latencyMs: metric(9, 10, 10) })] });
    const allowed = report({ cases: [caseFor({ latencyMs: metric(14, 15, 15) })] });
    const justOver = report({ cases: [caseFor({ latencyMs: metric(14, 15.001, 15.001) })] });
    const ceiling = report({ cases: [caseFor({ latencyMs: metric(20, 25, 25) })] });

    expect(compareScannerV2Budget(baseline, allowed)).toMatchObject({ ok: true, comparable: true, failures: [] });
    expect(compareScannerV2Budget(baseline, justOver)).toMatchObject({
      ok: false,
      failures: [expect.stringContaining('micro floor')],
    });
    expect(compareScannerV2Budget(baseline, ceiling)).toMatchObject({
      ok: false,
      failures: [expect.stringContaining('micro floor')],
    });
  });

  it('keeps the 25ms micro-latency ceiling hard when the floor budget exceeds it', () => {
    const baseline = report({ cases: [caseFor({ latencyMs: metric(20, 22, 22) })] });
    const current = report({ cases: [caseFor({ latencyMs: metric(24, 25.001, 25.001) })] });

    expect(compareScannerV2Budget(baseline, current)).toMatchObject({
      ok: false,
      failures: [expect.stringContaining('hard micro-latency ceiling')],
    });
  });

  it('allows a 15% p95 increase and rejects a 25% increase under the named tolerance', () => {
    const baseline = report();
    const withinTolerance = report({ cases: [caseFor({ latencyMs: metric(115, 115, 115) })] });
    const beyondTolerance = report({ cases: [caseFor({ latencyMs: metric(125, 125, 125) })] });

    expect(P95_RATCHET).toBe(1.2);
    expect(compareScannerV2Budget(baseline, withinTolerance)).toMatchObject({ ok: true, comparable: true, failures: [] });
    const rejected = compareScannerV2Budget(baseline, beyondTolerance);
    expect(rejected).toMatchObject({ ok: false, comparable: true, failures: [expect.stringContaining('p95')] });
    expect(rejected.failures[0]).toContain('120%');
  });

  it('exposes deterministic micro and proportional policy values', () => {
    expect({
      threshold: MICRO_LATENCY_BASELINE_THRESHOLD_MS,
      floor: MICRO_LATENCY_FLOOR_MS,
      ceiling: MICRO_LATENCY_HARD_CEILING_MS,
    }).toEqual({ threshold: 25, floor: 5, ceiling: 25 });
    expect(latencyBudgetForBaselineP95(10)).toEqual({ budgetMs: 15, policy: 'micro-floor' });
    expect(latencyBudgetForBaselineP95(25)).toEqual({ budgetMs: 30, policy: 'proportional' });
    expect(latencyBudgetForBaselineP95(100)).toEqual({ budgetMs: 120, policy: 'proportional' });
  });
  it('passes the 120% p95 latency ratchet on a matching environment', () => {
    const baseline = report();
    const current = report({ cases: [caseFor({ latencyMs: metric(11, 120, 121) })] });
    expect(compareScannerV2Budget(baseline, current)).toMatchObject({ ok: true, comparable: true, failures: [] });
  });

  it('fails a matching-environment p95 regression beyond 120%', () => {
    const baseline = report();
    const current = report({ cases: [caseFor({ latencyMs: metric(11, 121, 122) })] });
    expect(compareScannerV2Budget(baseline, current)).toMatchObject({ ok: false, comparable: true, failures: [expect.stringContaining('p95')] });
  });
  it('keeps process-wide RSS observational while enforcing the explicit byte ceilings', () => {
    const baseline = report();
    const current = report({ cases: [caseFor({ rssBytes: metric(10, 1000, 1000) })] });
    expect(compareScannerV2Budget(baseline, current)).toMatchObject({ ok: true, comparable: true, failures: [] });
  });

  it('does not false-pass a mismatched environment without an existing ADR', () => {
    const baseline = report();
    const current = report({ environment: { ...baseline.environment, digest: digest('a') } });
    expect(compareScannerV2Budget(baseline, current)).toMatchObject({ ok: false, comparable: false, p95Comparable: false, waived: false, failures: [expect.stringContaining('environment')] });
  });

  it('exposes the named cross-machine ADR policy used by CI', () => {
    expect(CROSS_MACHINE_POLICY).toMatchObject({
      adrPath: 'docs/decisions/scanner-v2-performance-budget.md',
      adrJustification: expect.stringContaining('not comparable'),
    });
  });

  it('allows a mismatched environment only through the named ADR policy', () => {
    const baseline = report();
    const current = report({ environment: { ...baseline.environment, digest: digest('a') }, cases: [caseFor({ latencyMs: metric(10, 10000, 10000) })] });
    const result = compareScannerV2Budget(baseline, current, {
      ...CROSS_MACHINE_POLICY,
      root: new URL('..', import.meta.url),
    });
    expect(result).toMatchObject({ ok: true, comparable: false, waived: true, failures: [] });
  });

  it('reports the p95 dimension as not comparable under the cross-machine policy even on a matching environment', () => {
    const baseline = report();
    const withinOldBudget = report({ cases: [caseFor({ latencyMs: metric(10, 115, 116) })] });
    const farOverBudget = report({ cases: [caseFor({ latencyMs: metric(10, 10000, 10000) })] });
    const options = { ...CROSS_MACHINE_POLICY, root: new URL('..', import.meta.url) };

    const within = compareScannerV2Budget(baseline, withinOldBudget, options);
    expect(within).toMatchObject({ ok: true, comparable: true, p95Comparable: false, waived: false, failures: [] });
    // 10000ms is 100x the baseline p95 and would fail the strict 120% ratchet; the named policy
    // does not compare p95 at all, so it cannot fail the gate on that dimension.
    expect(compareScannerV2Budget(baseline, farOverBudget, options)).toMatchObject({
      ok: true,
      comparable: true,
      p95Comparable: false,
      failures: [],
    });
  });

  it('fails closed on a matching environment without the named policy', () => {
    const baseline = report();
    const farOverBudget = report({ cases: [caseFor({ latencyMs: metric(10, 10000, 10000) })] });
    expect(compareScannerV2Budget(baseline, farOverBudget)).toMatchObject({
      ok: false,
      comparable: true,
      p95Comparable: true,
      failures: [expect.stringContaining('p95')],
    });
  });

  it('keeps byte ceilings strict on a matching environment under the named cross-machine policy', () => {
    const baseline = report();
    const current = report({
      cases: [caseFor({
        latencyMs: metric(10, 10000, 10001),
        serializedBytes: metric(100, 120, 5000001),
        evidenceBytes: metric(20, 30, 1536001),
        redactedArtifactBytes: metric(100, 120, 1536001),
      })],
    });
    const result = compareScannerV2Budget(baseline, current, {
      ...CROSS_MACHINE_POLICY,
      root: new URL('..', import.meta.url),
    });
    expect(result).toMatchObject({ ok: false, comparable: true, p95Comparable: false });
    // Exactly the three ceiling failures: the 10000ms p95 above is 100x the baseline and adds nothing.
    expect(result.failures).toEqual([
      'safe-workflow:beta-default@2.0.0 serialized bytes 5000001 exceed ceiling 5000000',
      'safe-workflow:beta-default@2.0.0 evidence bytes 1536001 exceed ceiling 1536000',
      'safe-workflow:beta-default@2.0.0 redacted artifact (aliases the serialized size; redaction-v2 is unwired) bytes 1536001 exceed ceiling 1536000',
    ]);
  });

  it('keeps the max-bound deadline strict on a matching environment under the named cross-machine policy', () => {
    const baseline = report({ cases: [caseFor({ fixtureClass: 'max-bound' })] });
    const current = report({ cases: [caseFor({ fixtureClass: 'max-bound', latencyMs: metric(10, 10000, 5001) })] });
    const result = compareScannerV2Budget(baseline, current, {
      ...CROSS_MACHINE_POLICY,
      root: new URL('..', import.meta.url),
    });
    expect(result).toMatchObject({ ok: false, comparable: true, p95Comparable: false });
    expect(result.failures).toEqual(['safe-workflow:beta-default@2.0.0 max-bound latency 5001ms exceeds 5,000ms']);
  });

  it('bounds the max-bound admission path with the gate literal, not the worker deadline', () => {
    // D4 raised workerDeadlineMs from 5,000 ms to 30,000 ms (contracts/limits.ts). The max-bound
    // bound is a separate, unchanged 5,000 ms literal in both this comparator and the harness that
    // measures the fixtures. Re-deriving it from the limits contract would silently widen the gate
    // to the deadline, so the two numbers are pinned apart here.
    expect(MAX_BOUND_LATENCY_MS).toBe(5000);
    expect(DEFAULT_SCANNER_LIMITS_V2.workerDeadlineMs).toBe(30000);
    expect(MAX_BOUND_LATENCY_MS).toBeLessThan(DEFAULT_SCANNER_LIMITS_V2.workerDeadlineMs);

    // 9,000 ms sits between the two: inside the worker deadline, outside the gate bound. Its p95 is
    // inside the ratchet budget, so the max-bound bound is the only check that can refuse it.
    const baseline = report({ cases: [caseFor({ fixtureClass: 'max-bound' })] });
    const current = report({ cases: [caseFor({ fixtureClass: 'max-bound', latencyMs: metric(10, 100, 9000) })] });
    const result = compareScannerV2Budget(baseline, current);
    expect(result).toMatchObject({ ok: false });
    expect(result.failures).toEqual([expect.stringContaining('max-bound latency 9000ms')]);

    const harness = readFileSync(new URL('./measure-scanner-v2.mjs', import.meta.url), 'utf8');
    const block = /if \(fixture\.fixtureClass === 'max-bound'\) \{[\s\S]*?MAX_BOUND_INVALID_OUTCOME/.exec(harness)?.[0] ?? '';
    expect(block).toMatch(/elapsed > 5_000/);
    expect(block).not.toContain('workerDeadlineMs');
  });

  it('rejects baseline and current measurement policy mismatches', () => {
    const baseline = report();
    const current = report({ measurement: { ...baseline.measurement, batches: 1 } });
    expect(compareScannerV2Budget(baseline, current)).toMatchObject({
      ok: false,
      failures: [expect.stringContaining('measurement policy')],
    });
  });


  it('keeps hard ceilings and max-bound deadline strict under the ADR policy', () => {
    const baseline = report();
    const current = report({
      environment: { ...baseline.environment, digest: digest('a') },
      cases: [caseFor({
        fixtureClass: 'max-bound',
        latencyMs: metric(10, 100, 5001),
        serializedBytes: metric(100, 100, 5000001),
        evidenceBytes: metric(20, 20, 1536001),
        redactedArtifactBytes: metric(100, 100, 1536001),
      })],
    });
    const result = compareScannerV2Budget(baseline, current, {
      ...CROSS_MACHINE_POLICY,
      root: new URL('..', import.meta.url),
    });
    expect(result.ok).toBe(false);
    expect(result.comparable).toBe(false);
    expect(result.waived).toBe(true);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('5,000'),
      expect.stringContaining('serialized'),
      expect.stringContaining('evidence'),
      expect.stringContaining('redacted'),
    ]));
  });


  it('rejects byte ceilings and max-bound latency violations without bypasses', () => {
    const baseline = report();
    const current = report({ cases: [caseFor({ fixtureClass: 'max-bound', latencyMs: metric(10, 100, 5001), serializedBytes: metric(100, 100, 5000001), evidenceBytes: metric(20, 20, 1536001), redactedArtifactBytes: metric(100, 100, 1536001) })] });
    const result = compareScannerV2Budget(baseline, current);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('5,000'),
      expect.stringContaining('serialized'),
      expect.stringContaining('evidence'),
      expect.stringContaining('redacted'),
    ]));
  });

  it('rejects malformed report numbers before comparing budgets', () => {
    const malformed = report({ cases: [caseFor({ rssBytes: metric(10, Number.NaN, 12) })] });
    expect(compareScannerV2Budget(report(), malformed)).toMatchObject({ ok: false, failures: [expect.stringContaining('schema')] });
  });

  it('rejects a changed fixture input digest under the named cross-machine waiver', () => {
    const baseline = report();
    const current = report({
      environment: { ...baseline.environment, digest: digest('a') },
      cases: [caseFor({ inputSha256: digest('a') })],
    });
    const result = compareScannerV2Budget(baseline, current, {
      ...CROSS_MACHINE_POLICY,
      root: new URL('..', import.meta.url),
    });

    expect(result).toMatchObject({ ok: false, comparable: false, p95Comparable: false, waived: true });
    expect(result.failures).toEqual(['safe-workflow:beta-default@2.0.0 fixture identity differs from the pinned baseline']);
  });

  it('rejects a changed max-bound classification under the named cross-machine waiver', () => {
    const baseline = report({ cases: [caseFor({ fixtureClass: 'max-bound' })] });
    const current = report({
      environment: { ...baseline.environment, digest: digest('a') },
      cases: [caseFor({ fixtureClass: 'safe', latencyMs: metric(10, 100, 9000) })],
    });
    const result = compareScannerV2Budget(baseline, current, {
      ...CROSS_MACHINE_POLICY,
      root: new URL('..', import.meta.url),
    });

    expect(result).toMatchObject({ ok: false, waived: true });
    expect(result.failures).toEqual([expect.stringContaining('fixture identity differs')]);
  });
  it('compares against an owner-set p95 budget baseline without changing the measured summary', () => {
    const key = 'max-bound-exceeded-workflow:beta-default@2.0.0';
    const fixtures = { ...report().fixtures, order: [key] };
    const identity = {
      key,
      id: 'max-bound-exceeded-workflow',
      kind: 'rejected',
      fixtureClass: 'max-bound',
      outcome: 'FAILURE',
      status: null,
      failureCode: 'WORKFLOW_TOO_COMPLEX',
    };
    const baselineCase = caseFor({
      ...identity,
      latencyMs: metric(328.0074, 358.80603, 448.94689999999537),
      budgetBaselineP95Ms: 475,
    });
    const currentCase = caseFor({
      ...identity,
      latencyMs: metric(450, 474.46662, 1030.3256),
    });
    const baseline = report({ fixtures, cases: [baselineCase] });
    const current = report({ fixtures, cases: [currentCase] });

    expect(baselineCase.latencyMs.p95).toBe(358.80603);
    expect(latencyBudgetForBaselineP95(baselineCase.budgetBaselineP95Ms).budgetMs).toBe(570);
    expect(compareScannerV2Budget(baseline, current)).toMatchObject({
      ok: true,
      comparable: true,
      failures: [],
    });
  });

  it('rejects a malformed p95 budget baseline override', () => {
    const invalid = report({
      cases: [caseFor({ budgetBaselineP95Ms: '475' })],
    });

    expect(validateBaselineV2Report(invalid)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'safe-workflow:beta-default@2.0.0 budgetBaselineP95Ms must be a positive finite number',
      ]),
    });
  });

  it('preserves owner-set p95 budget baselines only for matching environment and fixture input', () => {
    const previous = report({
      cases: [caseFor({ budgetBaselineP95Ms: 475 })],
    });
    const measured = report({
      cases: [caseFor({ latencyMs: metric(12, 13, 15) })],
    });
    const differentEnvironment = report({
      environment: { ...measured.environment, digest: digest('a') },
      cases: [caseFor({ latencyMs: metric(12, 13, 15) })],
    });
    const differentInput = report({
      cases: [caseFor({ inputSha256: digest('g'), latencyMs: metric(12, 13, 15) })],
    });

    expect(preserveP95BudgetOverrides(measured, previous).cases[0]).toMatchObject({
      latencyMs: metric(12, 13, 15),
      budgetBaselineP95Ms: 475,
    });
    expect(preserveP95BudgetOverrides(differentEnvironment, previous).cases[0]).not.toHaveProperty('budgetBaselineP95Ms');
    expect(preserveP95BudgetOverrides(differentInput, previous).cases[0]).not.toHaveProperty('budgetBaselineP95Ms');
  });

});
