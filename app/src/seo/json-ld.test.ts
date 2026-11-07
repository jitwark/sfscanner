import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeEntry as makeFixtureEntry, type DeepPartial } from '../test-support/make-entry';
import { cleanObject, entryJsonLd, homeJsonLd, hubJsonLd, JsonLdScript, scannerJsonLd } from './json-ld';

function makeTestEntry(overrides: DeepPartial<Entry> = {}): Entry {
  return makeFixtureEntry({
    id: 'test-123',
    slug: 'test-workflow-slug-123',
    title: 'Test Workflow Title',
    structure: {
      nodeCount: 5,
      connectionCount: 4,
      nodeTypes: ['n8n-nodes-base.webhook', 'n8n-nodes-base.openAi'],
      integrations: ['openai'],
      trigger: 'Webhook',
      complexity: 'simple',
      hasCode: false,
      hasAI: true,
      hasWebhook: true,
    },
    tags: ['openai'],
    ...overrides,
  });
}

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.test'));

describe('redacted author provenance', () => {
  it('omits author entirely for a redacted name instead of claiming site authorship', () => {
    const payload = JSON.stringify(
      entryJsonLd(makeTestEntry({ source: { author: { name: '[email]' } } })),
    );
    expect(payload).not.toContain('"author"');
    expect(payload).not.toContain('Person');
    expect(payload).not.toContain('[email]');
  });

  it('omits author for a mixed name that still contains the marker', () => {
    const payload = JSON.stringify(
      entryJsonLd(makeTestEntry({ source: { author: { name: 'Alice <[email]>' } } })),
    );
    expect(payload).not.toContain('"author"');
  });

  it('keeps the verified Person for a non-redacted author', () => {
    const payload = JSON.stringify(
      entryJsonLd(makeTestEntry({ source: { author: { name: 'Alice Developer' } } })),
    );
    expect(payload).toContain('"author":{"@type":"Person","name":"Alice Developer"}');
  });
});

describe('no release origin configured', () => {
  it('omits every site URL and never serializes null', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    const entry = JSON.stringify(entryJsonLd(makeTestEntry()));
    const hub = JSON.stringify(hubJsonLd('integration', 'openai', [{ title: 'W', slug: 'w' }]));
    const home = JSON.stringify(homeJsonLd());

    for (const payload of [entry, hub, home]) {
      expect(payload).not.toContain('null');
      expect(payload).not.toContain('https://example.test');
    }
    // The facts survive without the URL: a hub still names its collection, the
    // home graph still names the site and its search action is simply absent.
    const graph = (JSON.parse(hub) as Record<string, unknown>)['@graph'] as Array<Record<string, unknown>>;
    expect(graph[0].name).toBe('Openai n8n Workflows');
    expect(graph[0]).not.toHaveProperty('url');
    const homeGraph = (JSON.parse(home) as Record<string, unknown>)['@graph'] as Array<Record<string, unknown>>;
    expect(homeGraph[0].name).toBe('n8n-secureflow');
    expect(homeGraph[0]).not.toHaveProperty('potentialAction');
  });
});

describe('JsonLdScript', () => {
  it('omits structured data in preview mode', () => {
    vi.stubEnv('NEXT_PUBLIC_BUILD_MODE', 'preview');
    expect(JsonLdScript({ data: { '@context': 'https://schema.org' } })).toBeNull();
  });
});

describe('cleanObject', () => {
  it('removes undefined values from object and nested arrays', () => {
    const dirty = {
      a: 1,
      b: undefined,
      c: {
        d: 'test',
        e: undefined,
      },
      f: [1, undefined, { g: 2, h: undefined }],
    };
    const cleaned = cleanObject(dirty);
    const jsonStr = JSON.stringify(cleaned);

    expect(jsonStr).not.toContain('undefined');
    expect(cleaned).toEqual({
      a: 1,
      c: { d: 'test' },
      f: [1, { g: 2 }],
    });
  });
});

describe('entryJsonLd', () => {
  it('emits SoftwareSourceCode and BreadcrumbList for an entry', () => {
    const entry = makeTestEntry();
    const ld = entryJsonLd(entry) as Record<string, unknown>;

    expect(ld['@context']).toBe('https://schema.org');
    const graph = ld['@graph'] as Array<Record<string, unknown>>;
    expect(graph).toHaveLength(2);

    const ssc = graph[0];
    expect(ssc['@type']).toBe('SoftwareSourceCode');
    expect(ssc.name).toBe('Test Workflow Title');
    expect(ssc.programmingLanguage).toBe('n8n workflow JSON');
    expect(ssc.isAccessibleForFree).toBe(true);

    const breadcrumb = graph[1];
    expect(breadcrumb['@type']).toBe('BreadcrumbList');
    const list = breadcrumb.itemListElement as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list[0].name).toBe('Home');

    expect(JSON.stringify(ld)).not.toContain('undefined');
  });
});

describe('hubJsonLd', () => {
  it('emits CollectionPage and ItemList of first 24 entries for hubs', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      title: `Workflow ${i + 1}`,
      slug: `workflow-${i + 1}`,
    }));

    const ld = hubJsonLd('integration', 'openai', items, 1) as Record<string, unknown>;
    expect(ld['@context']).toBe('https://schema.org');

    const graph = ld['@graph'] as Array<Record<string, unknown>>;
    const collection = graph[0];
    expect(collection['@type']).toBe('CollectionPage');
    expect(collection.name).toBe('Openai n8n Workflows');

    const itemList = graph[1];
    expect(itemList['@type']).toBe('ItemList');
    const elements = itemList.itemListElement as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(24);
    expect(elements[0].name).toBe('Workflow 1');

    expect(JSON.stringify(ld)).not.toContain('undefined');
  });

  it('does not emit structured-data links for entries that are not exported', () => {
    const ld = hubJsonLd('tag', 'simple', [
      { title: 'Exported', slug: 'exported', isIndexable: true },
      { title: 'View shell', slug: 'view-shell', isIndexable: false },
    ]) as Record<string, unknown>;
    const graph = ld['@graph'] as Array<Record<string, unknown>>;
    const elements = graph[1].itemListElement as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(1);
    expect(elements[0].url).toContain('/w/exported/');
  });
});

describe('scannerJsonLd', () => {
  it('emits WebApplication schema for /scanner', () => {
    const ld = scannerJsonLd() as Record<string, unknown>;

    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('WebApplication');
    expect(ld.name).toBe('n8n Workflow Security Scanner');
    expect(ld.applicationCategory).toBe('SecurityApplication');
    expect(ld.offers).toEqual({
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    });

    expect(JSON.stringify(ld)).not.toContain('undefined');
  });
});

describe('homeJsonLd', () => {
  it('emits WebSite with SearchAction and Organization for homepage', () => {
    const ld = homeJsonLd() as Record<string, unknown>;

    expect(ld['@context']).toBe('https://schema.org');
    const graph = ld['@graph'] as Array<Record<string, unknown>>;
    expect(graph).toHaveLength(2);

    const site = graph[0];
    expect(site['@type']).toBe('WebSite');
    expect(site.name).toBe('n8n-secureflow');
    expect((site.potentialAction as Record<string, unknown>)['@type']).toBe('SearchAction');

    const org = graph[1];
    expect(org['@type']).toBe('Organization');
    expect(org.name).toBe('n8n-secureflow');

    expect(JSON.stringify(ld)).not.toContain('undefined');
  });
});
