import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { fieldFlowPathDigestV1 } from '@hub/contracts/scanner-v2-field-flow-validation';
import type { SubjectV2 } from '../../capabilities/scheduler';
import { createNodeIdentityDigest } from '../../workflow-v2/node-edge-identity';
import {
  emitScanLocalFlowFacts, type ScanLocalFlowFactsInputV1, type ScanLocalFlowFactsV1,
} from './scan-local-flow-facts';
import { createScanLocalFlowCollector, type ScanLocalFlowCandidateV1 } from './scan-local-flows';
import {
  SCAN_LOCAL_LIMITS_V1, knownState,
  type FieldStateV1, type SanitizerTokenV1, type ScanLocalChargeV1, type TaintAtomV1, type UnknownReasonV1,
} from './scan-local-state';
import { runScanLocalWorklist } from './scan-local-worklist';

const ORIGIN: TaintAtomV1 = { sourceId: 'origin', field: ['body'], channel: 'INTEGRITY' };
const MAX_SEGMENTS = SCAN_LOCAL_LIMITS_V1.maxPathDepth;
const MAX_REASONS = SCAN_LOCAL_LIMITS_V1.maxUnknownReasons;
/** A bounded preflight may inspect the cap plus its sentinel slot, and do so twice. */
const BOUNDED_SEGMENT_READS = 2 * (MAX_SEGMENTS + 1);
const BOUNDED_REASON_READS = 2 * (MAX_REASONS + 1);

/** One candidate produced by the real worklist and collector: every case is a genuinely executed flow. */
function paidCandidate(): ScanLocalFlowCandidateV1 {
  const collector = createScanLocalFlowCollector({
    sources: new Map([['origin', 'a']]), requests: [{ atom: ORIGIN, sink: 'z' }],
  });
  const analysis = runScanLocalWorklist({
    entry: 'a', graph: new Map([['a', ['z']], ['z', []]]), initialState: knownState([ORIGIN]),
    transfer: (_node, state) => state, maxStates: 8, maxOperations: 100_000,
    publish: (publication, debit) => collector.publish(publication, debit),
  });
  const candidate = collector.collect(analysis).candidates[0];
  if (candidate === undefined) throw new Error('Fixture did not publish its sink');
  return candidate;
}

function nodeSubject(ordinal: number, occurrencePath: readonly number[]): SubjectV2 {
  const source = { pointer: `/nodes/${ordinal}`, occurrencePath, astNodeId: 'a'.repeat(64), span: null };
  return { kind: 'NODE', node: { ordinal, source, identityDigest: createNodeIdentityDigest(ordinal, source) } };
}

/** Counts real element reads, so forbidden traversal is an observed number rather than an assumption. */
function counted<T>(values: readonly T[]): Readonly<{ value: readonly T[]; reads: () => number }> {
  const target = [...values];
  let reads = 0;
  const isIndex = (key: PropertyKey): boolean => typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key);
  const proxy = new Proxy(target, {
    get(object, key, receiver) {
      if (isIndex(key)) reads += 1;
      return Reflect.get(object, key, receiver);
    },
    getOwnPropertyDescriptor(object, key) {
      if (isIndex(key)) reads += 1;
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
  });
  return { value: proxy, reads: () => reads };
}

type OverridesV1 = Partial<Pick<ScanLocalFlowFactsInputV1,
  'candidate' | 'charge' | 'sourceSubject' | 'sinkSubject' | 'sinkClass' | 'sinkFieldPath' | 'sinkParameterPath' | 'sinkChannel'>>;

/** The factory's own debit is observed: every unit it asks the run's counter for is recorded. */
function emit(overrides: OverridesV1 = {}): Readonly<{ result: ScanLocalFlowFactsV1; paid: number }> {
  let paid = 0;
  const charge: ScanLocalChargeV1 = (units) => { paid += units; return true; };
  const result = emitScanLocalFlowFacts({
    candidate: overrides.candidate ?? paidCandidate(), charge: overrides.charge ?? charge,
    sourceSubject: overrides.sourceSubject ?? nodeSubject(0, [0]),
    sinkSubject: overrides.sinkSubject ?? nodeSubject(1, [1]),
    taintLabels: ['MODEL_OUTPUT'], sinkClass: overrides.sinkClass ?? 'COMMAND',
    sinkFieldPath: overrides.sinkFieldPath ?? ['command'], sinkParameterPath: overrides.sinkParameterPath ?? '/command',
    sinkChannel: overrides.sinkChannel ?? 'DATA', edgeChannel: 'DATA', limits: DEFAULT_SCANNER_LIMITS_V2,
  });
  return Object.freeze({ result, paid });
}

const token = (sink: string, path: readonly string[]): SanitizerTokenV1 =>
  ({ modelId: 'sf.san.v1.number', sink, pathDigest: fieldFlowPathDigestV1(path) });
