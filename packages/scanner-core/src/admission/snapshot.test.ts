import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2, type ScannerLimitsV2 } from '@hub/contracts';
import { canonicalJsonBytes, canonicalizeJson } from '../canonical-json';
import * as snapshotModule from './snapshot';
import { isScannerAdmissionSnapshotV2, ParserOwnedAdmissionBoundaryV2 } from './snapshot';
import type { CapabilityCandidateV2, SafeFactV2 } from '../capabilities/scheduler';

const encoder = new TextEncoder();

function limits(overrides: Partial<ScannerLimitsV2> = {}): ScannerLimitsV2 {
  return { ...DEFAULT_SCANNER_LIMITS_V2, ...overrides };
}

function admit(text: string, overrides: Partial<ScannerLimitsV2> = {}) {
  return ParserOwnedAdmissionBoundaryV2.fromBoundedBytes(encoder.encode(text), limits(overrides));
}

function snapshotOf(result: ReturnType<typeof ParserOwnedAdmissionBoundaryV2.fromBoundedBytes>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected admitted snapshot');
  return result.snapshot;
}

function expectFrozenGraph(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Object.getOwnPropertyNames(value)) {
    expectFrozenGraph((value as Record<string, unknown>)[key], seen);
  }
}

function freezeGraph(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    freezeGraph((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

type InternalSnapshotBuilders = typeof snapshotModule & {
  createSafeFactAdmissionSnapshotV2?: (fact: SafeFactV2) => snapshotModule.ScannerAdmissionSnapshotV2<SafeFactV2>;
  createCapabilityCandidateAdmissionSnapshotV2?: (candidate: CapabilityCandidateV2) => snapshotModule.ScannerAdmissionSnapshotV2<CapabilityCandidateV2>;
};

describe('ParserOwnedAdmissionBoundaryV2', () => {
  it('accepts bytes at the inclusive byte bound and rejects max-plus-one', () => {
    const text = '{"nodes":[],"connections":{}}';
    const bytes = encoder.encode(text);
    expect(ParserOwnedAdmissionBoundaryV2.fromBoundedBytes(bytes, limits({ maxBytes: bytes.length })).ok).toBe(true);
    expect(ParserOwnedAdmissionBoundaryV2.fromBoundedBytes(bytes, limits({ maxBytes: bytes.length - 1 }))).toEqual({
      ok: false, code: 'LIMIT_EXCEEDED',
    });
  });

  it('maps malformed and invalid UTF-8 bytes to closed unsafe input', () => {
    expect(ParserOwnedAdmissionBoundaryV2.fromBoundedBytes(Uint8Array.of(0xc3, 0x28), limits())).toEqual({
      ok: false, code: 'UNSAFE_INPUT',
    });
    expect(admit('{"nodes":}')).toEqual({ ok: false, code: 'UNSAFE_INPUT' });
  });

  it('maps depth, syntax-node, and member max-plus-one to a closed limit result', () => {
    expect(admit('[[0]]', { maxDocumentDepth: 2 })).toEqual({ ok: false, code: 'LIMIT_EXCEEDED' });
    expect(admit('[0]', { maxSyntaxNodes: 2 })).toEqual({ ok: false, code: 'LIMIT_EXCEEDED' });
    expect(admit('{"a":1,"b":2}', { maxMembersAndElements: 1 })).toEqual({ ok: false, code: 'LIMIT_EXCEEDED' });
  });

  it('returns a private, out-of-band provenance snapshot without changing identity bytes', () => {
    const first = snapshotOf(admit('{"b":2,"a":[true,null]}'));
    const second = snapshotOf(admit('{"b":2,"a":[true,null]}'));
    expect(isScannerAdmissionSnapshotV2(first)).toBe(true);
    expect(isScannerAdmissionSnapshotV2(JSON.parse(JSON.stringify(first)))).toBe(false);
    expect(Object.getOwnPropertyNames(first)).not.toContain('scannerAdmissionBrandV2');
    expect(Object.getOwnPropertySymbols(first)).toHaveLength(0);
    expect(canonicalizeJson(first)).toBe(canonicalizeJson(second));
    expect(canonicalJsonBytes(first)).toEqual(canonicalJsonBytes(second));
  });

  it('rejects a deeply frozen structurally identical clone without provenance', () => {
    const original = snapshotOf(admit('{"items":[{"value":"x"}]}'));
    const clone = freezeGraph(JSON.parse(JSON.stringify(original)));
    expectFrozenGraph(clone);
    expect(isScannerAdmissionSnapshotV2(clone)).toBe(false);
  });

  it('accepts one leading BOM but rejects a double BOM', () => {
    const json = encoder.encode('{}');
    const singleBom = Uint8Array.of(0xef, 0xbb, 0xbf, ...json);
    const doubleBom = Uint8Array.of(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...json);

    expect(ParserOwnedAdmissionBoundaryV2.fromBoundedBytes(singleBom, limits()).ok).toBe(true);
    expect(ParserOwnedAdmissionBoundaryV2.fromBoundedBytes(doubleBom, limits())).toEqual({
      ok: false, code: 'UNSAFE_INPUT',
    });
  });

  it('deep-freezes the admitted graph and does not mutate input bytes or limits', () => {
    const input = encoder.encode('{"items":[{"value":"x"}]}');
    const before = input.slice();
    const configured = limits({ maxBytes: input.length });
    const configuredBefore = { ...configured };
    const snapshot = snapshotOf(ParserOwnedAdmissionBoundaryV2.fromBoundedBytes(input, configured));
    expect(input).toEqual(before);
    expect(configured).toEqual(configuredBefore);
    expectFrozenGraph(snapshot);
  });

  it('rejects unbranded reflection shapes before ordinary reads', () => {
    let ownKeysCalled = false;
    const forwarding = new Proxy({}, {
      ownKeys: () => { ownKeysCalled = true; return Array.from({ length: 100_000 }, (_, index) => `k${index}`); },
    });
    let getterCalled = false;
    const getter = Object.defineProperty({}, 'value', { get: () => { getterCalled = true; throw new Error('secret'); } });
    const hidden = Object.defineProperty({}, 'hidden', { value: 1, enumerable: false });
    const symbol = Object.defineProperty({}, Symbol('hidden'), { value: 1 });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = new Array(1);
    const shapes = [forwarding, getter, hidden, symbol, Object.create(null), cycle, sparse];

    for (const shape of shapes) expect(isScannerAdmissionSnapshotV2(shape)).toBe(false);
    expect(ownKeysCalled).toBe(false);
    expect(getterCalled).toBe(false);
  });

  it('rejects hostile limits before invoking unbounded own-key reflection', () => {
    let ownKeysCalls = 0;
    const hostileLimits = new Proxy(Object.create(null), {
      ownKeys: () => {
        ownKeysCalls += 1;
        return Array.from({ length: 100_000 }, (_, index) => `k${index}`);
      },
    });

    expect(ParserOwnedAdmissionBoundaryV2.fromBoundedBytes(encoder.encode('{}'), hostileLimits as ScannerLimitsV2)).toEqual({
      ok: false, code: 'UNSAFE_INPUT',
    });
    expect(ownKeysCalls).toBe(0);
  });

  it('requires maxSourceWork in the closed v2 limits snapshot', () => {
    const configured = { ...DEFAULT_SCANNER_LIMITS_V2 } as Record<string, unknown>;
    delete configured.maxSourceWork;
    expect(ParserOwnedAdmissionBoundaryV2.fromBoundedBytes(encoder.encode('{}'), configured as ScannerLimitsV2)).toEqual({
      ok: false, code: 'UNSAFE_INPUT',
    });
    // Zero is a present, typed budget, so it is not UNSAFE_INPUT — but it cannot
    // pay for the root context either, so it is exhausted rather than admitted.
    // (Parser contract: `parse('{}', 0)` is SOURCE_WORK_LIMIT, graded
    // WORKFLOW_TOO_COMPLEX, which this boundary reports as a limit result.)
    expect(admit('{}', { maxSourceWork: 0 })).toEqual({ ok: false, code: 'LIMIT_EXCEEDED' });
  });

  it('provides one private brand through allowlist-only typed builders', () => {
    const builders = snapshotModule as InternalSnapshotBuilders;
    if (builders.createSafeFactAdmissionSnapshotV2 === undefined || builders.createCapabilityCandidateAdmissionSnapshotV2 === undefined) {
      throw new Error('internal admission snapshot builders are missing');
    }
    const fact = builders.createSafeFactAdmissionSnapshotV2({
      factId: 'f'.repeat(64),
      kind: 'workflow.summary.v1',
      subject: { kind: 'WORKFLOW' },
      properties: { basicPurpose: 'x' },
    });
    const candidate = builders.createCapabilityCandidateAdmissionSnapshotV2({
      findings: [], diagnostics: [], facts: [], traces: [], seen: 0, analyzed: 0, skipped: 0, omitted: 0,
    });

    expect(isScannerAdmissionSnapshotV2(fact)).toBe(true);
    expect(isScannerAdmissionSnapshotV2(candidate)).toBe(true);
    expect(Object.getOwnPropertyNames(fact)).toEqual(['factId', 'kind', 'subject', 'properties']);
    expect(Object.getOwnPropertyNames(candidate)).toEqual(['findings', 'diagnostics', 'facts', 'traces', 'seen', 'analyzed', 'skipped', 'omitted']);
    expectFrozenGraph(fact);
    expectFrozenGraph(candidate);
  });

  it('produces byte-identical output on repeated admission', () => {
    const first = snapshotOf(admit('{"nodes":[{"name":"A"}],"connections":{}}'));
    const second = snapshotOf(admit('{"nodes":[{"name":"A"}],"connections":{}}'));
    expect(first).toEqual(second);
    expect(canonicalizeJson(first)).toBe(canonicalizeJson(second));
  });
});
