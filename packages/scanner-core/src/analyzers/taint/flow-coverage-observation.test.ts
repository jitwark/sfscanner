import { describe, expect, it, vi } from 'vitest';
import {
  createFlowCoverageLogV1,
  withFlowCoverageChargeV1,
  type FlowCoverageSnapshotV1,
} from './flow-coverage-observation';
import type { ScanLocalFlowFactsV1 } from './scan-local-flow-facts';
import type { ScanLocalFlowCandidateV1 } from './scan-local-flows';
import type { ScanLocalFlowFactEmitterV1 } from './scan-local-flow-witness-facts';
import {
  knownState,
  SCAN_LOCAL_LIMITS_V1,
  type ScanLocalChargeV1,
  type TaintAtomV1,
} from './scan-local-state';
import { runScanLocalWorklist } from './scan-local-worklist';

const ATOM: TaintAtomV1 = Object.freeze({
  sourceId: 'webhook',
  field: Object.freeze(['body']),
  channel: 'INTEGRITY',
});
const omitted = (reason: 'INVALID_PROPERTY' | 'BUDGET_EXHAUSTED' = 'INVALID_PROPERTY'):
ScanLocalFlowFactsV1 => Object.freeze({ status: 'OMITTED', reason });
const candidate = (label = 'same'): ScanLocalFlowCandidateV1 => {
  const terminalInputRead: NonNullable<ScanLocalFlowCandidateV1['terminalInputRead']> = {
    channel: 'DATA',
    path: ['body'],
    sinkParameterPath: '/command',
    carrier: { kind: 'PROPAGATION', node: 1, field: `/terminal/${label}`, port: 0, item: 0 },
  };
  return Object.freeze({
    atom: ATOM,
    sourceNode: 'source',
    sinkNode: 'sink',
    sinkState: knownState([ATOM]),
    observation: 'TERMINAL_INPUT_READ',
    omittedAtoms: 0,
    omittedTokens: 0,
    terminalInputRead,
  });
};
const always = (): ScanLocalChargeV1 => () => true;

