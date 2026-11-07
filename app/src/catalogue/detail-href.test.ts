import { describe, expect, it } from 'vitest';
import { detailHref, interactiveHref } from './detail-href';

describe('detailHref', () => {
  it('uses the slug route for a page Next pre-rendered', () => {
    expect(detailHref({ id: 'id/one', slug: 'send-mail', isPrerendered: true })).toBe('/w/send-mail/');
  });

  it('uses the slug route for the long tail too, because those pages now exist', () => {
    // Until 2026-08-26 this sent 12,971 entries to `/w/view/?id=`, because only
    // 250 slugs had a page. `scripts/generate-lean-pages.tsx` writes one for
    // every entry, so routing readers past them would leave the pages reachable
    // by a crawler and not by anyone clicking.
    expect(detailHref({ id: 'id/one', slug: 'long-tail-workflow', isPrerendered: false }))
      .toBe('/w/long-tail-workflow/');
  });

  it('encodes a slug that would otherwise change the path', () => {
    expect(detailHref({ id: 'x', slug: 'a/b?c', isPrerendered: false })).toBe('/w/a%2Fb%3Fc/');
  });
});

describe('interactiveHref', () => {
  it('addresses the client shell by id, and encodes it', () => {
    expect(interactiveHref('id/one?x=1')).toBe('/w/view/?id=id%2Fone%3Fx%3D1');
  });

  it('carries related ids as a compact, encoded query parameter', () => {
    // The client shell has no cheap way to compute related workflows itself
    // (see `view-client.tsx`); this is how the build-time computation reaches
    // it without re-fetching the catalogue.
    expect(interactiveHref('main', ['r1', 'r2'])).toBe('/w/view/?id=main&related=r1,r2');
  });

  it('omits the related parameter entirely when there are none', () => {
    expect(interactiveHref('main', [])).toBe('/w/view/?id=main');
    expect(interactiveHref('main')).toBe('/w/view/?id=main');
  });

  it('never lets the current id appear in its own related list', () => {
    expect(interactiveHref('main', ['main', 'r1', 'main'])).toBe('/w/view/?id=main&related=r1');
  });

  it('encodes related ids that would otherwise change the query string', () => {
    expect(interactiveHref('main', ['a,b', 'c&d'])).toBe('/w/view/?id=main&related=a%2Cb,c%26d');
  });
});
