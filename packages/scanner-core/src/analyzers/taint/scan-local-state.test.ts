import { describe, expect, it } from 'vitest';
import {
  SCAN_LOCAL_LIMITS_V1, boundFieldState, isValidFieldPath, joinFieldStates,
  knownState, overwriteFieldState, sanitizeFieldState, unknownState,
  type FieldStateV1, type ScanLocalChargeV1, type TaintAtomV1,
} from './scan-local-state';

const atom = (sourceId: string): TaintAtomV1 => ({ sourceId, field: ['body'], channel: 'CONFIDENTIALITY' });
/** Isolated helper semantics only: never a production budget. */
const unlimited: ScanLocalChargeV1 = () => true;
const ledger = (cap: number) => {
  const spent = { units: 0 };
  const charge: ScanLocalChargeV1 = (units) => {
    if (units > cap - spent.units) return false;
    spent.units += units;
    return true;
  };
  return { spent, charge };
};
const bounded = (state: FieldStateV1, charge: ScanLocalChargeV1 = unlimited) => {
  const result = boundFieldState(state, charge);
  if (result.status !== 'BOUNDED') throw new Error(`expected BOUNDED, got ${result.status}`);
  return result;
};
const joined = (left: FieldStateV1, right: FieldStateV1, charge: ScanLocalChargeV1 = unlimited): FieldStateV1 => {
  const result = joinFieldStates(left, right, charge);
  if (result.status !== 'JOINED') throw new Error(`expected JOINED, got ${result.status}`);
  return result.state;
};
const overwritten = (prior: FieldStateV1, replacement: FieldStateV1, exact: boolean): FieldStateV1 => {
  const result = overwriteFieldState(prior, replacement, exact, unlimited);
  if (result.status !== 'JOINED') throw new Error(`expected JOINED, got ${result.status}`);
  return result.state;
};

