import { describe, expect, it } from 'vitest';
import { all, any, not } from './tri-state';

describe('tri-state logic', () => {
  it.each([
    [['TRUE', 'TRUE'], 'TRUE'], [['TRUE', 'UNKNOWN'], 'UNKNOWN'],
    [['FALSE', 'UNKNOWN'], 'FALSE'], [['UNKNOWN', 'UNKNOWN'], 'UNKNOWN'],
    [[], 'TRUE'],
  ] as const)('reduces ALL with strong Kleene semantics', (values, expected) => {
    expect(all(values)).toBe(expected);
  });

  it.each([
    [['FALSE', 'FALSE'], 'FALSE'], [['FALSE', 'UNKNOWN'], 'UNKNOWN'],
    [['TRUE', 'UNKNOWN'], 'TRUE'], [['UNKNOWN', 'UNKNOWN'], 'UNKNOWN'],
    [[], 'FALSE'],
  ] as const)('reduces ANY with strong Kleene semantics', (values, expected) => {
    expect(any(values)).toBe(expected);
  });

  it.each([['TRUE', 'FALSE'], ['FALSE', 'TRUE'], ['UNKNOWN', 'UNKNOWN']] as const)('negates %s to %s', (value, expected) => {
    expect(not(value)).toBe(expected);
  });
});
