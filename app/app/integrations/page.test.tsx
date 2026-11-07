import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import IntegrationsIndexPage from './page';
import { MAX_STATIC_HUBS_PER_KIND } from '../../src/catalogue/hub-route';

// This project does not enable Vitest globals, so Testing Library's automatic
// per-test cleanup never registers and renders accumulate in one document.
afterEach(() => { cleanup(); vi.clearAllMocks(); });

/**
 * 40 qualifying integration hubs -- more than `MAX_STATIC_HUBS_PER_KIND`
 * (24), which is exactly the AUDIT-HUB-001 shape: the real index has 516
 * qualifying integrations, this page statically publishes only 24 of them.
 */
function makeIntegrationsIndex(count: number) {
  const integrations: Record<string, { slug: string; title: string; totalEntries: number; totalPages: number }> = {};
  for (let i = 0; i < count; i += 1) {
    const slug = `integration-${String(i).padStart(3, '0')}`;
    integrations[slug] = { slug, title: `Integration ${i}`, totalEntries: count - i, totalPages: 1 };
  }
  return { integrations, tags: {}, triggers: {}, security: {} };
}

vi.mock('../../src/catalogue/hub-index', () => ({ getHubIndex: () => makeIntegrationsIndex(40) }));
// A passthrough so the assertions below inspect exactly what the page hands
// to `pageJsonLd`, not `pageJsonLd`'s own schema.org transformation (which
// has its own tests in src/seo/json-ld.test.ts).
vi.mock('../../src/seo/json-ld', () => ({
  JsonLdScript: ({ data }: { data: { description?: string; items?: unknown[] } }) => (
    <script data-testid="jsonld">{JSON.stringify(data)}</script>
  ),
  pageJsonLd: (options: unknown) => options,
}));

describe('IntegrationsIndexPage', () => {
  it('does not claim to list every integration when only MAX_STATIC_HUBS_PER_KIND are published', () => {
    render(<IntegrationsIndexPage />);

    const heading = screen.getByRole('heading', { level: 1 });
    // The old copy said "All n8n Integrations" over a page that only ever
    // published 24 of 516 qualifying integrations.
    expect(heading.textContent).not.toMatch(/\ball\b/i);
    expect(heading.textContent).not.toMatch(/\bevery\b/i);

    const intro = document.querySelector('header p');
    expect(intro?.textContent).not.toMatch(/\bevery\b/i);
    // The stated limit is the real constant, not a second hardcoded 24 that
    // could drift from it.
    expect(intro?.textContent).toContain(String(MAX_STATIC_HUBS_PER_KIND));
    // And the true qualifying total, so the gap is stated rather than hidden.
    expect(intro?.textContent).toContain('40');

    // Exactly MAX_STATIC_HUBS_PER_KIND cards are actually rendered.
    expect(screen.getAllByRole('link', { name: /Integration \d+/ })).toHaveLength(MAX_STATIC_HUBS_PER_KIND);
  });

  it('keeps the JSON-LD description in step with the visible copy: no exhaustive machine-readable claim', () => {
    render(<IntegrationsIndexPage />);

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
