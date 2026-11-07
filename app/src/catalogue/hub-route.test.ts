import { describe, expect, it } from 'vitest';
import { libraryTagHref } from './hub-route';

describe('hub routes', () => {
  it('targets the complete worker-backed library for tag discovery', () => {
    expect(libraryTagHref('Daily Digest')).toBe('/library/?tag=daily-digest');
    expect(libraryTagHref('unknown')).toBe('/library/?tag=unknown');
  });
});
