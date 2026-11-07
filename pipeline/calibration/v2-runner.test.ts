import { describe, expect, it } from 'vitest';
import { scanWorkflowV2, type ScanWorkflowV2Result } from '@hub/scanner-core/v2';
import type { ScannerResultV2 } from '../../contracts/scanner-v2-result';
import { createTargetContextDigestV3 } from '../../contracts/scanner-target-v3';
import {
  createV2CalibrationCase,
  V2CalibrationValidationError,
  type V2CalibrationAuthority,
  type V2CalibrationCase,
} from './v2-case-schema';
import { runCalibrationV2 } from './v2-runner';

const encoder = new TextEncoder();
const empty = encoder.encode('{"nodes":[],"connections":{}}');
const positiveBytes = encoder.encode(JSON.stringify({
  nodes: [{ id: 'command', name: 'run', type: 'n8n-nodes-base.executeCommand', typeVersion: 1, parameters: { command: 'echo safe' } }],
  connections: {},
}));
// The UNSUPPORTED label means "the scanner publishes no grade for this workflow" (observedState
// ABSTAINED), not "the node package is uncatalogued": since the labelled generic fallback, an
// unmodelled but *readable* node grades DEGRADED (ADR-generic-node-semantic-fallback §2), so the
// fail-closed subject is the node whose `parameters` member is unreadable (§4).
const unsupportedBytes = encoder.encode(JSON.stringify({
  nodes: [{ id: 'custom', name: 'custom', type: '@example/custom-node.unknown', parameters: 'not-an-object' }],
  connections: {},
}));

function scan(bytes: Uint8Array): Extract<ScanWorkflowV2Result, { ok: true }>['result'] {
  const result = scanWorkflowV2({ bytes, profile: { id: 'beta-default', version: '2.0.0' }});
  if (!result.ok) throw new Error(result.code);
  return result.result;
}

const authority = (result: ScannerResultV2): V2CalibrationAuthority => ({
  engine: result.engine,
  profile: result.profile,
  ruleset: result.ruleset,
  semantics: result.semantics,
});

function fixture(overrides: Partial<V2CalibrationCase> = {}): V2CalibrationCase {
  const result = scan(empty);
  return createV2CalibrationCase({
    schemaVersion: 'calibration-case-v2',
    id: 'clean-negative',
    bytes: empty,
    provenance: {
      source: 'fixture/repository', commit: 'a'.repeat(40), path: 'workflows/clean.json',
      licence: 'MIT', permission: 'redistributable', digest: result.input.rawSha256,
    },
    target: result.target,
    profile: result.profile,
    authority: authority(result),
    split: 'development',
    expected: {
      label: 'NEGATIVE',
      rules: [],
      analysisStatus: 'COMPLETE',
    },
    ...overrides,
  });
}

