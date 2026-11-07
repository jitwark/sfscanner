import { describe, expect, it } from 'vitest';
import { chargeSourceBudget, createSourceBudgetCounter } from './source-budget';

describe('chargeSourceBudget', () => {
  it('accepts max-1 and max, then rejects max+1 without mutating prior state', () => {
    const initial = createSourceBudgetCounter(2);
    const one = chargeSourceBudget(initial);
    expect(one).toMatchObject({ ok: true, counter: { used: 1, maximum: 2 } });
    if (!one.ok) return;
    const two = chargeSourceBudget(one.counter);
    expect(two).toMatchObject({ ok: true, counter: { used: 2, maximum: 2 } });
    if (!two.ok) return;
    expect(chargeSourceBudget(two.counter)).toMatchObject({
      ok: false,
      counter: { used: 3, maximum: 2 },
    });
    expect(initial).toEqual({ used: 0, maximum: 2 });
  });

  it('exhausts a zero budget on the first charged unit', () => {
    expect(chargeSourceBudget(createSourceBudgetCounter(0))).toMatchObject({
      ok: false,
      counter: { used: 1, maximum: 0 },
    });
  });

  it('rejects unsafe counters and charges', () => {
    expect(() => createSourceBudgetCounter(-1)).toThrow(TypeError);
    expect(() => chargeSourceBudget({ used: 0, maximum: 1 }, 0)).toThrow(TypeError);
    expect(() => chargeSourceBudget({ used: Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }))
      .toThrow(TypeError);
  });

  it('returns deeply frozen data-only outcomes', () => {
    const result = chargeSourceBudget(createSourceBudgetCounter(1));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.counter)).toBe(true);
  });
});
