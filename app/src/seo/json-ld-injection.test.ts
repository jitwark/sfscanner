import { describe, expect, it } from 'vitest';
import { entryJsonLd, serializeJsonLd } from './json-ld';
import { makeEntry } from '../../../pipeline/__fixtures__/make-entry';

/**
 * Titles, summaries, and author names are copied verbatim out of repositories we
 * crawl. Anyone who can name a workflow in a crawled repository can therefore
 * choose bytes that land inside a <script type="application/ld+json"> element on
 * a page we publish. These tests pin the escaping that keeps such bytes inert.
 */

const BREAKOUT = 'Invoice sync</script><script>alert(1)</script>';

function readName(serialized: string): string {
  const parsed: unknown = JSON.parse(serialized);
  if (parsed && typeof parsed === 'object' && 'name' in parsed && typeof parsed.name === 'string') {
    return parsed.name;
  }
  throw new Error('serialized JSON-LD did not contain a string name');
}

describe('JSON-LD serialization', () => {
  it('neutralizes a script-closing title so it cannot terminate the element', () => {
    const serialized = serializeJsonLd({ name: BREAKOUT });

    expect(serialized).not.toContain('</script>');
    expect(serialized).not.toContain('<script>');
    expect(serialized).toContain('\\u003c/script\\u003e');
  });

  it('preserves the exact original string through a JSON round trip', () => {
    expect(readName(serializeJsonLd({ name: BREAKOUT }))).toBe(BREAKOUT);
  });

  it.each([
    ['angle brackets', '<img src=x onerror=alert(1)>'],
    ['svg event handler', '<svg onload=alert(1)>'],
    ['ampersand entity', '&lt;script&gt;'],
    ['line separator U+2028', 'a\u2028b'],
    ['paragraph separator U+2029', 'a\u2029b'],
  ])('escapes %s', (_label, hostile) => {
    const serialized = serializeJsonLd({ name: hostile });

    expect(serialized).not.toMatch(/[<>&\u2028\u2029]/);
    expect(readName(serialized)).toBe(hostile);
  });

  it('escapes hostile values reaching JSON-LD through a real entry', () => {
    const entry = makeEntry({
      title: BREAKOUT,
      summary: 'Ends the element: </script>',
      source: { author: { name: '</script><script>alert(document.cookie)</script>' } },
    });

    const serialized = serializeJsonLd(entryJsonLd(entry));

    expect(serialized).not.toContain('</script>');
    expect(serialized).toContain('\\u003c');
  });

  it('leaves ordinary titles readable rather than over-escaping', () => {
    expect(serializeJsonLd({ name: 'Sync Stripe payments to Google Sheets' })).toBe(
      '{"name":"Sync Stripe payments to Google Sheets"}',
    );
  });
});
