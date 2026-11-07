import { describe, expect, it } from 'vitest';
import { makeEntry } from '../__fixtures__/make-entry.js';
import {
  PRIVATE_ENDPOINT_LABEL,
  isPrivateEndpointHost,
  redactEmailAddresses,
  sanitizeEntryForPublication,
} from './publication.js';

const descriptionContent = {
  headline: 'A workflow',
  summary: 'Contact dev@another-company.io for access.',
  outcome: 'Syncs data',
  beforeAfter: { before: 'manual', after: 'automatic' },
  exampleScenario: 'Mail ops@acme-corp.com when done.',
  howItWorks: ['Reads the sheet'],
  limitations: ['No retries'],
  audience: 'Ops teams',
};

function mixedEntry() {
  return {
    ...makeEntry({
      id: 'mixed',
      description: 'Questions? Write to ops@acme-corp.com or use you@example.com.',
      summary: 'Owned by dev@another-company.io.',
      descriptionContent,
      source: { author: { name: 'Alice <alice@author-domain.dev>', username: 'alice' } },
      rights: { status: 'link_only', licence: null, licenceUrl: null },
    }),
    hostnames: { literal: ['api.public.test', '10.0.0.5', 'printer.corp'], dynamic: [{ host: '192.168.1.20' }], undeterminable: 1 },
  };
}

describe('redactEmailAddresses', () => {
  it('redacts real addresses while leaving documented placeholders and filenames alone', () => {
    expect(redactEmailAddresses('mail ops@acme-corp.com')).toBe('mail [email]');
    expect(redactEmailAddresses('mail you@example.com')).toBe('mail you@example.com');
    expect(redactEmailAddresses('see report@invoice.pdf')).toBe('see report@invoice.pdf');
  });
});

describe('sanitizeEntryForPublication', () => {
  it('redacts reader-visible emails but preserves author, licence and source facts', () => {
    const input = mixedEntry();
    const sanitized = sanitizeEntryForPublication(input);

    expect(sanitized.description).toBe('Questions? Write to [email] or use you@example.com.');
    expect(sanitized.summary).toBe('Owned by [email].');
    expect(sanitized.descriptionContent?.exampleScenario).toBe('Mail [email] when done.');
    expect(sanitized.descriptionContent?.summary).toBe('Contact [email] for access.');
    expect(sanitized.source.author?.name).toBe('Alice <[email]>');
    expect(sanitized.source.author?.url).toBe(input.source.author?.url);
    expect(sanitized.rights).toEqual(input.rights);
    expect(sanitized.title).toBe(input.title);
  });

  it('withholds private endpoints behind distinct neutral labels without mutating the input', () => {
    const input = mixedEntry();
    const sanitized = sanitizeEntryForPublication(input);

    expect(sanitized.hostnames?.literal).toEqual(['api.public.test', PRIVATE_ENDPOINT_LABEL, '[private endpoint 2]']);
    expect(sanitized.hostnames?.dynamic[0]?.host).toMatch(/^\[private endpoint(?: \d+)?\]$/);
    expect(isPrivateEndpointHost('10.0.0.5')).toBe(true);
    expect(isPrivateEndpointHost('n8n.internal')).toBe(true);
    expect(isPrivateEndpointHost('api.public.test')).toBe(false);

    // The acquired record is still available to private diagnostics.
    expect(input.description).toContain('ops@acme-corp.com');
    expect(input.hostnames.literal).toEqual(['api.public.test', '10.0.0.5', 'printer.corp']);
  });

  it('redacts an email-only author name to the marker and keeps public names untouched', () => {
    const emailOnly = {
      ...makeEntry({
        id: 'email-only',
        source: { author: { name: 'ops@acme-corp.com', username: 'ops' } },
      }),
    };
    const publicName = makeEntry({ id: 'public', source: { author: { name: 'Alice Developer' } } });

    expect(sanitizeEntryForPublication(emailOnly).source.author?.name).toBe('[email]');
    expect(sanitizeEntryForPublication(publicName).source.author?.name).toBe('Alice Developer');
    expect(sanitizeEntryForPublication(publicName)).toBe(publicName);
  });

  it('is idempotent, so a re-derivation over sanitized entries changes nothing', () => {
    const once = sanitizeEntryForPublication(mixedEntry());
    expect(sanitizeEntryForPublication(once)).toBe(once);
  });
});