describe('v2 calibration case schema', () => {
  it('keeps bytes and provenance lineage immutable', () => {
    const bytes = new Uint8Array(empty);
    const value = fixture({ id: 'copy-check', bytes });
    bytes[0] = 0;
    expect(value.bytes[0]).toBe(empty[0]);
    expect(value.provenance.digest).toBe(scan(empty).input.rawSha256);
  });

  it('rejects unknown keys, duplicate IDs, invalid UTF-8, unsafe bytes, and missing provenance', () => {
    expect(() => createV2CalibrationCase({ ...fixture(), extra: true } as never)).toThrow(V2CalibrationValidationError);
    expect(() => runCalibrationV2([fixture(), fixture({ id: 'clean-negative-2' })], { split: 'development' })).not.toThrow();
    expect(() => createV2CalibrationCase({ ...fixture(), bytes: new Uint8Array([0xc3, 0x28]) })).toThrow(/UTF8|bytes/i);
    expect(() => createV2CalibrationCase({ ...fixture(), bytes: new Uint8Array([0]) })).toThrow(/unsafe/i);
    expect(() => createV2CalibrationCase({ ...fixture(), provenance: { ...fixture().provenance, commit: '' } })).toThrow(/provenance/i);
    expect(() => createV2CalibrationCase({ ...fixture(), target: { ...fixture().target, schemaVersion: 'scanner-target-v2' } })).toThrow(/target\.schemaVersion/i);
    expect(() => runCalibrationV2([fixture(), fixture({ id: 'clean-negative' })])).toThrow(/duplicate/i);
    expect(() => createV2CalibrationCase({ ...fixture(), expected: { label: 'POSITIVE', rules: [] } })).toThrow(/POSITIVE/);
  });

  it('enforces the canonical target-v3 pair, digest, and semver contract', () => {
    const { contextDigest: _digest, ...body } = fixture().target;
    const packages = [
      { name: 'alpha-package', version: '1.0.0' },
      { name: 'alpha-package', version: '2.0.0' },
    ];
    const targetBody = { ...body, communityPackages: packages };
    const target = { ...targetBody, contextDigest: createTargetContextDigestV3(targetBody) };
    expect(createV2CalibrationCase({ ...fixture(), target }).target.communityPackages).toHaveLength(2);

    expect(() => createV2CalibrationCase({ ...fixture(), target: { ...fixture().target, contextDigest: '0'.repeat(64) } })).toThrow(/contextDigest|digest/i);

    const nonSemverBody = { ...body, n8nVersion: '2.0' };
    const nonSemver = { ...nonSemverBody, contextDigest: createTargetContextDigestV3(nonSemverBody) };
    expect(() => createV2CalibrationCase({ ...fixture(), target: nonSemver })).toThrow(/semver|version/i);

    const duplicateBody = { ...body, communityPackages: [packages[0]!, packages[0]!] };
    const duplicate = { ...duplicateBody, contextDigest: createTargetContextDigestV3(duplicateBody) };
    expect(() => createV2CalibrationCase({ ...fixture(), target: duplicate })).toThrow(/target\.communityPackages|canonical/i);
  });
});

