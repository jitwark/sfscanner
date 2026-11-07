export type TriState = 'TRUE' | 'FALSE' | 'UNKNOWN';

export function all(values: readonly TriState[]): TriState {
  if (values.some((value) => value === 'FALSE')) return 'FALSE';
  return values.some((value) => value === 'UNKNOWN') ? 'UNKNOWN' : 'TRUE';
}

export function any(values: readonly TriState[]): TriState {
  if (values.some((value) => value === 'TRUE')) return 'TRUE';
  return values.some((value) => value === 'UNKNOWN') ? 'UNKNOWN' : 'FALSE';
}

export function not(value: TriState): TriState {
  return value === 'TRUE' ? 'FALSE' : value === 'FALSE' ? 'TRUE' : 'UNKNOWN';
}
