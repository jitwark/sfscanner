import { describe, expect, it } from 'vitest';
import { createUrlRedactionCandidates } from './url-patches';

describe('URL structural redaction candidates', () => {
  it('classifies userinfo, path segments, and query values without touching delimiters', () => {
    const value = 'https://user:sk_live_12345678@example.test/sk_live_12345678?apiKey=sk_live_12345678&safe=yes#fragment';
    const candidates = createUrlRedactionCandidates(value);
    expect(candidates.map(({ start, end, kind }) => ({ value: value.slice(start, end), kind }))).toEqual([
      { value: 'sk_live_12345678', kind: 'URL_USERINFO' },
      { value: 'sk_live_12345678', kind: 'URL_PATH_SEGMENT' },
      { value: 'sk_live_12345678', kind: 'URL_QUERY_VALUE' },
    ]);
  });

  it('handles single-token userinfo and percent-encoded token paths', () => {
    const value = 'https://sk_live_12345678@example.test/sk%5Flive_12345678';
    const candidates = createUrlRedactionCandidates(value);
    expect(candidates.map(({ start, end, kind }) => ({ value: value.slice(start, end), kind }))).toEqual([
      { value: 'sk_live_12345678', kind: 'URL_USERINFO' },
      { value: 'sk%5Flive_12345678', kind: 'URL_PATH_SEGMENT' },
    ]);
  });

  it('falls back to scalar token spans for malformed URLs and never invents components', () => {
    const value = 'not a url sk_live_12345678';
    expect(createUrlRedactionCandidates(value).map(({ start, end, kind }) => ({ value: value.slice(start, end), kind }))).toEqual([
      { value: 'sk_live_12345678', kind: 'SCALAR' },
    ]);
  });
});
