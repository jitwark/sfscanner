import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isIndexable, type Entry } from '@hub/contracts';
import { makeEntry as makeFixtureEntry, type DeepPartial } from '../test-support/make-entry';
import { entryMeta, hubMeta, truncateWordBoundary } from './page-meta';

// The origin is read at call time, so a per-test stub is the contract: a
// module-level constant would have captured the build's value instead.
beforeEach(() => vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.test'));
afterEach(() => vi.unstubAllEnvs());

function makeTestEntry(overrides: DeepPartial<Entry> = {}): Entry {
  return makeFixtureEntry({
    id: 'test-123',
    slug: 'test-workflow-slug-123',
    title: 'Test Workflow Title',
    structure: {
      nodeCount: 5,
      connectionCount: 4,
      nodeTypes: ['n8n-nodes-base.webhook', 'n8n-nodes-base.openAi'],
      integrations: ['openai', 'webhook'],
      trigger: 'Webhook',
      complexity: 'simple',
      hasCode: false,
      hasAI: true,
      hasWebhook: true,
    },
    tags: ['openai', 'webhook'],
    ...overrides,
  });
}

describe('truncateWordBoundary', () => {
  it('returns original string if length is within maxLen', () => {
    expect(truncateWordBoundary('Short title', 60)).toBe('Short title');
  });

  it('truncates at word boundary if string exceeds maxLen', () => {
    const longStr = 'This is a very long title that exceeds the sixty character limit for SEO metadata titles';
    const truncated = truncateWordBoundary(longStr, 60);
    expect(truncated.length).toBeLessThanOrEqual(60);
    expect(truncated).toBe('This is a very long title that exceeds the sixty character');
  });
});

describe('isIndexable', () => {
  it('returns true for valid redistributable canonical entry clearing all quality gate boundaries', () => {
    const entry = makeTestEntry();
    expect(isIndexable(entry)).toBe(true);
  });

  it('table-tests quality gate failure boundary', () => {
    // 1. Link-only entries are indexed. Describing a workflow and deep-linking
    //    to its source is not redistribution; the download stays rights-gated.
    expect(isIndexable(makeTestEntry({ rights: { status: 'link_only', reason: 'official' } }))).toBe(true);
    // 2. Non-canonical
    expect(
      isIndexable(
        makeTestEntry({
          dedup: { fingerprint: 'f', structuralHash: 's', canonical: false, duplicateOf: 'other', alsoFoundIn: [] },
        }),
      ),
    ).toBe(false);

    // 3. Fallback description
    expect(isIndexable(makeTestEntry({ descriptionSource: 'fallback' }))).toBe(false);

    // 4. nodeCount < 3
    expect(
      isIndexable(
        makeTestEntry({
          structure: {
            nodeCount: 2,
            connectionCount: 1,
            nodeTypes: [],
            integrations: ['openai'],
            trigger: 'Manual',
            complexity: 'simple',
            hasCode: false,
            hasAI: false,
            hasWebhook: false,
          },
        }),
      ),
    ).toBe(false);

    // 5. Zero integrations
    expect(
      isIndexable(
        makeTestEntry({
          structure: {
            nodeCount: 5,
            connectionCount: 4,
            nodeTypes: [],
            integrations: [],
            trigger: 'Manual',
            complexity: 'simple',
            hasCode: false,
            hasAI: false,
            hasWebhook: false,
          },
        }),
      ),
    ).toBe(false);
  });

  it('ignores a contradictory pre-computed indexable boolean', () => {
    const entry = makeTestEntry();
    (entry as unknown as Record<string, unknown>).indexable = false;
    expect(isIndexable(entry)).toBe(true);
  });
});

describe('entryMeta', () => {
  it('generates Metadata for redistributable canonical entry', () => {
    const entry = makeTestEntry({
      title: 'Automate Email Support with OpenAI RAG',
    });
    const meta = entryMeta(entry);

    expect(meta.title).toContain('Automate Email Support with OpenAI RAG');
    expect((meta.title as string).length).toBeLessThanOrEqual(60);
    expect(meta.robots).toEqual({ index: true, follow: true });
    expect(meta.alternates?.canonical).toBe('https://example.test/w/test-workflow-slug-123/');
    expect(meta.openGraph).toMatchObject({ type: 'article' });
  });

  it('AUDIT-SEO-001: never ends the title in a dangling separator, even when the composed title would overflow', () => {
    // Reproduces https://.../w/template-kaizencrypto-008905cb/, which used to
    // render as "{Template} kaizenCrypto · n8n workflow (Agent, Code) |" —
    // the naive 60-char word-boundary cut landed right after the brand
    // separator and truncateWordBoundary had no notion of segments.
    const entry = makeTestEntry({
      title: '{Template} kaizenCrypto',
      structure: {
        nodeCount: 17,
        connectionCount: 19,
        nodeTypes: [],
        integrations: ['agent', 'code'],
        trigger: 'Manual',
        complexity: 'complex',
        hasCode: true,
        hasAI: true,
        hasWebhook: false,
      },
    });
    const meta = entryMeta(entry);
    const title = String(meta.title);

    expect(title).toBe('{Template} kaizenCrypto · n8n workflow (Agent, Code)');
    expect(title.endsWith('|')).toBe(false);
    expect(title.length).toBeLessThanOrEqual(60);
  });

  it('AUDIT-SEO-001: composes complete segments rather than truncating a pre-joined string', () => {
    // "Create complete 20-song YouTube playlists with Suno API, Claude &
    // Telegram Bot" used to truncate to "...with Suno API," (trailing comma).
    const entry = makeTestEntry({
      title: 'Create complete 20-song YouTube playlists with Suno API',
      structure: {
        nodeCount: 10,
        connectionCount: 9,
        nodeTypes: [],
        integrations: ['claude', 'telegram-bot'],
        trigger: 'Webhook',
        complexity: 'complex',
        hasCode: false,
        hasAI: true,
        hasWebhook: true,
      },
    });
    const meta = entryMeta(entry);
    const title = String(meta.title);

    expect(title).toBe('Create complete 20-song YouTube playlists with Suno API');
    expect(/[,|·\-:/]$/.test(title)).toBe(false);
  });

  it('indexes a canonical official entry and points its canonical at our own page', () => {
    const entry = makeTestEntry({
      id: '9999',
      slug: 'official-template-9999',
      rights: { status: 'link_only', reason: 'official' },
      source: {
        kind: 'n8n_official',
        templateId: 9999,
        permalink: 'https://n8n.io/workflows/9999',
        fetchedAt: '2026-08-13T00:00:00Z',
      },
    });
    const meta = entryMeta(entry);

    // Our page is not a copy of n8n's: it carries a security grade, a derived
    // structure and a chart that n8n.io does not publish, so it is the canonical
    // URL for *this* analysis and points at itself. The workflow JSON stays at
    // n8n.io, which is what `rights.status: 'link_only'` governs.
    expect(meta.robots).toEqual({ index: true, follow: true });
    expect(meta.alternates?.canonical).toBe('https://example.test/w/official-template-9999/');
  });
});

describe('hubMeta', () => {
  it('does not pluralize the library collection into the invalid librarys path', () => {
    expect(hubMeta('library', 'library').alternates?.canonical).toBe('https://example.test/library/');
  });

  it('generates Metadata for integration hub page', () => {
    const meta = hubMeta('integration', 'openai', 1, 42);

    expect(meta.title).toBe('Openai n8n Workflows | n8n-secureflow');
    expect(meta.robots).toEqual({ index: true, follow: true });
    expect(meta.alternates?.canonical).toBe('https://example.test/integrations/openai/');
  });

  it('includes page suffix in title and canonical URL for page > 1', () => {
    const meta = hubMeta('tag', 'ai-agent', 3, 100);

    expect(meta.title).toBe('Ai Agent n8n Workflows (Page 3) | n8n-secureflow');
    expect(meta.alternates?.canonical).toBe('https://example.test/tags/ai-agent/3/');
  });
});

describe('no release origin configured', () => {
  it('omits every absolute URL when no release URL is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    const entry = entryMeta(makeTestEntry());

    expect(entry.alternates).toBeUndefined();
    expect(entry.openGraph).not.toHaveProperty('url');
    expect(entry.openGraph).not.toHaveProperty('images');
    expect(entry.twitter).not.toHaveProperty('images');
  });

  it('omits hub canonicals and OG images without an origin', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    const hub = hubMeta('integration', 'openai');

    expect(hub.alternates).toBeUndefined();
    expect(hub.openGraph).not.toHaveProperty('url');
    expect(hub.openGraph).not.toHaveProperty('images');
    expect(hub.twitter).not.toHaveProperty('images');
  });

  it('rejects a non-https or credentialed origin instead of emitting it', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://u:p@example.test');
    expect(entryMeta(makeTestEntry()).alternates).toBeUndefined();
  });
});

