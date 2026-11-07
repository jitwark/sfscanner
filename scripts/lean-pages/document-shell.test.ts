import { describe, expect, it } from 'vitest';
import { renderDocument, shellFromHtml, withBasePath } from './document-shell.js';

/** A trimmed copy of what `next build` writes for `/w/view/`. */
const BUILT_PAGE = `<!DOCTYPE html><html lang="en" class="inter_x__variable"><head>`
  + `<meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>`
  + `<link rel="preload" href="/_next/static/media/abc.woff2" as="font" crossorigin="" type="font/woff2"/>`
  + `<link rel="stylesheet" href="/_next/static/chunks/0fd3-2sf36xrr.css" data-precedence="next"/>`
  + `<link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/310.js"/>`
  + `<script src="/_next/static/chunks/19mx.js" async=""></script>`
  + `<title>Workflow view · n8n-secureflow</title>`
  + `<meta name="description" content="Community workflow catalogue."/>`
  + `<meta name="robots" content="noindex, nofollow"/>`
  + `<meta http-equiv="Content-Security-Policy" content="default-src 'self'"/>`
  + `<script>(function(){var theme='dark';})();</script>`
  + `</head><body class="flex min-h-screen flex-col bg-page">`
  + `<a href="#main" class="sr-only">Skip</a><header id="site-header">NAV</header>`
  + `<main id="main" class="mx-auto w-full max-w-7xl px-4"><p>old content</p></main>`
  + `<footer id="site-footer">FOOT</footer>`
  + `<script>self.__next_f.push([1,"flight"])</script>`
  + `</body></html>`;

const shell = () => shellFromHtml(BUILT_PAGE);

const doc = (over: Partial<Parameters<typeof renderDocument>[1]> = {}) =>
  renderDocument(shell(), {
    title: 'A workflow · n8n-secureflow',
    description: 'What the workflow does.',
    canonical: 'https://example.test/w/a-workflow/',
    index: true,
    jsonLd: '{"@type":"Article"}',
    body: '<article><h1>A workflow</h1></article>',
    ...over,
  });

describe('shellFromHtml', () => {
  it('reuses the built stylesheet rather than naming one', () => {
    expect(shell().head).toContain('/_next/static/chunks/0fd3-2sf36xrr.css');
  });

  it('keeps the font preloads, the CSP, and the theme bootstrap', () => {
    const { head } = shell();
    expect(head).toContain('abc.woff2');
    expect(head).toContain('Content-Security-Policy');
    expect(head).toContain("var theme='dark'");
  });

  it('drops every Next chunk, because nothing on this page hydrates', () => {
    // The runtime hydrates from `self.__next_f`, which a statically rendered
    // page does not have. Left in, the scripts boot React against markup it did
    // not produce.
    const { head, closeBody } = shell();
    expect(head).not.toContain('/_next/static/chunks/19mx.js');
    expect(head).not.toContain('as="script"');
    expect(closeBody).not.toContain('__next_f');
  });

  it('keeps the header, the footer, and the skip link', () => {
    const { openBody, closeBody } = shell();
    expect(openBody).toContain('site-header');
    expect(openBody).toContain('href="#main"');
    expect(closeBody).toContain('site-footer');
  });

  it('carries the old page content into neither half', () => {
    const { openBody, closeBody } = shell();
    expect(`${openBody}${closeBody}`).not.toContain('old content');
  });

  it('refuses a build with no stylesheet rather than emitting 12,923 unstyled pages', () => {
    expect(() => shellFromHtml(BUILT_PAGE.replace(/<link rel="stylesheet"[^>]*>/, '')))
      .toThrow(/stylesheet/i);
  });

  it('refuses a build with no main landmark', () => {
    expect(() => shellFromHtml(BUILT_PAGE.replace(/<main[\s\S]*?<\/main>/, '<div>no landmark</div>')))
      .toThrow(/main/i);
  });
});

