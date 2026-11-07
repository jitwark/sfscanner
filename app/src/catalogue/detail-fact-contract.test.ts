import { describe, expect, it } from 'vitest';
import {
  DETAIL_FACT_CONTRACT,
  DETAIL_FACT_CONTRACT_PRINCIPLES,
  DETAIL_FACT_FAMILIES,
  type DetailFactRow,
} from './detail-fact-contract';

const row = (key: string): DetailFactRow => {
  const found = DETAIL_FACT_CONTRACT.find((item) => item.key === key);
  if (!found) throw new Error(`Missing contract row: ${key}`);
  return found;
};

describe('workflow detail fact contract', () => {
  it('has unique stable keys and complete metadata for every row', () => {
    const keys = DETAIL_FACT_CONTRACT.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => /^entry\.|^detail\.|^preview\./u.test(key))).toBe(true);
    for (const item of DETAIL_FACT_CONTRACT) {
      expect(item.family).toBeTruthy();
      expect(item.source).toBeTruthy();
      expect(item.nullability).toBeTruthy();
      expect(item.authority).toBeTruthy();
      expect(item.rightsExposure).toBeTruthy();
      expect(item.freshness).toBeTruthy();
      expect(item.label).toBeTruthy();
      expect(item.fallback).toBeTruthy();
    }
  });

  it('covers every visible detail fact family and states the non-inference rules', () => {
    expect(new Set(DETAIL_FACT_CONTRACT.map((item) => item.family))).toEqual(new Set(DETAIL_FACT_FAMILIES));
    expect(DETAIL_FACT_CONTRACT_PRINCIPLES.join(' ')).toMatch(/provenance is never inferred/i);
    expect(DETAIL_FACT_CONTRACT_PRINCIPLES.join(' ')).toMatch(/unknown is not false or zero/i);
    expect(row('entry.source.author').fallback).toMatch(/unknown|infer/i);
    expect(row('entry.source.path').fallback).toMatch(/not published|infer/i);
    expect(row('entry.source.commit').fallback).toMatch(/not published|infer/i);
    expect(row('entry.rights.licence').fallback).toMatch(/unlicensed|infer/i);
    expect(row('entry.compatibility').fallback).toMatch(/unknown|versioned|execution/i);
  });

  it('keeps body availability and actions rights-aware and fail-closed', () => {
    const body = row('detail.workflow-body');
    const action = row('detail.primary-action');
    expect(body.nullability).toBe('optional');
    expect(body.fallback).toMatch(/link.only.*withhold|excluded.*no body/i);
    expect(action.source).toBe('policy');
    expect(action.authority).toBe('policy');
    expect(action.fallback).toMatch(/redistributable.*download|link.only.*source|excluded.*no action/i);
    expect(row('entry.rights.status').fallback).toMatch(/never.*redistributable/i);
    expect(row('detail.workflow-body').rightsExposure).toBe('public');
    expect(row('entry.source.path').rightsExposure).toBe('not_public');
  });

  it('is deeply immutable so the contract cannot drift at runtime', () => {
    expect(Object.isFrozen(DETAIL_FACT_CONTRACT)).toBe(true);
    expect(DETAIL_FACT_CONTRACT.every((item) => Object.isFrozen(item))).toBe(true);
    expect(Object.isFrozen(DETAIL_FACT_CONTRACT_PRINCIPLES)).toBe(true);
  });
});
