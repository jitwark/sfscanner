import { describe, expect, it } from 'vitest';
import { evaluateDestinationAllowlist, type DestinationInventoryRecord } from './allowlist-policy';

function record(overrides: Partial<DestinationInventoryRecord> = {}): DestinationInventoryRecord {
  return Object.freeze({
    nodeIdentity: 'a'.repeat(64), parameterPath: '/url', scheme: 'HTTPS', hostname: 'example.com',
    authorityState: 'KNOWN', valueMode: 'LITERAL', evidence: 'OBSERVED',
    reason: 'NONE', omitted: 0, inventoryStatus: 'COMPLETE', ...overrides,
  });
}

describe('evaluateDestinationAllowlist', () => {
  it('disables compliance when the allowlist is absent or empty', () => {
    expect(evaluateDestinationAllowlist([record()]).status).toBe('DISABLED');
    expect(evaluateDestinationAllowlist([record()], []).status).toBe('DISABLED');
  });

  it('approves exact lowercase and IDNA-equivalent hosts only', () => {
    expect(evaluateDestinationAllowlist([record({ hostname: 'xn--mnich-kva.example' })], ['MÜNICH.EXAMPLE']).status).toBe('CLEAN');
    expect(evaluateDestinationAllowlist([record({ hostname: 'api.example.com.evil' })], ['example.com']).status).toBe('NON_COMPLIANT');
  });

  it('keeps unknown authority unknown rather than clean', () => {
    const result = evaluateDestinationAllowlist([record({ hostname: null, authorityState: 'UNKNOWN', valueMode: 'DYNAMIC' })], ['example.com']);
    expect(result.status).toBe('UNKNOWN');
    expect(result.decisions[0]).toMatchObject({ status: 'UNKNOWN' });
  });

  it('does not use scheme or network access for host compliance', () => {
    const result = evaluateDestinationAllowlist([record({ scheme: 'UNKNOWN', hostname: 'EXAMPLE.COM' })], ['example.com']);
    expect(result.status).toBe('CLEAN');
    expect(JSON.stringify(result)).not.toContain('fetch');
  });

  it('rejects unsafe allowlist entries explicitly', () => {
    expect(evaluateDestinationAllowlist([record()], ['https://example.com']).status).toBe('UNSAFE_INPUT');
  });
  it('rejects a null allowlist before reading its length', () => {
    expect(evaluateDestinationAllowlist([record()], null as never)).toMatchObject({ status: 'UNSAFE_INPUT', errors: [{ code: 'INVALID_ALLOWLIST' }] });
  });

  it('prioritizes a rejected destination over unknown inventory state', () => {
    const input = Object.freeze({ status: 'UNKNOWN', records: Object.freeze([record({ hostname: null, authorityState: 'UNKNOWN', valueMode: 'DYNAMIC' }), record({ hostname: 'blocked.example' })]), counters: Object.freeze({}), errors: Object.freeze([]) });
    expect(evaluateDestinationAllowlist(input as never, ['example.com']).status).toBe('NON_COMPLIANT');
  });
});
