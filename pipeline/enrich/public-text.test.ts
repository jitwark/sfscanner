import { describe, expect, test } from 'vitest';
import { redactPublicText } from './public-text';

describe('redactPublicText', () => {
  test('redacts provider-shaped bearer placeholders and authenticated URLs', () => {
    const bearer = ['sk', 'your', 'key'].join('-');
    const authHeader = ['Authoriz', 'ation: Bearer'].join('');
    const authUrl = ['https://', 'user', ':', 'password', '@example.test'].join('');
    const input = `Use ${authHeader} ${bearer} or ${authUrl}.`;
    const output = redactPublicText(input);

    expect(output).toContain('[redacted] or [redacted].');
    expect(output).not.toContain('sk-your-key');
    expect(output).not.toContain('password@example');
  });
  test('redacts generic bearer literals and symbolic placeholders', () => {
    const input = [
      'Authorization: Bearer BRIGHT_DATA_API_KEY',
      'Use Bearer authorization for the service.',
      'Replace Bearer XXXXXXXXXXXXXX with your token.',
    ].join('\n');

    const output = redactPublicText(input);

    expect(output).not.toContain('Bearer BRIGHT_DATA_API_KEY');
    expect(output).not.toContain('Bearer authorization');
    expect(output).not.toContain('Bearer XXXXXXXXXXXXXX');
  });

  test('leaves ordinary workflow prose unchanged', () => {
    const input = 'Use a managed credential and connect the workflow to the service.';
    expect(redactPublicText(input)).toBe(input);
  });
});
