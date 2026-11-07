import { describe, expect, it } from 'vitest';
import { BUDGET_KEYS_V2, classifyBudgetOutcome, diagnosticCapacity } from '../workflow-v2/budget-outcomes';
import { chargeSourceBudget, createSourceBudgetCounter } from '../source/source-budget';
import { budgetCases } from './property-generators';

describe('scanner-core deterministic budget properties', () => {
  it('charges monotonically without mutating the prior counter', () => {
    for (const item of budgetCases(0x3001, 32)) {
      let current = createSourceBudgetCounter(item.maximum);
      for (let step = 0; step <= item.maximum + 1; step += 1) {
        const previous = current;
        const charged = chargeSourceBudget(current);
        expect(current).toEqual(previous);
        expect(charged.counter.used).toBe(previous.used + 1);
        expect(charged.counter.maximum).toBe(item.maximum);
        expect(charged.ok).toBe(charged.counter.used <= item.maximum);
        current = charged.counter;
        if (current.used > item.maximum) break;
      }
    }
  });

  it('keeps multi-unit charges immutable and closes at the inclusive maximum', () => {
    for (const item of budgetCases(0x3002, 32)) {
      const counter = createSourceBudgetCounter(item.maximum);
      const charged = chargeSourceBudget(counter, item.units);
      expect(counter.used).toBe(0);
      expect(charged.counter.used).toBe(item.units);
      expect(charged.ok).toBe(item.units <= item.maximum);
      if (item.units === item.maximum) {
        expect(charged.ok).toBe(true);
        const exhausted = chargeSourceBudget(charged.counter);
        expect(exhausted.ok).toBe(false);
        expect(exhausted.counter.used).toBe(item.maximum + 1);
      }
    }
  });

  it('reserves one diagnostic slot and classifies every known budget as closed', () => {
    for (const item of budgetCases(0x3003, 24)) {
      expect(diagnosticCapacity(item.maximum)).toBe(item.maximum - 1);
    }
    for (const budget of BUDGET_KEYS_V2) {
      const outcome = classifyBudgetOutcome({
        budget,
        capabilityRequired: true,
        securityRequired: true,
      });
      expect(['ITEM_ERROR', 'DIAGNOSTIC', 'REDACTION_ERROR', 'HOST_ERROR']).toContain(outcome.kind);
      expect(Object.isFrozen(outcome)).toBe(true);
      if (budget === 'maxDiagnostics') {
        expect(outcome).toMatchObject({
          kind: 'DIAGNOSTIC',
          aggregateEffect: 'INDETERMINATE',
          assessmentEligible: false,
          reservedDiagnosticSlots: 1,
        });
      }
    }
  });
});
