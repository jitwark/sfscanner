import { describe, expect, it } from 'vitest';
import * as legalContacts from './legal-contacts';
import {
  contactEmail,
  isPending,
  dmcaAgentIsPublished,
  isValidDmcaRegistrationDate,
  PENDING,
  publicRequestEmailUrl,
  type PendingOr,
} from './legal-contacts';

/**
 * Boundary coverage for the predicates every legal page leans on.
 * `takedown-copyright.test.tsx` covers the rendered consequence (no safe-
 * harbour claim while the agent block is unfilled) — this file covers the
 * pure logic those pages call.
 */

const FILLED_AGENT = {
  name: 'Jane Doe',
  address: '1 Example St, Springfield',
  phone: '+1-555-0100',
  email: 'dmca@example.com',
} as const;

const REGISTERED_AT = '2025-08-29';
const NOW = new Date('2026-08-29T00:00:00.000Z');

describe('isPending', () => {
  it('is true for the PENDING sentinel', () => {
    expect(isPending(PENDING)).toBe(true);
  });

  it('is false for any filled value', () => {
    expect(isPending('a filled value')).toBe(false);
  });
});

describe('published request channels', () => {
  it('uses the authorized public email channel for routine requests', () => {
    expect(contactEmail).toBe('voidsyntax01@gmail.com');
    expect(publicRequestEmailUrl).toBe('mailto:voidsyntax01@gmail.com?subject=SecureFlow%20takedown%20request');
    expect(isPending(contactEmail)).toBe(false);
  });
});

describe('removed jurisdiction field', () => {
  /**
   * A4b removed the export together with the identity gate's requirement: no
   * governing-law jurisdiction has been supplied, and the terms body asserts
   * none. A value — pending or filled — must not reappear as a field without
   * deliberately revisiting that decision and the production gate with it.
   */
  it('exports no jurisdiction field at all — the product asserts none', () => {
    expect(Object.keys(legalContacts)).not.toContain('jurisdiction');
  });
});

describe('dmcaAgentIsPublished', () => {
  it('is true only when every field of the agent is filled', () => {
    expect(dmcaAgentIsPublished(FILLED_AGENT, REGISTERED_AT, NOW)).toBe(true);
  });

  it.each(['name', 'address', 'phone', 'email'] as const)(
    'is false when %s alone is still PENDING',
    (field) => {
      const agent: Record<keyof typeof FILLED_AGENT, PendingOr<string>> = { ...FILLED_AGENT };
      agent[field] = PENDING;
      expect(dmcaAgentIsPublished(agent, REGISTERED_AT, NOW)).toBe(false);
    },
  );

  it('is false when the registration date is missing', () => {
    expect(dmcaAgentIsPublished(FILLED_AGENT, PENDING, NOW)).toBe(false);
  });

  it('is false when the registration is expired', () => {
    expect(dmcaAgentIsPublished(FILLED_AGENT, '2022-08-29', NOW)).toBe(false);
  });

  it('is false when the registration date is in the future', () => {
    expect(dmcaAgentIsPublished(FILLED_AGENT, '2027-08-29', NOW)).toBe(false);
  });

  it('is false when every field is still PENDING (the real, unfilled module state)', () => {
    expect(
      dmcaAgentIsPublished({ name: PENDING, address: PENDING, phone: PENDING, email: PENDING }),
    ).toBe(false);
  });

  it('defaults to the real dmcaAgent export, which is unfilled today', () => {
    expect(dmcaAgentIsPublished()).toBe(false);
  });
});

describe('isValidDmcaRegistrationDate', () => {
  it('rejects malformed and impossible ISO dates', () => {
    expect(isValidDmcaRegistrationDate('not-a-date', NOW)).toBe(false);
    expect(isValidDmcaRegistrationDate('2025-02-29', NOW)).toBe(false);
  });

  it('treats the exact three-year anniversary as expired', () => {
    expect(isValidDmcaRegistrationDate('2023-08-29', NOW)).toBe(false);
  });
});
