import { describe, expect, it } from 'vitest';
import {
  RIGHTS_STATUSES,
  assertKnownRightsStatus,
  isKnownRightsStatus,
  type EntryRights,
  type RightsStatus,
} from './rights';

describe('isKnownRightsStatus', () => {
  it('accepts every documented status', () => {
    for (const status of RIGHTS_STATUSES) {
      expect(isKnownRightsStatus(status)).toBe(true);
    }
  });

  it('rejects an unrecognized value, including the bare word "unknown"', () => {
    expect(isKnownRightsStatus('unknown')).toBe(false);
    expect(isKnownRightsStatus('')).toBe(false);
    expect(isKnownRightsStatus('Redistributable')).toBe(false); // case-sensitive
  });
});

describe('assertKnownRightsStatus', () => {
  it('does not throw for a known status', () => {
    for (const status of RIGHTS_STATUSES) {
      expect(() => assertKnownRightsStatus(status, 'entry-1')).not.toThrow();
    }
  });

  it('throws naming the offending record for an unrecognized value', () => {
    expect(() => assertKnownRightsStatus('unknown', 'entry-42')).toThrow(/entry-42/);
    expect(() => assertKnownRightsStatus('unknown', 'entry-42')).toThrow(/unknown/);
  });

  it('never treats an unrecognized value as "redistributable"', () => {
    // The failure mode this guards against is a silent default, so the
    // assertion is on the error text itself, not just on "it throws".
    expect(() => assertKnownRightsStatus('maybe', 'entry-7')).toThrow(
      /never a\s+silent default to "redistributable"/,
    );
  });

  it('narrows the type for a caller that catches nothing, via `asserts`', () => {
    const status: string = 'link_only';
    assertKnownRightsStatus(status, 'entry-9');
    // If this compiles, `status` is narrowed to RightsStatus below the assert.
    const narrowed: RightsStatus = status;
    expect(narrowed).toBe('link_only');
  });
});

describe('EntryRights shape', () => {
  it('accepts excluded as a first-class status alongside the other two', () => {
    const excluded: EntryRights = {
      status: 'excluded',
      licence: null,
      licenceUrl: null,
      reason: 'exclusion-registry: takedown-2026-08-27',
    };
    expect(excluded.status).toBe('excluded');
  });
});
