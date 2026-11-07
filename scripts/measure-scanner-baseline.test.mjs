import { describe, expect, it } from 'vitest';
import {
  BASELINE_SCHEMA_VERSION,
  buildBaselineReport,
  fixtureKey,
  percentile,
  validateBaselineReport,
} from './measure-scanner-baseline.mjs';

const validCase = (key = 'safe:beta-default') => ({
  key,
  id: key.split(':')[0],
  profile: key.split(':')[1],
  expectedDigest: 'a'.repeat(64),
  inputSha256: 'b'.repeat(64),
  dimensions: {
    inputBytes: 10,
    nodes: 1,
    rawEdges: { value: null, reason: 'native v1 does not retain rejected edges' },
    acceptedEdges: 0,
    codeIndicators: 0,
    codeAstNodes: { value: null, reason: 'AST count is not exposed by native v1' },
    taintStates: { value: null, reason: 'taint state count is not exposed by native v1' },
  },
  latencyMs: { p50: 1, p95: 2, max: 3 },
  rssBytes: { p50: 10, p95: 11, max: 12 },
});

const validReport = {
  schemaVersion: BASELINE_SCHEMA_VERSION,
  gate: 'scanner-baseline',
  claim: 'same-machine repeatability evidence; not cross-machine production performance',
  measurement: { warmups: 1, samples: 3, clock: 'performance.now', rss: 'process.memoryUsage.rss' },
  environment: { node: 'v22', platform: 'win32', arch: 'x64', digest: 'd'.repeat(64) },
  tool: { scannerVersion: 'scanner-beta-1', canonicalization: 'hub-canonical-json-v1', hash: 'sha256', digest: 'e'.repeat(64) },
  fixtures: { source: 'packages/scanner-core/src/__fixtures__/v1-goldens.ts', count: 1, order: ['safe:beta-default'], digest: 'c'.repeat(64) },
  cases: [validCase()],
};

describe('scanner baseline contract', () => {
  it('uses an explicit profile-qualified fixture key and deterministic percentiles', () => {
    expect(fixtureKey({ id: 'safe', profile: 'beta-hardened' })).toBe('safe:beta-hardened');
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(3.85);
  });

  it('accepts the baseline schema with explicit unavailable dimensions', () => {
    expect(validateBaselineReport(validReport)).toEqual({ ok: true, errors: [] });
  });

  it('rejects reordered cases and unavailable dimensions without a reason', () => {
    const base = validCase();
    const broken = {
      ...validReport,
      fixtures: { ...validReport.fixtures, order: ['safe:beta-hardened'] },
      cases: [{ ...base, dimensions: { ...base.dimensions, rawEdges: { value: null } } }],
    };
    expect(validateBaselineReport(broken)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'fixture order does not match case order',
        'safe:beta-default.rawEdges must explain an unavailable value',
      ]),
    });
  });

  it('never writes raw workflow JSON into the baseline report', async () => {
    const report = await buildBaselineReport({ samples: 1, warmups: 0 });
    expect(report.cases).toHaveLength(6);
    expect(report.cases.every((item) => !Object.hasOwn(item, 'json'))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('sk_live_parity_fixture_secret');
  });
});
