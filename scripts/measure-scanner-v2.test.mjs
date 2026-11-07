import { describe, expect, it } from 'vitest';
import {
  BASELINE_V2_SCHEMA_VERSION,
  MEASUREMENT_AGGREGATION_V2,
  MEASUREMENT_DEFAULTS_V2,
  aggregateBatchP95,
  buildBaselineV2Report,
  BASELINE_V2_PATH,
  fixtureKey,
  isPinnedBaselinePath,
  parseMeasurementArgs,
  percentile,
  validateBaselineV2Report,
} from './measure-scanner-v2.mjs';
import { dirname, join } from 'node:path';

const digest = (letter) => letter.repeat(64);
const metric = (value = 1) => ({ p50: value, p95: value + 1, max: value + 2 });
const validCase = (key = 'safe-workflow:beta-default@2.0.0') => ({
  key,
  id: key.split(':')[0],
  kind: 'valid',
  fixtureClass: 'safe',
  profile: { id: 'beta-default', version: '2.0.0' },
  inputSha256: digest('b'),
  outcome: 'SUCCESS',
  status: 'COMPLETE',
  failureCode: null,
  latencyMs: metric(),
  rssBytes: metric(10),
  serializedBytes: metric(100),
  evidenceBytes: metric(20),
  redactedArtifactBytes: metric(100),
});

const validReport = {
  schemaVersion: BASELINE_V2_SCHEMA_VERSION,
  gate: 'scanner-v2-performance',
  claim: 'same-machine repeatability evidence; not cross-machine production performance',
  measurement: { warmups: 1, samples: 100, batches: 3, aggregation: MEASUREMENT_AGGREGATION_V2, clock: 'performance.now', rss: 'process.memoryUsage.rss', serialization: 'secureflow-canonical-json-v1' },
  environment: { node: 'v22.17.0', platform: 'win32', arch: 'x64', cpuCount: 16, digest: digest('d') },
  tool: { scannerVersion: 'scanner-beta-1', hash: 'sha256', scriptSha256: digest('e'), digest: digest('f') },
  fixtures: {
    source: 'packages/scanner-core/src/__fixtures__/v2-adapter-fixtures.ts',
    profile: { id: 'beta-default', version: '2.0.0' },
    count: 1,
    order: ['safe-workflow:beta-default@2.0.0'],
    digest: digest('c'),
  },
  byteCeilings: { maxSerializedResultBytes: 5000000, maxEvidenceBytes: 1536000, maxRedactedArtifactBytes: 1536000 },
  cases: [validCase()],
};

