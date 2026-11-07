import { describe, expect, it } from 'vitest';
import { SCANNER_VERSION } from './scanner-version';
import { resolvePolicyProfile } from './policies/profile';

describe('scanner version identity', () => {
  it('uses one core-owned version for every policy profile', () => {
    expect(SCANNER_VERSION).toMatch(/^scanner-[a-z0-9-]+$/);
    expect(resolvePolicyProfile('beta-default')).toMatchObject({ version: SCANNER_VERSION });
    expect(resolvePolicyProfile('beta-hardened')).toMatchObject({ version: SCANNER_VERSION });
  });
});
