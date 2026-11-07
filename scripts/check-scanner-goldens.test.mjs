import { describe, expect, it } from 'vitest';
import { scannerParityFixtures } from '../app/src/scanner/__fixtures__/scanner-parity.js';
import {
  GOLDEN_ENTRIES,
  canonicalSha256,
  projectBrowserEntrySecurity,
  runGoldenGate,
} from './check-scanner-goldens.mjs';

const fixture = { id: 'synthetic-safe', kind: 'valid', json: '{"nodes":[],"connections":{}}' };
const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

function browserResult(profile, score = 1) {
  return {
    schemaVersion: 'scanner-result-v1', scannerVersion: 'scanner-beta-1', policyProfile: profile,
    analysisStatus: 'COMPLETE', analysisDiagnostics: [], findings: [],
    riskAssessment: { grade: 'A', score }, summary: counts,
  };
}

function cliResult(result) {
  return { exitCode: 0, stderr: '', stdout: JSON.stringify({ results: [{ input: '-', ok: true, result }] }) };
}

function adapters(overrides = {}) {
  const scanBrowser = async (_fixture, profile) => browserResult(profile);
  return {
    scanBrowser,
    scanCli: async (_fixture, profile) => cliResult(await scanBrowser(_fixture, profile)),
    scanPipeline: async (_fixture) => projectBrowserEntrySecurity(browserResult('beta-default'), browserResult('beta-hardened')),
    ...overrides,
  };
}

function goldens(overrides = {}) {
  const browser = browserResult('beta-default');
  const hardened = browserResult('beta-hardened');
  return [
    { fixtureId: fixture.id, kind: 'browser', profile: 'beta-default', sha256: canonicalSha256(browser) },
    { fixtureId: fixture.id, kind: 'browser', profile: 'beta-hardened', sha256: canonicalSha256(hardened) },
    { fixtureId: fixture.id, kind: 'pipeline', profile: 'beta-default', sha256: canonicalSha256(projectBrowserEntrySecurity(browser, hardened)) },
  ].map((entry) => ({ ...entry, ...overrides[`${entry.kind}:${entry.profile}`] }));
}

describe('scanner release golden gate', () => {
  it('accepts fake browser, pipeline, and CLI outputs with matching goldens', async () => {
    const result = await runGoldenGate({ fixtures: [fixture], goldens: goldens(), ...adapters() });
    expect(result).toMatchObject({ ok: true, validFixtures: 1, goldenChecks: 3, errors: [] });
  });

  it('fails closed when a browser golden hash drifts', async () => {
    const result = await runGoldenGate({ fixtures: [fixture], goldens: goldens({ 'browser:beta-default': { sha256: '0'.repeat(64) } }), ...adapters() });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('synthetic-safe browser beta-default golden hash drift');
  });

  it('fails closed when one required golden is missing', async () => {
    const result = await runGoldenGate({ fixtures: [fixture], goldens: goldens().slice(0, 2), ...adapters() });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing golden: synthetic-safe:pipeline:beta-default');
  });

  it('fails closed for malformed or accepted rejected fixtures', async () => {
    const rejected = { id: 'synthetic-malformed', kind: 'rejected', json: '{"nodes":[', rejectionCode: 'INVALID_JSON' };
    const result = await runGoldenGate({
      fixtures: [fixture, rejected], goldens: goldens(),
      ...adapters({
        parse: () => ({ ok: true, workflow: {} }),
        scanCli: async () => cliResult(browserResult('beta-default')),
        scanPipeline: async () => projectBrowserEntrySecurity(browserResult('beta-default'), browserResult('beta-hardened')),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'synthetic-malformed parser accepted a declared rejected fixture',
      'synthetic-malformed [beta-default] CLI did not return one input rejection',
      'synthetic-malformed pipeline rejection did not fail closed',
    ]));
  });

  it('smokes a real public safe parity fixture against the checked-in goldens', async () => {
    const safeEntries = GOLDEN_ENTRIES.filter((entry) => entry.fixtureId === 'safe');
    const result = await runGoldenGate({ fixtures: [scannerParityFixtures.find((item) => item.id === 'safe')], goldens: safeEntries });
    expect(result).toMatchObject({ ok: true, validFixtures: 1, goldenChecks: 3, errors: [] });
  });
});
