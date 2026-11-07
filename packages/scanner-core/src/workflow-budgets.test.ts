import { describe, expect, it } from 'vitest';
import { exceedsNestingDepth, exceedsParameterBudget } from './workflow-budgets';

describe('scanner-core workflow budgets', () => {
  it('detects a nesting depth only when the configured depth is exceeded', () => {
    const value = { first: { second: 'leaf' } };

    expect(exceedsNestingDepth(value, 2)).toBe(false);
    expect(exceedsNestingDepth(value, 1)).toBe(true);
  });

  it('counts primitive leaves and ignores repeated object references', () => {
    const shared = { value: 'one' };
    const value = { first: shared, second: shared };

    expect(exceedsParameterBudget(value, { maxLeaves: 1 })).toBe(false);
    expect(exceedsParameterBudget({ a: 1, b: 2 }, { maxLeaves: 1 })).toBe(true);
  });
});
