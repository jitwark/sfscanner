import { describe, expect, it } from 'vitest';
import { ALIASES, expandQuery } from './aliases.js';

describe('aliases', () => {
  it('defines at least 25 alias groups', () => {
    const keys = Object.keys(ALIASES);
    expect(keys.length).toBeGreaterThanOrEqual(25);
    expect(ALIASES.email).toBeDefined();
    expect(ALIASES.ai).toBeDefined();
    expect(ALIASES.db).toBeDefined();
    expect(ALIASES.chat).toBeDefined();
    expect(ALIASES.sheet).toBeDefined();
    expect(ALIASES.crm).toBeDefined();
  });

  it('expands unquoted query terms with aliases', () => {
    const expanded = expandQuery('email');
    expect(expanded).toContain('email');
    expect(expanded).toContain('gmail');
    expect(expanded).toContain('smtp');
    expect(expanded).toContain('sendgrid');
  });

  it('preserves quoted terms verbatim while expanding unquoted terms', () => {
    const expanded = expandQuery('"email marketing" email');
    expect(expanded.startsWith('"email marketing"')).toBe(true);
    expect(expanded).toContain('gmail');
  });

  it('deduplicates terms and handles multiple words', () => {
    const expanded = expandQuery('email gmail');
    const terms = expanded.split(' ');
    expect(terms.filter(t => t === 'gmail').length).toBe(1);
  });

  it('handles empty query', () => {
    expect(expandQuery('')).toBe('');
    expect(expandQuery('   ')).toBe('');
  });
});