describe('renderDocument', () => {
  it('replaces the title and description rather than appending a second one', () => {
    const html = doc();
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('<title>A workflow · n8n-secureflow</title>');
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html).toContain('What the workflow does.');
  });

  it('replaces the shell page\'s noindex, which would have hidden every page it wrote', () => {
    expect(doc()).toContain('<meta name="robots" content="index, follow"/>');
    expect(doc()).not.toContain('noindex');
  });

  it('honours a page that should not be indexed', () => {
    expect(doc({ index: false })).toContain('content="noindex, follow"');
  });

  it('emits strict preview robots directives', () => {
    const html = doc({ preview: true });
    expect(html).toContain('content="noindex, nofollow, noarchive, nosnippet"');
    expect(html).not.toContain('content="index, follow"');
  });

  it('omits production URL metadata and structured data in preview', () => {
    const html = doc({ preview: true });
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('application/ld+json');
  });

  it('emits one canonical and one JSON-LD block', () => {
    const html = doc();
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain('href="https://example.test/w/a-workflow/"');
    expect(html.match(/application\/ld\+json/g)).toHaveLength(1);
  });

  it('omits the canonical when no release origin resolved one', () => {
    const html = doc({ canonical: undefined });
    expect(html).not.toContain('rel="canonical"');
    // Structured data stays: its URL-bearing fields are already conditional.
    expect(html.match(/application\/ld\+json/g)).toHaveLength(1);
  });

  it('puts the body inside the main landmark', () => {
    expect(doc()).toMatch(/<main[^>]*id="main"[^>]*><article><h1>A workflow<\/h1><\/article><\/main>/);
  });

  it('escapes a title and description that came from a crawled workflow', () => {
    const html = doc({ title: 'A <script>x</script> "workflow"', description: 'x & y <b>' });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('x &amp; y');
  });

  it('refuses JSON-LD that would break out of its script element', () => {
    expect(() => doc({ jsonLd: '{"a":"</script><script>alert(1)</script>"}' })).toThrow(/json-ld/i);
  });
});

describe('attribute escaping', () => {
  it('escapes an apostrophe the way React does', () => {
    // Not required inside a double-quoted attribute, but `app/qa/check-seo.mjs`
    // reads attributes with a regex that stops at one, and measured a
    // 145-character description as 37 characters on six pages.
    const html = doc({ description: "This workflow builds a children's tale." });

    expect(html).toContain('&#x27;');
    expect(html).not.toMatch(/content="[^"]*children's/);
  });
});

describe('the html element', () => {
  it('keeps the class next/font puts there', () => {
    // `next/font` self-hosts each face and exposes it as a CSS variable through
    // a class on <html>. Emitting a bare <html lang="en"> leaves --font-inter,
    // --font-outfit and --font-jetbrains-mono undefined, so every page falls
    // back to the system UI font with nothing failing — which is the defect
    // `app/app/layout.tsx` was written to fix, arriving from the other side.
    expect(shell().openHtml).toContain('inter_x__variable');
    expect(doc()).toContain('<html lang="en" class="inter_x__variable">');
  });

  it('does not emit two html tags', () => {
    expect(doc().match(/<html/g)).toHaveLength(1);
  });
});

describe('page behaviour asset', () => {
  it('loads shared behaviour after the controls and before </body>', () => {
    const html = doc({ behaviorScriptUrl: '/lean-page-behavior-abc123.js' });

    expect(html).toContain('<script defer src="/lean-page-behavior-abc123.js"></script></body>');
    expect(html).not.toContain('<script>window.__x=1;</script>');
  });

  it('escapes the behavior asset URL', () => {
    const html = doc({ behaviorScriptUrl: '/assets/a&b.js' });

    expect(html).toContain('src="/assets/a&amp;b.js"');
  });

  it('emits no behavior script when the page has no shared asset', () => {
    expect(doc()).not.toContain('<script defer src=');
  });
});

describe('withBasePath', () => {
  it('prefixes an internal href that next/link would have handled', () => {
    expect(withBasePath('<a href="/integrations/">x</a>', '/community-hub'))
      .toBe('<a href="/community-hub/integrations/">x</a>');
  });

  it('leaves an already-prefixed href alone, so sitePath callers are not doubled', () => {
    expect(withBasePath('<a href="/community-hub/w/x/">x</a>', '/community-hub'))
      .toBe('<a href="/community-hub/w/x/">x</a>');
  });

  it('does not touch external or fragment links', () => {
    const markup = '<a href="https://n8n.io/x">a</a><a href="#main">b</a><a href="mailto:x@y.z">c</a>';
    expect(withBasePath(markup, '/community-hub')).toBe(markup);
  });

  it('handles the root link the header uses', () => {
    expect(withBasePath('<a href="/">home</a>', '/community-hub'))
      .toBe('<a href="/community-hub/">home</a>');
  });

  it('is a no-op when the site is served from the domain root', () => {
    expect(withBasePath('<a href="/w/x/">x</a>', '')).toBe('<a href="/w/x/">x</a>');
  });

  it('is a no-op for a root base path, which would otherwise build protocol-relative URLs', () => {
    // `'/'` trims to the empty string. Prefixing it as-is produced `href="//w/x/"`,
    // which browsers read as host `w` on the current scheme, so every link left
    // the site and the deployment's e2e run failed on the first navigation.
    expect(withBasePath('<a href="/w/x/">x</a>', '/')).toBe('<a href="/w/x/">x</a>');
    expect(withBasePath('<a href="/w/x/">x</a>', '///')).toBe('<a href="/w/x/">x</a>');
  });

  it('tolerates a base path written with or without slashes', () => {
    for (const base of ['community-hub', '/community-hub', '/community-hub/']) {
      expect(withBasePath('<a href="/w/x/">x</a>', base)).toBe('<a href="/community-hub/w/x/">x</a>');
    }
  });
});