describe('scan-local taint state', () => {
  it('keeps KNOWN empty distinct from UNKNOWN and joins reasons deterministically', () => {
    expect(knownState()).toMatchObject({ knowledge: 'KNOWN', atoms: [] });
    expect(joined(knownState(), unknownState('DYNAMIC_FIELD'))).toMatchObject({
      knowledge: 'UNKNOWN', unknownReasons: ['DYNAMIC_FIELD'],
    });
    expect(joined(unknownState('AMBIGUOUS_EDGE'), unknownState('UNMODELLED_SOURCE'))).toMatchObject({
      knowledge: 'UNKNOWN', unknownReasons: ['UNMODELLED_SOURCE', 'AMBIGUOUS_EDGE'],
    });
  });

  it('deduplicates atoms and applies exact versus conditional overwrite', () => {
    const left = knownState([atom('a'), atom('a')]);
    expect(left.atoms).toHaveLength(1);
    expect(overwritten(left, knownState(), true)).toMatchObject({ knowledge: 'KNOWN', atoms: [] });
    expect(overwritten(left, knownState(), false)).toMatchObject({
      knowledge: 'UNKNOWN', unknownReasons: ['DYNAMIC_FIELD'],
    });
  });

  it('caps atoms, sanitizer tokens and reports omitted payload', () => {
    const atoms = Array.from({ length: SCAN_LOCAL_LIMITS_V1.maxAtomsPerField + 2 }, (_, index) => atom(`s${index}`));
    const result = bounded(knownState(atoms));
    expect(result.omittedAtoms).toBe(2);
    expect(result.state).toMatchObject({ knowledge: 'UNKNOWN' });
    expect(result.state.atoms).toHaveLength(SCAN_LOCAL_LIMITS_V1.maxAtomsPerField);
    expect(result.state.unknownReasons).toContain('PAYLOAD_LIMIT');

    let state = knownState();
    for (let index = 0; index < SCAN_LOCAL_LIMITS_V1.maxSanitizerTokens + 3; index += 1) {
      state = sanitizeFieldState(state, { modelId: `m${index}`, sink: 'COMMAND', pathDigest: `p${index}` });
    }
    expect(state.sanitizedFor).toHaveLength(SCAN_LOCAL_LIMITS_V1.maxSanitizerTokens);
    expect(bounded(state).omittedTokens).toBe(3);
  });

  it('keeps sanitizer evidence only when every branch carries it', () => {
    const token = { modelId: 'm', sink: 'COMMAND', pathDigest: 'p' };
    const sanitized = sanitizeFieldState(knownState(), token);
    expect(joined(sanitized, knownState()).sanitizedFor).toEqual([]);
    expect(joined(sanitized, sanitizeFieldState(knownState(), token)).sanitizedFor).toHaveLength(1);
  });

  it('widens an invalid path to UNKNOWN and omits it at the bound', () => {
    const deep = {
      ...atom('deep'),
      field: Array.from({ length: SCAN_LOCAL_LIMITS_V1.maxPathDepth + 1 }, (_, index) => `s${index}`),
    };
    expect(knownState([deep])).toMatchObject({ knowledge: 'UNKNOWN', unknownReasons: ['PAYLOAD_LIMIT'], atoms: [deep] });
    const result = bounded(knownState([deep]));
    expect(result.omittedAtoms).toBe(1);
    expect(result.state).toMatchObject({ knowledge: 'UNKNOWN', atoms: [] });
    expect(result.state.unknownReasons).toContain('PAYLOAD_LIMIT');
  });

  it('counts invalid paths inside the atom cap without double counting', () => {
    const valid = Array.from({ length: SCAN_LOCAL_LIMITS_V1.maxAtomsPerField + 2 }, (_, index) => atom(`s${index}`));
    const deep = {
      ...atom('deep'),
      field: Array.from({ length: SCAN_LOCAL_LIMITS_V1.maxPathDepth + 1 }, (_, index) => `s${index}`),
    };
    const result = bounded(knownState([...valid, deep]));
    expect(result.omittedAtoms).toBe(3);
    expect(result.state.atoms).toHaveLength(SCAN_LOCAL_LIMITS_V1.maxAtomsPerField);
    expect(result.state.atoms.every(({ field }) => isValidFieldPath(field))).toBe(true);
  });

  it('refuses a bound without debiting past the cap or returning a partial state', () => {
    const { spent, charge } = ledger(2);
    const result = boundFieldState(knownState(Array.from({ length: 10 }, (_, index) => atom(`s${index}`))), charge);
    expect(result).toEqual({ status: 'BUDGET_EXHAUSTED', omittedLowerBound: 9 });
    expect('state' in result).toBe(false);
    expect(spent.units).toBe(2);
  });

  it('refuses a join or overwrite without debiting or producing a state', () => {
    const joinLedger = ledger(4);
    expect(joinFieldStates(knownState([atom('a')]), knownState([atom('b')]), joinLedger.charge))
      .toEqual({ status: 'BUDGET_EXHAUSTED', omittedLowerBound: 1 });
    expect(joinLedger.spent.units).toBe(0);

    const overwriteLedger = ledger(0);
    expect(overwriteFieldState(knownState([atom('a')]), knownState(), false, overwriteLedger.charge))
      .toEqual({ status: 'BUDGET_EXHAUSTED', omittedLowerBound: 1 });
    expect(overwriteLedger.spent.units).toBe(0);
  });

  it('performs no join work when the budget refuses the precharge', () => {
    const counted = { reads: 0 };
    const atoms = new Proxy([atom('b')], {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) counted.reads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const right = Object.freeze({
      knowledge: 'KNOWN' as const, atoms, unknownReasons: [] as readonly [],
      sanitizedFor: [] as readonly [], omittedSanitizers: 0,
    }) as unknown as FieldStateV1;
    // One merge pass and its sort fit in five units; the validation pass does not, so refusal must precede atom work.
    const { spent, charge } = ledger(5);
    const result = joinFieldStates(knownState([atom('a')]), right, charge);
    expect(result).toEqual({ status: 'BUDGET_EXHAUSTED', omittedLowerBound: 1 });
    expect('state' in result).toBe(false);
    expect(spent.units).toBe(0);
    expect(counted.reads).toBe(0);
  });

  it('returns a completed joined state when the charge is affordable', () => {
    const { spent, charge } = ledger(100);
    const state = joined(knownState([atom('a')]), knownState([atom('b')]), charge);
    expect(state).toMatchObject({ knowledge: 'KNOWN' });
    expect(state.atoms).toHaveLength(2);
    expect(spent.units).toBeGreaterThan(0);
    expect(joined(knownState([atom('a'), atom('b')]), knownState([atom('c')])))
      .toEqual(joined(knownState([atom('c')]), knownState([atom('a'), atom('b')])));
  });

  it('bounds path depth and UTF-8 segment bytes', () => {
    expect(isValidFieldPath(Array.from({ length: SCAN_LOCAL_LIMITS_V1.maxPathDepth }, (_, index) => `s${index}`))).toBe(true);
    expect(isValidFieldPath(Array.from({ length: SCAN_LOCAL_LIMITS_V1.maxPathDepth + 1 }, (_, index) => `s${index}`))).toBe(false);
    expect(isValidFieldPath(['😀'.repeat(64)])).toBe(true);
    expect(isValidFieldPath(['😀'.repeat(65)])).toBe(false);
  });

  it('rejects an overlong segment before encoding it', () => {
    const original = TextEncoder.prototype.encode;
    let encodedOverlong = 0;
    TextEncoder.prototype.encode = function (this: InstanceType<typeof TextEncoder>, input?: string) {
      if (typeof input === 'string' && input.length > SCAN_LOCAL_LIMITS_V1.maxSegmentBytes) encodedOverlong += 1;
      return original.call(this, input);
    };
    try {
      expect(isValidFieldPath(['x'.repeat(SCAN_LOCAL_LIMITS_V1.maxSegmentBytes + 1)])).toBe(false);
      expect(encodedOverlong).toBe(0);
      expect(isValidFieldPath(['x'.repeat(SCAN_LOCAL_LIMITS_V1.maxSegmentBytes)])).toBe(true);
    } finally {
      TextEncoder.prototype.encode = original;
    }
  });
});
