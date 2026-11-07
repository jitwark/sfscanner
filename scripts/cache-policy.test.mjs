import { describe, expect, it } from 'vitest';
import { classifyCachePath, cachePolicyForClass } from './lib/cache-policy.mjs';

describe('static hosting cache policy', () => {
  it.each([
    ['/library/', 'html'],
    ['/data/manifest.json', 'release-pointer'],
    ['/data/releases/data-2026-08-29/search-index.json', 'immutable-release-data'],
    ['/data/releases/data-2026-08-29/', 'mutable-metadata'],
    ['/data/releases/data-2026-08-29', 'mutable-metadata'],
    ['/data/releases/data-2026-08-29/%2E%2E/manifest.json', 'mutable-metadata'],
    ['/data/stats.json', 'mutable-metadata'],
    ['/_next/static/chunks/app-abc123.js', 'hashed-asset'],
    ['/privacy/', 'legal'],
    ['/takedown/', 'legal'],
  ])('classifies %s as %s', (path, expected) => {
    expect(classifyCachePath(path)).toBe(expected);
  });

  it('gives immutable releases and hashed assets a year-long immutable policy', () => {
    expect(cachePolicyForClass('immutable-release-data')).toBe('public,max-age=31536000,immutable');
    expect(cachePolicyForClass('hashed-asset')).toBe('public,max-age=31536000,immutable');
  });

  it('keeps HTML, pointers, and legal pages immediately revalidating', () => {
    for (const name of ['html', 'release-pointer', 'legal']) {
      expect(cachePolicyForClass(name)).toBe('public,max-age=0,must-revalidate');
    }
    expect(cachePolicyForClass('mutable-metadata')).toBe('public,max-age=300,must-revalidate');
  });
});
