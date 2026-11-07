import { describe, expect, it } from 'vitest';
import { scopeRank, type SelectorScopeV1 } from './scoped-catalogue-schema';

const absent: SelectorScopeV1 = { kind: 'ABSENT' };
const exact: SelectorScopeV1 = { kind: 'EXACT', value: 'https://api.example.com' };
const anyReviewed: SelectorScopeV1 = { kind: 'ANY_REVIEWED' };

describe('scoped catalogue schema (Q02.R1)', () => {
  it('ranks EXACT above ABSENT above ANY_REVIEWED', () => {
    expect(scopeRank(exact)).toBe(2);
    expect(scopeRank(absent)).toBe(1);
    expect(scopeRank(anyReviewed)).toBe(0);
  });

  it('treats a known-absent selector as stronger than reviewed neutrality', () => {
    expect(scopeRank(absent)).toBeGreaterThan(scopeRank(anyReviewed));
    expect(scopeRank(exact)).toBeGreaterThan(scopeRank(absent));
  });

  it('reads EXACT scope values without mutating them', () => {
    const value: SelectorScopeV1 = { kind: 'EXACT', value: 'workflow' };
    expect(scopeRank(value)).toBe(2);
    expect(value).toEqual({ kind: 'EXACT', value: 'workflow' });
  });
});