describe('flow coverage observation log', () => {
  it('distinguishes no worklist callback from a charged empty run', () => {
    const absent = createFlowCoverageLogV1();
    expect(absent.snapshot([])).toEqual({ status: 'REFUSED', reason: 'NO_CHARGE' });

    const charge = vi.fn<ScanLocalChargeV1>(() => true);
    absent.captureCharge(charge);
    const snapshot = absent.snapshot([]);
    expect(snapshot).toEqual({ status: 'OBSERVED', rows: [] });
    expect(charge).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledWith(1);
  });

  it('retains the first exact shared worklist handle with and without input.charge', () => {
    for (const supplied of [undefined, vi.fn<ScanLocalChargeV1>(() => true)]) {
      const seen: ScanLocalChargeV1[] = [];
      const log = createFlowCoverageLogV1();
      runScanLocalWorklist({
        entry: 'a',
        graph: new Map([['a', []]]),
        initialState: knownState(),
        transfer: (_node, state) => state,
        maxStates: 4,
        maxOperations: 32,
        ...(supplied === undefined ? {} : { charge: supplied }),
        publish: (_publication, charge) => {
          seen.push(charge);
          log.captureCharge(charge);
        },
        finish: (charge) => {
          seen.push(charge);
          log.captureCharge(charge);
          return 0;
        },
      });

      const snapshot = log.snapshot([]);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((charge) => charge === seen[0])).toBe(true);
      const handed = withFlowCoverageChargeV1(snapshot, (charge) => charge === seen[0]);
      expect(handed).toEqual({ ok: true, value: true });
    }
    const log = createFlowCoverageLogV1();
    log.captureCharge(always());
    expect(() => log.captureCharge(always())).toThrow(TypeError);
  });

  it('reserves one immutable observation slot and returns the existing emission identity', () => {
    const log = createFlowCoverageLogV1();
    const input = candidate();
    const emission = omitted();
    const emitter = vi.fn<ScanLocalFlowFactEmitterV1>(() => emission);
    const candidateCharge = vi.fn<ScanLocalChargeV1>(() => true);
    const wrapped = log.wrapEmitter(emitter);

    expect(wrapped(input, candidateCharge)).toBe(emission);
    expect(emitter).toHaveBeenCalledWith(input, candidateCharge);
    expect(candidateCharge).toHaveBeenCalledWith(1);
    const charge = always();
    log.captureCharge(charge);
    const snapshot = log.snapshot([input]);
    if (snapshot.status !== 'OBSERVED') throw new Error(`Expected observed, received ${snapshot.reason}`);
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]!.candidate).toBe(input);
    expect(snapshot.rows[0]!.emission).toBe(emission);
    expect(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.rows) && Object.isFrozen(snapshot.rows[0])).toBe(true);
  });

  it('refuses storage before calling the emitter and makes the refusal terminal', () => {
    const log = createFlowCoverageLogV1();
    const emitter = vi.fn<ScanLocalFlowFactEmitterV1>(() => omitted());
    const wrapped = log.wrapEmitter(emitter);
    const refusedCharge = vi.fn<ScanLocalChargeV1>(() => false);

    expect(wrapped(candidate(), refusedCharge)).toEqual({ status: 'OMITTED', reason: 'BUDGET_EXHAUSTED' });
    expect(emitter).not.toHaveBeenCalled();
    const laterCharge = vi.fn<ScanLocalChargeV1>(() => true);
    log.captureCharge(laterCharge);
    expect(log.snapshot([])).toEqual({ status: 'REFUSED', reason: 'BUDGET_EXHAUSTED' });
    expect(laterCharge).not.toHaveBeenCalled();
  });

  it('records an emitter refusal that occurs after the storage reservation', () => {
    const log = createFlowCoverageLogV1();
    const input = candidate();
    const emission = omitted('BUDGET_EXHAUSTED');
    const wrapped = log.wrapEmitter(() => emission);
    expect(wrapped(input, always())).toBe(emission);
    const charge = always();
    log.captureCharge(charge);
    const snapshot = log.snapshot([input]);
    if (snapshot.status !== 'OBSERVED') throw new Error(`Expected observed, received ${snapshot.reason}`);
    expect(snapshot.rows).toEqual([{ candidate: input, emission }]);
  });

  it('prepays the full snapshot descriptor before any filtering walk', () => {
    const log = createFlowCoverageLogV1();
    const input = candidate();
    log.wrapEmitter(() => omitted())(input, always());
    let descriptorReads = 0;
    const finals = new Proxy([input], {
      get(target, property, receiver) {
        if (property === 'length') descriptorReads += 1;
        if (property === Symbol.iterator || property === 'filter' || property === 'map') {
          throw new Error('snapshot walked the final candidates before payment');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const charge = vi.fn<ScanLocalChargeV1>(() => {
      if (charge.mock.calls.length === 1) {
        expect(descriptorReads).toBe(0);
        return true;
      }
      expect(descriptorReads).toBe(1);
      return false;
    });
    log.captureCharge(charge);

    expect(log.snapshot(finals)).toEqual({ status: 'REFUSED', reason: 'BUDGET_EXHAUSTED' });
    expect(charge).toHaveBeenCalledTimes(2);
    expect(descriptorReads).toBe(1);
  });

  it('filters by exact final candidate identity and preserves insertion order', () => {
    const log = createFlowCoverageLogV1();
    const stale = candidate('stale');
    const first = candidate('first');
    const second = candidate('second');
    const wrapped = log.wrapEmitter((item) => omitted(item === stale ? 'INVALID_PROPERTY' : 'BUDGET_EXHAUSTED'));
    wrapped(stale, always());
    wrapped(first, always());
    wrapped(second, always());
    log.captureCharge(always());

    const snapshot = log.snapshot([second, first]);
    if (snapshot.status !== 'OBSERVED') throw new Error(`Expected observed, received ${snapshot.reason}`);
    expect(snapshot.rows.map((row) => row.candidate)).toEqual([first, second]);
    expect(snapshot.rows[0]!.candidate).toBe(first);
    expect(snapshot.rows[1]!.candidate).toBe(second);
    expect(Object.isFrozen(snapshot.rows)).toBe(true);
  });

  it('bounds stored observations and final candidates with existing state limits', () => {
    const log = createFlowCoverageLogV1();
    const input = candidate();
    const emitter = vi.fn<ScanLocalFlowFactEmitterV1>(() => omitted());
    const wrapped = log.wrapEmitter(emitter);
    const charge = always();
    for (let index = 0; index < SCAN_LOCAL_LIMITS_V1.maxFieldStates; index += 1) wrapped(input, charge);
    expect(emitter).toHaveBeenCalledTimes(SCAN_LOCAL_LIMITS_V1.maxFieldStates);
    expect(wrapped(input, charge)).toEqual({ status: 'OMITTED', reason: 'BUDGET_EXHAUSTED' });

    const empty = createFlowCoverageLogV1();
    empty.captureCharge(always());
    const tooMany = Array.from({ length: SCAN_LOCAL_LIMITS_V1.maxFieldStates + 1 }, () => input);
    expect(empty.snapshot(tooMany)).toEqual({ status: 'REFUSED', reason: 'BUDGET_EXHAUSTED' });
  });

  it('passes only a snapshot-private exact charge and refuses foreign snapshots', () => {
    const log = createFlowCoverageLogV1();
    const captureCharge = always();
    log.captureCharge(captureCharge);
    const snapshot = log.snapshot([]);
    const work = vi.fn((charge: ScanLocalChargeV1) => charge === captureCharge);
    expect(withFlowCoverageChargeV1(snapshot, work)).toEqual({ ok: true, value: true });
    expect(work).toHaveBeenCalledTimes(1);

    const foreign = Object.freeze({ status: 'OBSERVED', rows: Object.freeze([]) }) as FlowCoverageSnapshotV1;
    expect(withFlowCoverageChargeV1(foreign, work)).toEqual({ ok: false, reason: 'NO_CHARGE' });
    expect(work).toHaveBeenCalledTimes(1);
  });
});
