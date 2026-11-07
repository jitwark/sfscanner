import { describe, expect, it } from 'vitest';
import { chargeGraphOperation, createGraphOperationBudget } from './budget';

describe('graph operation budgets', () => {
  it('charges inclusive maximum and records the first exhausted unit', () => {
    const initial = createGraphOperationBudget(2);
    const first = chargeGraphOperation(initial);
    const second = chargeGraphOperation(first.counter);
    const exhausted = chargeGraphOperation(second.counter);

    expect(first).toMatchObject({ ok: true, counter: { used: 1, maximum: 2 } });
    expect(second).toMatchObject({ ok: true, counter: { used: 2, maximum: 2 } });
    expect(exhausted).toMatchObject({ ok: false, counter: { used: 3, maximum: 2 } });
    expect(initial).toEqual({ maximum: 2, used: 0, omitted: 0, exhausted: false });
  });

  it('supports exact boundary vectors and rejects invalid charges', () => {
    expect(chargeGraphOperation(createGraphOperationBudget(0))).toMatchObject({
      ok: false,
      counter: { used: 1, maximum: 0 },
    });
    expect(chargeGraphOperation(createGraphOperationBudget(3), 3)).toMatchObject({
      ok: true,
      counter: { used: 3, maximum: 3 },
    });
    expect(() => createGraphOperationBudget(-1)).toThrow(TypeError);
    expect(() => chargeGraphOperation(createGraphOperationBudget(1), 0)).toThrow(TypeError);
  });
});
