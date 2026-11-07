import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SW-1 (audit 2026-08-25). `app/app/layout.tsx` renders
 *
 *   <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
 *
 * so the layout already owns the page container, its horizontal inset and its
 * vertical rhythm. Several route roots applied the same padding again inside
 * it. Padding on nested elements is additive: at 320px that made the inset 32px
 * per side — 64px of 320px, a fifth of the screen — on the exact breakpoint the
 * README claims support for, and put 64px of dead space above the first element
 * on every one of those pages.
 *
 * Two of them went further and rendered their own `<main>` inside the layout's,
 * which is a second `main` landmark and, for `/privacy/`, a second element with
 * `id="main"` — so the skip link could resolve to either.
 *
 * Reading source rather than rendering, because these are server components that
 * read the corpus at build time. `search-client.test.ts` uses the same technique
 * to keep the worker engine a lazy import.
 */

const ROUTES_DIR = join(import.meta.dirname, '..', '..', 'app');

function routePages(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) routePages(path, found);
    else if (name === 'page.tsx') found.push(path);
  }
  return found;
}

/** The className of the first element a page returns. */
function rootClassName(source: string): string {
  const match = source.match(/<(?:div|main|article|section)[^>]*className="([^"]*)"/);
  return match?.[1] ?? '';
}

const PAGE_PADDING = /\b(?:sm:|md:|lg:|xl:)?p[xy]-\d/;

describe('route containers', () => {
  const pages = routePages(ROUTES_DIR);

  it('finds the route pages it means to check', () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  it('leaves the page inset to the layout instead of doubling it', () => {
    const doubled = pages
      .filter((path) => PAGE_PADDING.test(rootClassName(readFileSync(path, 'utf8'))))
      .map((path) => path.slice(ROUTES_DIR.length + 1));

    expect(doubled, `route roots re-applying the layout's padding: ${doubled.join(', ')}`).toEqual([]);
  });

  it('renders no second main landmark inside the layout', () => {
    const nested = pages
      .filter((path) => /<main[\s>]/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(ROUTES_DIR.length + 1));

    expect(nested, `pages rendering their own <main>: ${nested.join(', ')}`).toEqual([]);
  });

  // The workflow detail body is a route root in every sense except its filename:
  // `w/[slug]/page.tsx` and `w/view/` both render it directly into the layout.
  it('leaves the page inset to the layout in the detail body too', () => {
    const source = readFileSync(join(import.meta.dirname, 'detail', 'detail-body.tsx'), 'utf8');
    expect(PAGE_PADDING.test(rootClassName(source))).toBe(false);
  });
});