const sanitized = (tokens: readonly SanitizerTokenV1[], omittedSanitizers = 0): ScanLocalFlowCandidateV1 => {
  const candidate = paidCandidate();
  return { ...candidate, sinkState: knownState(candidate.sinkState.atoms, tokens, omittedSanitizers) };
};

describe('prepaid scan-local flow fact budgets', () => {
  it('refuses an over-cap sink path without hashing the over-cap segments', () => {
    const path = counted(Array.from({ length: 2_000 }, () => 'segment'));
    const { result } = emit({ sinkFieldPath: path.value, sinkParameterPath: '/segment' });
    expect(result).toEqual({ status: 'OMITTED', reason: 'INVALID_PROPERTY' });
    // The digest serializes and SHA-256s the whole caller path before the contract cap applies.
    expect(path.reads()).toBeLessThanOrEqual(BOUNDED_SEGMENT_READS);
  });

  it('refuses a non-NODE subject before the validator walks its occurrence path', () => {
    const occurrence = counted(Array.from({ length: 200_000 }, () => 0));
    const sourceSubject: SubjectV2 = {
      kind: 'SOURCE', source: { pointer: '', occurrencePath: occurrence.value, astNodeId: 'a'.repeat(64), span: null },
    };
    const { result } = emit({ sourceSubject });
    expect(result).toEqual({ status: 'OMITTED', reason: 'INVALID_SUBJECT' });
    // readSubject parses the whole occurrencePath before the emitter can reject the kind.
    expect(occurrence.reads()).toBeLessThanOrEqual(BOUNDED_SEGMENT_READS);
  });

  it('bounds a long unknown-reason list before building its set', () => {
    const reasons = counted(Array.from({ length: 200_000 }, (): UnknownReasonV1 => 'AMBIGUOUS_EDGE'));
    const candidate = paidCandidate();
    const sinkState: FieldStateV1 = Object.freeze({
      knowledge: 'UNKNOWN' as const, atoms: candidate.sinkState.atoms, sanitizedFor: Object.freeze([]), omittedSanitizers: 0,
      unknownReasons: reasons.value as readonly [UnknownReasonV1, ...UnknownReasonV1[]],
    });
    const { result } = emit({ candidate: { ...candidate, sinkState } });
    expect(reasons.reads()).toBeLessThanOrEqual(BOUNDED_REASON_READS);
    expect(result.status).not.toBe('SUPPRESSED');
    // A bounded read that sees overflow must surface it instead of claiming a clean reason set.
    if (result.status === 'EMITTED') expect(result.summary.properties.unknownReasons).toContain('PAYLOAD_LIMIT');
  });

  it('pays for every NODE source occurrence-path slot the validator parses', () => {
    const occurrence = counted(Array.from({ length: 4_096 }, (_, index) => index));
    const large = emit({ sourceSubject: nodeSubject(0, occurrence.value) });
    const small = emit({ sourceSubject: nodeSubject(0, [0]) });
    expect(large.result.status).toBe('EMITTED');
    expect(occurrence.reads()).toBeGreaterThanOrEqual(occurrence.value.length);
    // One unit per slot does not cover own-index enumeration, name validation and mapping.
    expect(large.paid - small.paid).toBeGreaterThanOrEqual(2 * (occurrence.value.length - 1));
  });

  it('never returns clean SUPPRESSED for malformed metadata or a contradictory KNOWN state', () => {
    const path = ['command'];
    const suppressed = emit({ candidate: sanitized([token('COMMAND', path)]) });
    expect(suppressed.result.status).toBe('SUPPRESSED');
    const malformed = [
      emit({ candidate: sanitized([token('COMMAND', ['/etc/passwd'])]), sinkFieldPath: ['/etc/passwd'] }),
      emit({ candidate: sanitized([token('COMMAND', path)]), sinkParameterPath: 'command' }),
      emit({ candidate: sanitized([token('COMMAND', path)]), sinkChannel: 'BOGUS' }),
    ].map(({ result }) => result.status === 'OMITTED' ? result.reason : result.status);
    expect(malformed).toEqual(['INVALID_PROPERTY', 'INVALID_PROPERTY', 'INVALID_PROPERTY']);
    // A KNOWN state that already carries an omission is contradictory: the token must not hide it.
    const contradictory = emit({ candidate: sanitized([token('COMMAND', path)], 1) }).result;
    expect(contradictory.status).toBe('EMITTED');
    if (contradictory.status === 'EMITTED') {
      expect(contradictory.summary.properties).toMatchObject({
        knowledge: 'UNKNOWN', unknownReasons: ['PAYLOAD_LIMIT'], omittedSanitizers: 1,
      });
    }
  });
});
