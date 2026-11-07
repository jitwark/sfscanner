import { describe, expect, it } from 'vitest';
import { footerLabel, generateSvg } from './generate-og-images.mjs';

/**
 * Asserts the SVG text `sharp` rasterises, never PNG pixels: the parity gate
 * walks html/xml/txt and cannot see inside a PNG, so a rendered-image claim
 * would be untested.
 */
describe('OG image identity', () => {
  it('bakes the configured https origin and no other host into every SVG', () => {
    const previous = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://example.test';
    try {
      for (const integration of ['generic', 'openai']) {
        for (const grade of ['LOW', 'CRITICAL']) {
          const svg = generateSvg(integration, grade);
          expect(svg).toContain('https://example.test');
          expect(svg).not.toContain('n8n-community.com');
        }
      }
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = previous;
    }
  });

  it('falls back to the site name and no absolute origin when unset', () => {
    const previous = process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    try {
      for (const grade of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) {
        const svg = generateSvg('generic', grade);
        expect(svg).toContain('n8n-secureflow');
        // The SVG namespace is the only remaining URL; no origin is fabricated.
        expect(svg).not.toMatch(/https:\/\//);
        expect(svg).not.toContain('n8n-community.com');
      }
    } finally {
      if (previous !== undefined) process.env.NEXT_PUBLIC_SITE_URL = previous;
    }
  });

  it('rejects a credentialed or plain-http origin instead of publishing it', () => {
    expect(footerLabel('http://example.test')).toBe('n8n-secureflow');
    expect(footerLabel('https://u:p@example.test')).toBe('n8n-secureflow');
    expect(footerLabel('https://example.test/?a=1')).toBe('n8n-secureflow');
    expect(footerLabel('https://example.test/')).toBe('https://example.test');
  });
});
