import { describe, expect, it, vi } from 'vitest';
import { canonicalJsonBytes } from '@hub/scanner-core/canonical-json';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import { V2_ADAPTER_FIXTURE_MATRIX, V2_ADAPTER_PROFILE } from '../packages/scanner-core/src/__fixtures__/v2-adapter-fixtures.ts';
import { compareRawResults, runParityGate } from './check-scanner-v2-parity.mjs';

const encoder = new TextEncoder();
const bytes = (fixture) => encoder.encode(fixture.json);
const success = (result) => ({ ok: true, result });
const failure = (code) => ({ ok: false, code, message: 'closed failure' });

function fixture(id) {
  const found = V2_ADAPTER_FIXTURE_MATRIX.find((item) => item.id === id);
  if (!found) throw new Error(`missing fixture ${id}`);
  return found;
}

describe('scanner v2 cross-adapter parity', () => {
  it('declares every required fixture class and closed failure code', () => {
    const classes = new Set(V2_ADAPTER_FIXTURE_MATRIX.map(({ fixtureClass }) => fixtureClass));
    expect(classes).toEqual(new Set([
      'safe', 'risky', 'indeterminate', 'malformed', 'oversized', 'unicode-bom', 'duplicate', 'ambiguous', 'max-bound',
    ]));
    expect(V2_ADAPTER_FIXTURE_MATRIX.filter(({ kind }) => kind === 'valid').length).toBeGreaterThanOrEqual(6);
    expect(V2_ADAPTER_FIXTURE_MATRIX.filter(({ kind }) => kind === 'rejected').length).toBeGreaterThanOrEqual(3);
    expect(V2_ADAPTER_FIXTURE_MATRIX.filter(({ kind }) => kind === 'rejected').map(({ rejectionCode }) => rejectionCode)).toEqual([
      'INVALID_JSON', 'WORKFLOW_TOO_LARGE', 'WORKFLOW_TOO_COMPLEX',
    ]);
  });

  it('fails closed when one adapter raw bytes are deliberately perturbed', async () => {
    const source = fixture('safe-workflow');
    const scanned = scanWorkflowV2({ bytes: bytes(source), profile: V2_ADAPTER_PROFILE });
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    const core = success(scanned.result);
    const perturbed = success({ ...scanned.result, input: { ...scanned.result.input, rawSha256: 'b'.repeat(64) } });
    const compared = compareRawResults(source, {
      core,
      browser: core,
      pipeline: core,
      package: perturbed,
    });
    expect(compared.ok).toBe(false);
    expect(compared.errors).toEqual(['safe-workflow [beta-default] package raw input digest is not byte-faithful.', 'safe-workflow [beta-default] package raw bytes differ from core truth.', 'safe-workflow [beta-default] package raw SHA-256 differs from core truth.']);
  });

  it('fails closed when an adapter output contains the fixture secret token', () => {
    const source = fixture('risky-workflow');
    const scanned = scanWorkflowV2({ bytes: bytes(source), profile: V2_ADAPTER_PROFILE });
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    const leakedIndex = scanned.result.facts.findIndex((fact) => fact.subject.node && fact.subject.node.source);
    if (leakedIndex === -1) throw new Error('Expected a node-subject fact carrying a source to perturb');
    const leaked = {
      ...scanned.result,
      facts: scanned.result.facts.map((fact, index) => index === leakedIndex
        ? {
            ...fact,
            subject: {
              ...fact.subject,
              node: {
                ...fact.subject.node,
                source: { ...fact.subject.node.source, pointer: '/sk_live_adapter_fixture_secret_123' },
              },
            },
          }
        : fact),
    };
    const compared = compareRawResults(source, {
      core: success(scanned.result),
      browser: success(scanned.result),
      pipeline: success(leaked),
      package: success(scanned.result),
    });
    expect(compared.ok).toBe(false);
    expect(compared.errors).toContain('risky-workflow [beta-default] pipeline output contains fixture secret-like text.');
    expect(JSON.stringify(compared)).not.toContain('sk_live_adapter_fixture_secret_123');
  });

  it('compares rejected adapters by code without exposing input or exception text', () => {
    const source = fixture('malformed-workflow');
    const observations = {
      core: failure('INVALID_JSON'),
      browser: failure('INVALID_JSON'),
      pipeline: failure('INVALID_JSON'),
      package: failure('INVALID_JSON'),
    };
    expect(compareRawResults(source, observations)).toEqual({ ok: true, errors: [] });
    expect(JSON.stringify(compareRawResults(source, observations))).not.toContain(source.json);
  });

  it('keeps canonical bytes and SHA-256 stable through key reconstruction and repeated runs', () => {
    const source = fixture('unicode-bom-workflow');
    const scanned = scanWorkflowV2({ bytes: bytes(source), profile: V2_ADAPTER_PROFILE });
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    const raw = scanned.result;
    const repeated = scanWorkflowV2({ bytes: bytes(source), profile: V2_ADAPTER_PROFILE });
    expect(repeated.ok).toBe(true);
    if (repeated.ok) expect(canonicalJsonBytes(repeated.result)).toEqual(canonicalJsonBytes(raw));
    const first = JSON.parse(JSON.stringify(raw));
    const second = Object.fromEntries(Object.entries(raw).reverse());
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));
    expect(compareRawResults(source, { core: success(raw), browser: success(first), pipeline: success(second), package: success(raw) }).ok).toBe(true);
  });

  it('runs the four real adapters over the frozen fixture matrix and stays byte-identical', async () => {
    // This is the path the wired `check:scanner-v2-parity` gate runs. The injected
    // adapters elsewhere in this file only exercise the comparator, so without this
    // test the real Worker, pipeline and package adapters had no automatic
    // byte-identity proof — only the manual script run (task-5.2-report.md finding 4).
    const report = await runParityGate();

    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.adapters).toEqual(['core', 'browser', 'pipeline', 'package']);
    expect(report.validChecks).toBe(7);
    expect(report.rejectedChecks).toBe(3);
    for (const item of report.fixtureResults) {
      expect(item.status).toBe('passed');
      const digests = Object.values(item.digests).map((entry) => entry.sha256 ?? entry.failureCode);
      expect(new Set(digests).size).toBe(1);
    }
    // The four real adapters take ~6s end to end (the direct script run measures the same);
    // the default 5s vitest deadline is shorter than the work itself.
  }, 30_000);

  it('does not consult clock, random, network, or dynamic code while running the core adapter', async () => {
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock'); });
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('random'); });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network'); });
    const dynamic = vi.spyOn(globalThis, 'Function').mockImplementation(() => { throw new Error('dynamic code'); });
    try {
      const scan = async (item) => {
        const result = scanWorkflowV2({ bytes: bytes(item), profile: V2_ADAPTER_PROFILE });
        return result.ok ? success(result.result) : failure(result.code);
      };
      const report = await runParityGate({ fixtures: [fixture('safe-workflow'), fixture('malformed-workflow')], adapters: { core: scan, browser: scan, pipeline: scan, package: scan } });
      expect(report.ok).toBe(true);
    } finally {
      clock.mockRestore();
      random.mockRestore();
      fetch.mockRestore();
      dynamic.mockRestore();
    }
  });
});