describe('scanner v2 measurement contract', () => {
  it('sorts numeric samples before deterministic interpolation', () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(percentile([4, 1, 3, 2], 0.95)).toBe(3.85);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 1)).toBe(3);
  });

  it('uses the median of deterministic per-batch p95 values', () => {
    expect(aggregateBatchP95([12.345678, 10.123456, 11.234567])).toBe(11.234567);
    expect(aggregateBatchP95([11, 9, 13])).toBe(11);
  });

  it('rejects malformed batch metadata', () => {
    const broken = { ...validReport, measurement: { ...validReport.measurement, batches: 0 } };
    expect(validateBaselineV2Report(broken)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('measurement metadata')],
    });
  });

  it('rejects an unknown aggregation policy', () => {
    const broken = { ...validReport, measurement: { ...validReport.measurement, aggregation: 'single-run-p95' } };
    expect(validateBaselineV2Report(broken)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('measurement metadata')],
    });
  });



  it('uses a profile-qualified fixture key and validates the complete schema', () => {
    expect(fixtureKey({ id: 'safe-workflow', profile: { id: 'beta-default', version: '2.0.0' } })).toBe('safe-workflow:beta-default@2.0.0');
    expect(validateBaselineV2Report(validReport)).toEqual({ ok: true, errors: [] });
  });

  it('rejects reordered cases and non-finite metric summaries', () => {
    const broken = {
      ...validReport,
      fixtures: { ...validReport.fixtures, order: ['other:beta-default@2.0.0'] },
      cases: [{ ...validCase(), latencyMs: { p50: 1, p95: Number.NaN, max: 3 } }],
    };
    expect(validateBaselineV2Report(broken)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'fixture order does not match case order',
        'safe-workflow:beta-default@2.0.0.latencyMs summary is malformed',
      ]),
    });
  });
  it('rejects outcome and status combinations that do not describe a closed result', () => {
    const broken = { ...validReport, cases: [{ ...validCase(), outcome: 'FAILURE', status: 'COMPLETE', failureCode: null }] };
    expect(validateBaselineV2Report(broken)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('outcome or status')]),
    });
  });

  it('orders fixture identities deterministically without locale-dependent sorting', async () => {
    const fixtures = [
      { id: 'z-workflow', profile: { id: 'beta-default', version: '2.0.0' } },
      { id: 'a-workflow', profile: { id: 'beta-default', version: '2.0.0' } },
    ];
    expect((await import('./measure-scanner-v2.mjs')).orderFixtures(fixtures).map((item) => item.id)).toEqual(['a-workflow', 'z-workflow']);
  });

  it('supports a smaller explicit one-batch fixture build without changing defaults', async () => {
    const report = await buildBaselineV2Report({ samples: 5, warmups: 1, batches: 1 });
    expect(report.measurement).toMatchObject({ samples: 5, warmups: 1, batches: 1, aggregation: MEASUREMENT_AGGREGATION_V2 });
    expect(validateBaselineV2Report(report)).toEqual({ ok: true, errors: [] });
  }, 180_000);

  it('defaults to three batches of one hundred measured samples with one warmup and validates regenerated metadata', async () => {
    expect(MEASUREMENT_DEFAULTS_V2).toEqual({ samples: 100, warmups: 1, batches: 3, aggregation: MEASUREMENT_AGGREGATION_V2 });
    // The production triple above is pinned declaratively, and the full-size build it describes is the
    // measurement script's own job: `npm run measure:scanner-v2` builds it and validates the result in
    // `main()`. Rebuilding it here cost 100 samples x 3 batches x 10 fixtures, which held a worker for
    // minutes and looked like a stalled suite. Validate the regenerated metadata at the smallest
    // parameter set the validator accepts (warmups >= 1, samples >= 5) instead.
    const report = await buildBaselineV2Report({ samples: 5, warmups: 1, batches: 1 });
    expect(report.measurement).toMatchObject({ samples: 5, warmups: 1, batches: 1, aggregation: MEASUREMENT_AGGREGATION_V2 });
    expect(report.measurement.clock).toBe('performance.now');
    expect(report.measurement.rss).toBe('process.memoryUsage.rss');
    expect(report.measurement.serialization).toBe('secureflow-canonical-json-v1');
    expect(report.environment.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.tool.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.tool.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.fixtures.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(validateBaselineV2Report(report)).toEqual({ ok: true, errors: [] });
    expect(report.cases.length).toBeGreaterThanOrEqual(7);
    expect(report.cases.every((item) => item.key.includes('@2.0.0'))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('sk_live_adapter_fixture_secret_123');
  }, 180_000);

  it('accepts retained per-batch samples that reproduce the observed case summary and rejects mismatches', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    const batch = (values) => ({
      latencyMs: { samples: values, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) },
      rssBytes: metric(10),
      serializedBytes: metric(100),
      evidenceBytes: metric(20),
      redactedArtifactBytes: metric(100),
    });
    const consistent = batch(samples);
    const key = 'safe-workflow:beta-default@2.0.0';
    const observed = {
      ...validCase(),
      latencyMs: { p50: percentile(samples, 0.5), p95: aggregateBatchP95([consistent.latencyMs.p95, consistent.latencyMs.p95, consistent.latencyMs.p95]), max: consistent.latencyMs.max },
    };
    const report = (caseItem, retainedBatch, count = 3) => ({
      ...validReport,
      cases: [caseItem],
      retainedSamples: { [key]: { batches: Array.from({ length: count }, () => retainedBatch) } },
    });
    expect(validateBaselineV2Report(report(observed, consistent))).toEqual({ ok: true, errors: [] });

    const badBatch = { ...consistent, latencyMs: { ...consistent.latencyMs, p95: consistent.latencyMs.p95 + 1 } };
    const badCase = { ...observed, latencyMs: { ...observed.latencyMs, p95: observed.latencyMs.p95 + 1 } };
    const shortSamples = { ...consistent, latencyMs: { samples: samples.slice(0, 99), ...metric() } };
    for (const [label, broken] of [
      ['batch summary disagrees with its own series', report(observed, badBatch)],
      ['case p95 is not reproducible from the batch p95 values', report(badCase, consistent)],
      ['batch summary is not bound to its series', report(observed, shortSamples, 3)],
      ['a declared batch is missing', report(observed, consistent, 1)],
    ]) {
      expect(validateBaselineV2Report(broken), label).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([expect.stringContaining(`${key} retained samples`)]),
      });
    }
  });

  it('rejects a retained record whose declared policy has zero samples or zero batches without throwing', () => {
    const key = 'safe-workflow:beta-default@2.0.0';
    const emptyBatch = () => ({ latencyMs: { samples: [], p50: 0, p95: 0, max: 0 }, rssBytes: metric(10), serializedBytes: metric(100), evidenceBytes: metric(20), redactedArtifactBytes: metric(100) });
    const cases = [
      ['zero batches', { ...validReport, measurement: { ...validReport.measurement, batches: 0, samples: 0 }, retainedSamples: { [key]: { batches: [] } } }],
      ['zero samples', { ...validReport, measurement: { ...validReport.measurement, samples: 0 }, retainedSamples: { [key]: { batches: [emptyBatch(), emptyBatch(), emptyBatch()] } } }],
    ];
    for (const [label, broken] of cases) {
      const capture = () => validateBaselineV2Report(broken);
      expect(capture, label).not.toThrow();
      expect(capture(), label).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([expect.stringContaining('measurement metadata'), expect.stringContaining(`${key} retained samples`)]),
      });
    }
  });

  it('refuses every alias that identifies the pinned baseline path', () => {
    const aliases = [
      'docs/scanner/baseline-v2.json',
      './docs/scanner/baseline-v2.json',
      'docs/scanner/./baseline-v2.json',
      'docs/scanner/x/../baseline-v2.json',
      'docs/SCANNER/BASELINE-V2.JSON',
      'docs/scanner/baseline-v2.json.',
      'docs/scanner/baseline-v2.json ',
      'docs\\scanner\\baseline-v2.json',
      'docs\\scanner\\.\\baseline-v2.json',
      BASELINE_V2_PATH,
    ];
    for (const alias of aliases) expect(() => parseMeasurementArgs(['--record', alias]), alias).toThrow(/pinned baseline/);
    expect(isPinnedBaselinePath(undefined)).toBe(true);
    expect(isPinnedBaselinePath('')).toBe(true);
    expect(isPinnedBaselinePath(join(dirname(dirname(BASELINE_V2_PATH)), 'other', 'baseline-v2.json'))).toBe(false);
    expect(isPinnedBaselinePath(`${BASELINE_V2_PATH}.bak`)).toBe(false);
    const studyPath = '.superpowers/sdd/task-2.5-runs/launch-1.json';
    expect(isPinnedBaselinePath(studyPath)).toBe(false);
    expect(parseMeasurementArgs(['--record', studyPath])).toMatchObject({ recordPath: studyPath });
  });

  it('refuses to combine the pinned baseline write with a retained-sample record', () => {
    expect(parseMeasurementArgs(['--record', 'run.json'])).toMatchObject({ write: false, recordPath: 'run.json' });
    expect(parseMeasurementArgs(['--samples', '5'])).toMatchObject({ write: false, recordPath: undefined, samples: 5 });
    expect(() => parseMeasurementArgs(['--write', '--record', 'run.json'])).toThrow(/mutually exclusive/);
    expect(() => parseMeasurementArgs(['--record'])).toThrow(/missing value for --record/);
  });

  it('retains per-call latency and per-batch p95/max only when a record is requested', async () => {
    const plain = await buildBaselineV2Report({ samples: 5, warmups: 1, batches: 1 });
    expect(plain.retainedSamples).toBeUndefined();

    const recorded = await buildBaselineV2Report({ samples: 5, warmups: 1, batches: 1, retainSamples: true });
    expect(validateBaselineV2Report(recorded)).toEqual({ ok: true, errors: [] });
    expect(Object.keys(recorded.retainedSamples)).toEqual(recorded.cases.map((item) => item.key));
    for (const item of recorded.cases) {
      const [batch] = recorded.retainedSamples[item.key].batches;
      expect(batch.latencyMs.samples).toHaveLength(5);
      expect(batch.latencyMs.samples.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
      expect(batch.latencyMs.p50).toBe(percentile(batch.latencyMs.samples, 0.5));
      expect(batch.latencyMs.p95).toBe(percentile(batch.latencyMs.samples, 0.95));
      expect(batch.latencyMs.max).toBe(Math.max(...batch.latencyMs.samples));
      expect(item.latencyMs.p95).toBe(batch.latencyMs.p95);
      expect(item.latencyMs.max).toBe(batch.latencyMs.max);
      expect(item.serializedBytes.max).toBe(batch.serializedBytes.max);
      expect(item.evidenceBytes.max).toBe(batch.evidenceBytes.max);
    }
  }, 180_000);
});