describe('runCalibrationV2', () => {
  it('reports positive, negative, near-miss, and unsupported labels without relabelling them', () => {
    const positive = scan(positiveBytes);
    const ruleId = positive.findings[0]?.ruleId;
    expect(ruleId).toBeTruthy();
    const cases = [
      fixture({ id: 'positive', bytes: positiveBytes, provenance: { ...fixture().provenance, path: 'workflows/positive.json', digest: positive.input.rawSha256 }, authority: authority(positive), expected: { label: 'POSITIVE', rules: [{ ruleId: ruleId!, label: 'POSITIVE' }], analysisStatus: 'COMPLETE' }}),
      fixture({ id: 'negative', expected: { label: 'NEGATIVE', rules: [{ ruleId: ruleId!, label: 'NEGATIVE' }], analysisStatus: 'COMPLETE' }}),
      fixture({ id: 'near-miss', expected: { label: 'NEAR_MISS', rules: [{ ruleId: ruleId!, label: 'NEAR_MISS' }], analysisStatus: 'COMPLETE' }}),
      (() => { const result = scan(unsupportedBytes); return fixture({ id: 'unsupported', bytes: unsupportedBytes, provenance: { ...fixture().provenance, path: 'workflows/unsupported.json', digest: result.input.rawSha256 }, authority: authority(result), expected: { label: 'UNSUPPORTED', rules: [], analysisStatus: 'INDETERMINATE' }}); })(),
    ];
    const report = runCalibrationV2(cases);
    expect(report.cases.map((item) => item.expectedLabel)).toEqual(['NEAR_MISS', 'NEGATIVE', 'POSITIVE', 'UNSUPPORTED']);
    expect(report.cases.find((item) => item.caseId === 'positive')?.falseNegativeRules).toEqual([]);
    expect(report.cases.find((item) => item.caseId === 'unsupported')?.observedState).toBe('ABSTAINED');
    expect(report.ruleMetrics[ruleId!]).toMatchObject({ positiveDenominator: 1, negativeDenominator: 1, nearMissDenominator: 1 });
  });
  it('keeps UNKNOWN distinct from a clean negative result', () => {
    const baseline = scan(empty);
    const unknownResult = { ...baseline, findings: [{ ruleId: 'RULE_UNKNOWN', conclusion: 'UNKNOWN', applicability: 'UNKNOWN' }] } as ScannerResultV2;
    const report = runCalibrationV2([fixture()], { scan: () => ({ ok: true, result: unknownResult }) });
    expect(report.cases[0]?.observedState).toBe('UNKNOWN');
    expect(report.cases[0]?.unknownRules).toEqual(['RULE_UNKNOWN']);
  });
  it('reports a false negative without changing the authored positive label', () => {
    const baseline = scan(positiveBytes);
    const ruleId = baseline.findings[0]?.ruleId;
    expect(ruleId).toBeTruthy();
    const value = fixture({ id: 'false-negative', bytes: positiveBytes, provenance: { ...fixture().provenance, path: 'workflows/false-negative.json', digest: baseline.input.rawSha256 }, authority: authority(baseline), expected: { label: 'POSITIVE', rules: [{ ruleId: ruleId!, label: 'POSITIVE' }] } });
    const result = runCalibrationV2([value], { scan: () => ({ ok: true, result: { ...baseline, findings: [] } as ScannerResultV2 }) });
    expect(result.cases[0]).toMatchObject({ expectedLabel: 'POSITIVE', observedState: 'NEGATIVE', falseNegativeRules: [ruleId] });
  });
  it('records rejected outcomes without collapsing them into abstention', () => {
    const value = fixture({ id: 'rejected', expected: { label: 'UNSUPPORTED', rules: [{ ruleId: 'RULE_REJECTED', label: 'UNSUPPORTED' }], analysisStatus: 'REJECTED' } });
    const report = runCalibrationV2([value], { scan: () => ({ ok: false, code: 'INVALID_JSON', message: 'fixture rejection' }) });
    expect(report.cases[0]).toMatchObject({ observedState: 'REJECTED', scannerError: 'INVALID_JSON' });
    expect(report.ruleMetrics.RULE_REJECTED).toMatchObject({ rejectedCases: 1 });
  });

  it('leaves precision and recall null when a denominator is zero', () => {
    const value = fixture({ id: 'zero-denominator', expected: { label: 'NEGATIVE', rules: [{ ruleId: 'RULE_ZERO', label: 'NEGATIVE' }] } });
    const report = runCalibrationV2([value]);
    expect(report.ruleMetrics.RULE_ZERO).toMatchObject({ positiveDenominator: 0, precision: null, recall: null });
  });

  it('keeps holdout cases out of development calibration', () => {
    expect(() => runCalibrationV2([fixture({ split: 'holdout' })])).toThrow(/holdout/i);
    const report = runCalibrationV2([fixture({ id: 'holdout', split: 'holdout' })], { split: 'holdout' });
    expect(report.split).toBe('holdout');
    expect(report.cases).toHaveLength(1);
  });

  it('rejects stale authority digests and records deterministic budgets', () => {
    const value = fixture({ authority: { ...fixture().authority, ruleset: { ...fixture().authority.ruleset, digest: '0'.repeat(64) } } });
    expect(() => runCalibrationV2([value])).toThrow(/authority|digest/i);
    const report = runCalibrationV2([fixture()], { now: (() => { let n = 10; return () => (n += 2); })(), memory: (() => { let n = 100; return () => (n += 7); })() });
    expect(report.cases[0]?.counters).toMatchObject({ latencyMs: 2, memoryBytes: 7, serializedBytes: expect.any(Number) });
  });

  it('never executes workflow content and supports an injected pure scanner', () => {
    let calls = 0;
    const report = runCalibrationV2([fixture()], { scan: (request) => { calls += 1; expect(request.bytes).toBeInstanceOf(Uint8Array); return scanWorkflowV2(request); } });
    expect(calls).toBe(1);
    expect(report.cases[0]?.observedState).toBe('NEGATIVE');
  });
});
