import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TagsIndexPage from './page';
import { MAX_STATIC_HUBS_PER_KIND } from '../../src/catalogue/hub-route';

// This project does not enable Vitest globals, so Testing Library's automatic
// per-test cleanup never registers and renders accumulate in one document.
afterEach(() => { cleanup(); vi.clearAllMocks(); });

/**
 * 50 qualifying tag hubs -- more than `MAX_STATIC_HUBS_PER_KIND` (24), the
 * AUDIT-HUB-001 shape: the real index has 111 qualifying tags, this page
 * statically publishes only 24 of them.
 */
function makeTagsIndex(count: number) {
  const tags: Record<string, { slug: string; title: string; totalEntries: number; totalPages: number }> = {};
  for (let i = 0; i < count; i += 1) {
    const slug = `tag-${String(i).padStart(3, '0')}`;
    tags[slug] = { slug, title: `Tag ${i}`, totalEntries: count - i, totalPages: 1 };
  }
  return { integrations: {}, tags, triggers: {}, security: {} };
}

vi.mock('../../src/catalogue/hub-index', () => ({ getHubIndex: () => makeTagsIndex(50) }));
// A passthrough so the assertions below inspect exactly what the page hands
// to `pageJsonLd`, not `pageJsonLd`'s own schema.org transformation (which
// has its own tests in src/seo/json-ld.test.ts).
vi.mock('../../src/seo/json-ld', () => ({
  JsonLdScript: ({ data }: { data: { description?: string; items?: unknown[] } }) => (
    <script data-testid="jsonld">{JSON.stringify(data)}</script>
  ),
  pageJsonLd: (options: unknown) => options,
}));

describe('TagsIndexPage', () => {
  it('does not claim to list every tag when only MAX_STATIC_HUBS_PER_KIND are published', () => {
    render(<TagsIndexPage />);

    const heading = screen.getByRole('heading', { level: 1 });
    // The old copy said "All workflow tags" over a page that only ever
    // published 24 of 111 qualifying tags.
    expect(heading.textContent).not.toMatch(/\ball\b/i);
    expect(heading.textContent).not.toMatch(/\bevery\b/i);

    const intro = document.querySelector('header p');
    expect(intro?.textContent).not.toMatch(/\bevery\b/i);
    // The stated limit is the real constant, not a second hardcoded 24 that
    // could drift from it. It must not silently read as the true count
    // (hubs.length, capped at 24) the way the pre-fix copy did.
    expect(intro?.textContent).toContain(String(MAX_STATIC_HUBS_PER_KIND));
    // And the true qualifying total, so the gap is stated rather than hidden.
    expect(intro?.textContent).toContain('50');

    // Exactly MAX_STATIC_HUBS_PER_KIND cards are actually rendered.
    expect(screen.getAllByRole('link', { name: /Tag \d+/ })).toHaveLength(MAX_STATIC_HUBS_PER_KIND);
  });

  it('keeps the JSON-LD description in step with the visible copy: no exhaustive machine-readable claim', () => {
    render(<TagsIndexPage />);

    const script = screen.getByTestId('jsonld');
    const data = JSON.parse(script.textContent || '{}');
    expect(data.description).not.toMatch(/\bevery\b/i);
    expect(data.description).not.toMatch(/\ball\b/i);
    expect(data.description).toContain(String(MAX_STATIC_HUBS_PER_KIND));
    // The ItemList itself only ever carried the published slice -- that part
    // was already true and stays true.
    expect(data.items).toHaveLength(MAX_STATIC_HUBS_PER_KIND);
  });
});
