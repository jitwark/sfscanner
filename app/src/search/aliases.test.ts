import { describe, expect, it } from 'vitest';
import { ALIASES, expandQuery, expandQueryDetails } from './aliases';

describe('aliases', () => {
  it('has at least 50 alias definitions', () => {
    const keys = Object.keys(ALIASES);
    expect(keys.length).toBeGreaterThanOrEqual(50);
  });

  it('expands known terms in a query', () => {
    const result = expandQuery('email ai');
    expect(result).toContain('email');
    expect(result).toContain('gmail');
    expect(result).toContain('smtp');
    expect(result).toContain('ai');
    expect(result).toContain('openai');
    expect(result).toContain('gemini');
  });

  it('preserves quoted terms without alias expansion', () => {
    const result = expandQuery('"email" ai');
    expect(result).toContain('"email"');
    expect(result).toContain('openai');
  });

  it('provides expanded terms breakdown', () => {
    const details = expandQueryDetails('chat http');
    expect(details.expandedTerms.chat).toContain('slack');
    expect(details.expandedTerms.http).toContain('api');
  });

  it('handles empty or whitespace query', () => {
    expect(expandQuery('')).toBe('');
    expect(expandQuery('   ')).toBe('');
  });
});
