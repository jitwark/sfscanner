export type SourceBudgetCounterV2 = Readonly<{
  used: number;
  maximum: number;
}>;

export type SourceBudgetChargeV2 = Readonly<
  | { ok: true; counter: SourceBudgetCounterV2 }
  | { ok: false; counter: SourceBudgetCounterV2 }
>;

export function createSourceBudgetCounter(maximum: number): SourceBudgetCounterV2 {
  requireNonNegativeSafeInteger(maximum, 'maximum');
  return Object.freeze({ used: 0, maximum });
}

/**
 * Charge examined source work without mutating the caller's counter.
 * The declared maximum is inclusive; the first unit beyond it returns `ok: false`.
 */
export function chargeSourceBudget(
  current: SourceBudgetCounterV2,
  units = 1,
): SourceBudgetChargeV2 {
  requireNonNegativeSafeInteger(current.used, 'used');
  requireNonNegativeSafeInteger(current.maximum, 'maximum');
  if (current.used > current.maximum) throw new TypeError('used cannot exceed maximum');
  if (!Number.isSafeInteger(units) || units <= 0) throw new TypeError('units must be a positive safe integer');
  if (current.used > Number.MAX_SAFE_INTEGER - units) throw new TypeError('budget charge exceeds the safe integer range');

  const counter = Object.freeze({ used: current.used + units, maximum: current.maximum });
  return Object.freeze({ ok: counter.used <= counter.maximum, counter });
}

function requireNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}
