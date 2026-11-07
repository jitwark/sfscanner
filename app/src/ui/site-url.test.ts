import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeBasePath, sitePath } from './site-url.mjs';

describe('normalizeBasePath', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['///', ''],
    ['/community-hub', '/community-hub'],
    ['community-hub', '/community-hub'],
    ['/community-hub/', '/community-hub'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });
});

describe('sitePath', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps root deployment paths unchanged', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
    expect(sitePath('/library/')).toBe('/library/');
  });

  it('treats a slash-only base path as a root deployment', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/');
    expect(sitePath('/library/')).toBe('/library/');
    expect(sitePath('data/search-index.json')).toBe('/data/search-index.json');
  });

  it('prefixes internal paths for a repository subpath deployment', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/community-hub');
    expect(sitePath('/library/?q=slack')).toBe('/community-hub/library/?q=slack');
    expect(sitePath('data/search-index.json')).toBe('/community-hub/data/search-index.json');
  });
});