describe('preview build metadata', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses an explicit preview flag to make every page non-indexable', () => {
    vi.stubEnv('NEXT_PUBLIC_BUILD_MODE', 'preview');

    expect(entryMeta(makeTestEntry()).robots).toEqual({
      index: false,
      follow: false,
      noarchive: true,
      nosnippet: true,
    });
    expect(hubMeta('integration', 'openai').robots).toEqual({
      index: false,
      follow: false,
      noarchive: true,
      nosnippet: true,
    });
  });

  it('does not advertise the production origin from preview metadata', () => {
    vi.stubEnv('NEXT_PUBLIC_BUILD_MODE', 'preview');

    const entry = entryMeta(makeTestEntry());
    const hub = hubMeta('integration', 'openai');

    expect(entry.alternates).toBeUndefined();
    expect(entry.openGraph).not.toHaveProperty('url');
    expect(entry.openGraph).not.toHaveProperty('images');
    expect(hub.alternates).toBeUndefined();
    expect(hub.openGraph).not.toHaveProperty('url');
    expect(hub.openGraph).not.toHaveProperty('images');
  });

  it('keeps production metadata indexable unless preview is explicitly enabled', () => {
    vi.stubEnv('NEXT_PUBLIC_BUILD_MODE', 'production');
    expect(hubMeta('integration', 'openai').robots).toEqual({ index: true, follow: true });
  });
});
