import { describe, expect, it } from 'vitest';
import { PROVIDER_TOKEN_PATTERNS } from '../provider-token-patterns';
import { redactText, redactWorkflowJson } from './redaction';

const SECRETS = ['session-token-value', 'pwd-value', 'pass-value',
  'verySecretPassword123', 'db-pass-9f2a', 'rk_live_12345678'];
const PAIRED_SECRETS = ['paired-value-plaintext', 'paired-val-plaintext',
  'paired-header-plaintext', 'paired-content-plaintext', 'spaced-paired-plaintext'];

describe('confirmed redaction gaps', () => {
  it('removes key, name/value, database-URI, and restricted-key plaintext', () => {
    const input = {
      session_token: 'session-token-value', pwd: 'pwd-value', pass: 'pass-value',
      settings: { name: 'password', value: 'verySecretPassword123' },
      database: 'postgres://user:db-pass-9f2a@db.internal:5432/app',
      stripe: 'rk_live_12345678',
    };
    const output = redactWorkflowJson(JSON.stringify(input));
    for (const secret of SECRETS) expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED]');
  });

  it('redacts restricted Stripe keys and preserves the near miss', () => {
    expect(redactText('rk_live_12345678')).toBe('[REDACTED]');
    expect(redactText('rk_live_1234567')).toBe('rk_live_1234567');
    expect(PROVIDER_TOKEN_PATTERNS.find((entry) => entry.kind === 'Stripe restricted key'))
      .toMatchObject({ surfaces: ['classify', 'redact'] });
  });

  it('redacts malformed non-HTTP userinfo and fragments without throwing', () => {
    // WHATWG URL rejects the `[bad` host, so the parser fallback must find the last `@`
    // inside the authority and keep the scheme plus the remaining host text.
    expect(redactText('postgres://user:db-pass-9f2a@[bad')).toBe('postgres://[REDACTED]@[bad');
    expect(redactText('postgres://user:db-pass-9f2a@[bad#fragment-secret'))
      .toBe('postgres://[REDACTED]@[bad#[REDACTED]');
    expect(redactText('broken://[host]?access_token=private-value&mode=test'))
      .toBe('broken://[host]?access_token=[REDACTED]&mode=test');
  });

  it('does not treat an @ outside the authority as userinfo', () => {
    expect(redactText('https://db.internal/files/user@example.com'))
      .toBe('https://db.internal/files/user@example.com');
    expect(redactText('https://db.internal/search?email=user@example.com'))
      .toBe('https://db.internal/search?email=user@example.com');
    expect(redactText('postgres://[bad/path@user')).toBe('postgres://[bad/path@user');
  });

  it('redacts every paired sensitive-name field and preserves unrelated records', () => {
    const output = redactWorkflowJson(JSON.stringify({
      headers: [
        { name: 'Authorization', value: 'paired-value-plaintext', val: 'paired-val-plaintext',
          headerValue: 'paired-header-plaintext', content: 'paired-content-plaintext' },
        { name: 'Authorization ', value: 'spaced-paired-plaintext' },
        { name: 'username', value: 'visible-user', val: 'visible-val',
          headerValue: 'visible-header', content: 'visible-content' },
        { name: 'X-Trace', content: 'visible-trace' },
      ],
    }));
    for (const secret of PAIRED_SECRETS) expect(output).not.toContain(secret);
    for (const visible of ['visible-user', 'visible-val', 'visible-header', 'visible-content', 'visible-trace']) {
      expect(output).toContain(visible);
    }
  });

  it('leaves non-secret lookalike keys and values intact', () => {
    const output = redactWorkflowJson(JSON.stringify({
      tokenBudget: 'visible-budget', tokenCount: 'visible-count',
      maxExpressionTokens: 'visible-max', passengerCount: 'visible-passengers',
      secretKind: 'visible-kind',
    }));
    for (const visible of ['visible-budget', 'visible-count', 'visible-max', 'visible-passengers', 'visible-kind']) {
      expect(output).toContain(visible);
    }
  });
});
