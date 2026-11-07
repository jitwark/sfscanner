import { describe, expect, it } from 'vitest';
import { PRERENDER_DETAIL_LIMIT_DEFAULT, resolvePrerenderLimit } from './prerender-limit';

describe('resolvePrerenderLimit', () => {
  it('defaults when nothing is set', () => {
    expect(resolvePrerenderLimit({})).toBe(PRERENDER_DETAIL_LIMIT_DEFAULT);
  });

  it('honours an explicit limit', () => {
    expect(resolvePrerenderLimit({ PRERENDER_DETAIL_LIMIT: '40' })).toBe(40);
  });

  it('accepts the older variable name the site route also reads', () => {
    expect(resolvePrerenderLimit({ PRERENDER_LIMIT: '12' })).toBe(12);
  });

  it('prefers the specific variable when both are set', () => {
    expect(resolvePrerenderLimit({ PRERENDER_DETAIL_LIMIT: '7', PRERENDER_LIMIT: '99' })).toBe(7);
  });

  it('falls back rather than pre-rendering nothing or a negative number of pages', () => {
    for (const raw of ['', 'lots', '0', '-5']) {
      expect(resolvePrerenderLimit({ PRERENDER_DETAIL_LIMIT: raw }), raw).toBe(PRERENDER_DETAIL_LIMIT_DEFAULT);
    }
  });
});
