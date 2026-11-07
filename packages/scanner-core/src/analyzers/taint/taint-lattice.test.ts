import { describe, expect, it } from 'vitest';
import {
  MAX_TAINT_LATTICE_ASCENT,
  TAINT_LABELS,
  TAINT_SINK_KINDS,
  bottomTaintState,
  createTaintState,
  isTaintStateAtMost,
  joinTaintStates,
  reachesSink,
  taintStatesEqual,
  topTaintState,
  type TaintState,
} from './taint-lattice';

const webhookBody = createTaintState(['WEBHOOK_BODY'], []);
const externalResponse = createTaintState(['EXTERNAL_HTTP_RESPONSE'], []);
const sanitizedForHeader = createTaintState(['WEBHOOK_BODY'], ['HEADER']);

describe('taint lattice ordering', () => {
  it('orders the least state below and the greatest state above every state', () => {
    for (const state of [bottomTaintState, topTaintState, webhookBody, sanitizedForHeader]) {
      expect(isTaintStateAtMost(bottomTaintState, state)).toBe(true);
      expect(isTaintStateAtMost(state, topTaintState)).toBe(true);
    }
  });

  it('treats more labels and fewer sanitized sinks as greater', () => {
    expect(isTaintStateAtMost(sanitizedForHeader, webhookBody)).toBe(true);
    expect(isTaintStateAtMost(webhookBody, sanitizedForHeader)).toBe(false);
  });
});

describe('joinTaintStates', () => {
  it('is an upper bound of both operands', () => {
    const joined = joinTaintStates(webhookBody, externalResponse);

    expect(isTaintStateAtMost(webhookBody, joined)).toBe(true);
    expect(isTaintStateAtMost(externalResponse, joined)).toBe(true);
  });

  it('accumulates labels across paths', () => {
    const joined = joinTaintStates(webhookBody, externalResponse);

    expect([...joined.labels].sort()).toEqual(['EXTERNAL_HTTP_RESPONSE', 'WEBHOOK_BODY']);
  });

  it('keeps a sink sanitized only when every path sanitizes it', () => {
    const joined = joinTaintStates(sanitizedForHeader, webhookBody);

    expect(joined.sanitizedFor.has('HEADER')).toBe(false);
    expect(taintStatesEqual(joinTaintStates(sanitizedForHeader, sanitizedForHeader), sanitizedForHeader)).toBe(true);
  });

  it('is idempotent, commutative, and associative', () => {
    const a = sanitizedForHeader;
    const b = externalResponse;
    const c = createTaintState(['INBOUND_MESSAGE'], ['HEADER', 'SSRF']);

    expect(taintStatesEqual(joinTaintStates(a, a), a)).toBe(true);
    expect(taintStatesEqual(joinTaintStates(a, b), joinTaintStates(b, a))).toBe(true);
    expect(taintStatesEqual(
      joinTaintStates(joinTaintStates(a, b), c),
      joinTaintStates(a, joinTaintStates(b, c)),
    )).toBe(true);
  });

  it('treats the least state as an identity and the greatest state as absorbing', () => {
    expect(taintStatesEqual(joinTaintStates(webhookBody, bottomTaintState), webhookBody)).toBe(true);
    expect(taintStatesEqual(joinTaintStates(webhookBody, topTaintState), topTaintState)).toBe(true);
  });
});

describe('taint lattice height', () => {
  it('bounds a maximal strictly ascending chain from the least state', () => {
    const chain = maximalAscendingChain();

    expect(chain.length - 1).toBe(MAX_TAINT_LATTICE_ASCENT);
    expect(MAX_TAINT_LATTICE_ASCENT).toBe(TAINT_LABELS.length + TAINT_SINK_KINDS.length);
    for (let index = 1; index < chain.length; index += 1) {
      expect(isTaintStateAtMost(chain[index - 1], chain[index])).toBe(true);
      expect(taintStatesEqual(chain[index - 1], chain[index])).toBe(false);
    }
    expect(taintStatesEqual(chain[chain.length - 1], topTaintState)).toBe(true);
  });
});

describe('reachesSink', () => {
  it('is false for an untainted state', () => {
    expect(reachesSink(bottomTaintState, 'COMMAND')).toBe(false);
  });

  it('is false for a tainted state sanitized for that sink', () => {
    expect(reachesSink(sanitizedForHeader, 'HEADER')).toBe(false);
  });

  it('is true for a tainted state sanitized only for a different sink', () => {
    expect(reachesSink(sanitizedForHeader, 'COMMAND')).toBe(true);
  });
});

/**
 * Ascends from the least state by adding one label at a time, then removing one
 * sanitized sink at a time. Every step is a strict increase, so its length is
 * the lattice height.
 */
function maximalAscendingChain(): TaintState[] {
  const chain: TaintState[] = [bottomTaintState];
  TAINT_LABELS.forEach((_label, index) => {
    chain.push(createTaintState(TAINT_LABELS.slice(0, index + 1), TAINT_SINK_KINDS));
  });
  TAINT_SINK_KINDS.forEach((_sink, index) => {
    chain.push(createTaintState(TAINT_LABELS, TAINT_SINK_KINDS.slice(index + 1)));
  });
  return chain;
}
