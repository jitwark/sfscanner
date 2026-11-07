import { describe, expect, it } from 'vitest';
import { foldLiteralExpression, MAX_FOLDED_LITERAL_CHARS } from './literal-url-fold';

describe('literal-only expression folding', () => {
  it('folds string concatenation and literal template substitutions', () => {
    expect(foldLiteralExpression("='https://api.example/' + 'v1'")).toBe('https://api.example/v1');
    expect(foldLiteralExpression("=`https://${'api.example'}${'/'}`")).toBe('https://api.example/');
    expect(foldLiteralExpression('="https://api.example/v1"')).toBe('https://api.example/v1');
    expect(foldLiteralExpression('=`https://api.example/\\`v1\\``')).toBe('https://api.example/`v1`');
  });

  it('decodes string and template escapes exactly once', () => {
    expect(foldLiteralExpression("='https://example.test/\\x41\\u0042'")).toBe('https://example.test/AB');
    expect(foldLiteralExpression('=`https://example.test/\\u0041`')).toBe('https://example.test/A');
    expect(foldLiteralExpression("='a\\b\\f\\v\\0'")).toBe('a\b\f\v\0');
  });

  it('refuses dynamic, malformed and oversized folds', () => {
    expect(foldLiteralExpression("='https://' + $json.host")).toBeUndefined();
    expect(foldLiteralExpression("='https://' + `x${$json.y}`")).toBeUndefined();
    expect(foldLiteralExpression("='https://api.example/' +")).toBeUndefined();
    expect(foldLiteralExpression(`='${'a'.repeat(MAX_FOLDED_LITERAL_CHARS + 1)}'`)).toBeUndefined();
  });
});
