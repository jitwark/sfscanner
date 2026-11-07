import fs from 'node:fs';

/**
 * The document around a statically rendered detail page, taken from the build
 * rather than restated.
 *
 * The chrome carries a content-hashed stylesheet name, three hashed font URLs
 * and the theme bootstrap. Hard-coding any of them means the long tail renders
 * unstyled the first time a chunk hash changes, on 12,923 pages at once, with
 * nothing failing. Reading `app/out/w/view/index.html` keeps one source: what
 * `next build` actually emitted.
 */
export type DocumentShell = { openHtml: string; head: string; openBody: string; closeBody: string };

export type PageParts = {
  title: string;
  description: string;
  canonical?: string;
  index: boolean;
  jsonLd: string;
  body: string;
  /** Preview exports must be hidden even if the page is otherwise indexable. */
  preview?: boolean;
  /** Shared no-hydration behaviour asset, loaded after the page controls. */
  behaviorScriptUrl?: string;
};

/**
 * Escapes exactly what React escapes, apostrophe included.
 *
 * `&#x27;` is not required inside a double-quoted attribute, but matching React
 * keeps the two tiers producing the same bytes for the same string — and one
 * consumer already depends on it: `app/qa/check-seo.mjs` reads attributes with
 * `content=["']([^"']*)["']`, which stops at a literal apostrophe and reported
 * a 145-character description as 37.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Add the deployment's base path to any internal href that still lacks it.
 *
 * GitHub Pages serves the site from a repository subpath and `deploy.yml` sets
 * `NEXT_PUBLIC_BASE_PATH`. Inside the Next build `next/link` applies it; here
 * there is no Next runtime, so a component that renders a `<Link>` — the
 * breadcrumbs do — emits `/integrations/` where `/repo/integrations/` was
 * needed. Every local check passes and every link 404s on the deployment.
 *
 * A choke point rather than a rule each component must remember, because this
 * writes 12,971 pages and the failure is invisible until it is public. Already
 * prefixed hrefs are left alone, so components that call `sitePath` themselves
 * are not double-prefixed.
 */
export function withBasePath(markup: string, basePath: string): string {
  const trimmed = basePath.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return markup;
  const base = `/${trimmed}`;
  return markup.replace(/href="(\/[^"]*)"/g, (whole, href: string) => (
    href === base || href.startsWith(`${base}/`) ? whole : `href="${base}${href === '/' ? '/' : href}"`
  ));
}

/** Split a built page into the parts that wrap a detail body. */
export function shellFromHtml(html: string): DocumentShell {
  const headStart = html.indexOf('<head>');
  const headEnd = html.indexOf('</head>');
  const mainStart = html.indexOf('<main');
  const mainEnd = html.indexOf('</main>');
  if (headStart === -1 || headEnd === -1) throw new Error('Shell source has no <head>.');
  if (mainStart === -1 || mainEnd === -1) {
    throw new Error('Shell source has no <main> landmark; cannot place page content.');
  }

  // Every Next chunk goes. The runtime hydrates from `self.__next_f`, which a
  // statically rendered page does not have, so leaving them in boots React
  // against markup it did not produce. The theme bootstrap is inline and stays.
  const head = html.slice(headStart + '<head>'.length, headEnd)
    .replace(/<script\s[^>]*src="[^"]*"[^>]*><\/script>/g, '')
    .replace(/<link\b[^>]*\bas="script"[^>]*>/g, '');

  if (!/<link rel="stylesheet"/.test(head)) {
    throw new Error('Shell source has no stylesheet link; refusing to write unstyled pages.');
  }

  // `next/font` self-hosts each face and exposes it through a CSS variable set
  // by a hashed class on <html>. A bare `<html lang="en">` leaves --font-inter,
  // --font-outfit and --font-jetbrains-mono undefined and every page falls back
  // to the system UI font, silently, which is the exact defect
  // `app/app/layout.tsx` was written to fix.
  const htmlStart = html.indexOf('<html');
  if (htmlStart === -1) throw new Error('Shell source has no <html> element.');

  const mainOpenEnd = html.indexOf('>', mainStart) + 1;
  return {
    openHtml: html.slice(htmlStart, html.indexOf('>', htmlStart) + 1),
    head,
    openBody: html.slice(html.indexOf('<body'), mainOpenEnd),
    closeBody: html.slice(mainEnd)
      .replace(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/g, ''),
  };
}

export function readShell(viewPagePath: string): DocumentShell {
  return shellFromHtml(fs.readFileSync(viewPagePath, 'utf8'));
}

/** Assemble one page. Replaces the shell's own title, description and robots. */
export function renderDocument(shell: DocumentShell, parts: PageParts): string {
  if (parts.jsonLd.includes('</script')) {
    throw new Error('JSON-LD contains a closing script tag; refusing to write it.');
  }

  const head = shell.head
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(parts.title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${escapeHtml(parts.description)}"/>`)
    .replace(
      /<meta name="robots"[^>]*>/,
      `<meta name="robots" content="${parts.preview
        ? 'noindex, nofollow, noarchive, nosnippet'
        : parts.index ? 'index, follow' : 'noindex, follow'}"/>`,
    );

  // The site header travels in the shell, and it carries a theme toggle that is
  // a client component. Nothing here hydrates, so without this the control is a
  // visibly dead button on every page this writes.
  const behaviour = parts.behaviorScriptUrl
    ? `<script defer src="${escapeHtml(parts.behaviorScriptUrl)}"></script>`
    : '';

  const publicMetadata = !parts.preview;
  // No release origin means no canonical: `absoluteSiteUrl` returns null and the
  // element is omitted rather than pointed at an invented host.
  const canonical = publicMetadata && parts.canonical
    ? `<link rel="canonical" href="${escapeHtml(parts.canonical)}"/>`
    : '';
  const jsonLd = publicMetadata ? `<script type="application/ld+json">${parts.jsonLd}</script>` : '';

  return `<!DOCTYPE html>${shell.openHtml}<head>${head}`
    + canonical
    + jsonLd
    + `</head>${shell.openBody}${parts.body}${shell.closeBody.replace('</body>', `${behaviour}</body>`)}`;
}
